/**
 * Picking.
 *
 * A raycast that resolves to a surface and a cell on it, not just a point in
 * space. Every tool in the editor picks through here, so "what is under the
 * cursor" means the same thing to the sculpt brush, the tile brush and the
 * object placer.
 *
 * Objects are tested before terrain, per brief section 8, with a modifier to
 * reach through them.
 */

import * as THREE from 'three'

import { readAddress, type SurfaceAddress } from '@papercut/document'
import type { RuntimeScene } from './scene'

export interface PickResult {
  surface: SurfaceAddress | null
  point: THREE.Vector3 | null
  objectId: string | null
  distance: number
  /** The ray the pick was made along, so a handler can find where it crosses another height. */
  ray: { readonly origin: THREE.Vector3; readonly direction: THREE.Vector3 } | null
}

const EMPTY: PickResult = { surface: null, point: null, objectId: null, distance: Infinity, ray: null }

/** How far above the ceiling a hit may sit and still count as at it: the cap's own top, give or take float error. */
const CUT_EPSILON = 1e-4

const NOTHING: ReadonlySet<string> = new Set()

export class Picker {
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()

  /**
   * @param ndcX  -1..1
   * @param ndcY  -1..1
   * @param throughObjects  skip object hits, as with the reach-through modifier
   * @param lookPast  ids of structures and objects the ray passes through as if they were not there:
   *                  what a drag is carrying, so the pick answers what it would land on
   */
  pick(
    scene: RuntimeScene,
    camera: THREE.Camera,
    ndcX: number,
    ndcY: number,
    throughObjects = false,
    lookPast: ReadonlySet<string> = NOTHING,
  ): PickResult {
    this.pointer.set(ndcX, ndcY)
    this.raycaster.setFromCamera(this.pointer, camera)
    const ray = { origin: this.raycaster.ray.origin.clone(), direction: this.raycaster.ray.direction.clone() }

    let objectHit: PickResult | null = null
    if (!throughObjects) {
      const groups = scene.objectGroups().filter((group) => !lookPast.has(group.userData.objectId as string))
      const hits = this.raycaster.intersectObjects(groups, true)
      const hit = hits[0]
      if (hit) {
        let node: THREE.Object3D | null = hit.object
        while (node && node.userData.objectId === undefined) node = node.parent
        if (node) {
          objectHit = {
            surface: null,
            point: hit.point.clone(),
            objectId: node.userData.objectId as string,
            distance: hit.distance,
            ray,
          }
        }
      }
    }

    // Solid terrain only. Water is a surface the editor looks THROUGH: every
    // tool edits the ground under it, and the preview is drawn there, so a
    // pick that stopped at the water would name the wrong cell — the one
    // under the pointer on the surface rather than the one under the ray.
    const solid = scene.solidTerrainMeshes().filter((mesh) => !lookPast.has(mesh.userData.structureId as string))
    const terrainHits = this.raycaster.intersectObjects(solid, false)
    // Under the layer view (`section.ts`) the GPU clips everything above the ceiling, but a ray still meets the clipped
    // geometry: the first hit that counts is the first at or below the ceiling.
    const ceiling = scene.section.ceiling
    const terrainHit = ceiling === null ? terrainHits[0] : terrainHits.find((hit) => hit.point.y <= ceiling + CUT_EPSILON)

    let terrainResult: PickResult | null = null
    if (terrainHit && terrainHit.faceIndex !== undefined && terrainHit.faceIndex !== null) {
      const faceAddr = scene.faceAddressFor(terrainHit.object)
      if (faceAddr) {
        terrainResult = {
          surface: readAddress(faceAddr, terrainHit.faceIndex, scene.structureIdFor(terrainHit.object)),
          point: terrainHit.point.clone(),
          objectId: null,
          distance: terrainHit.distance,
          ray,
        }
      }
    }

    // A ray that comes down through the ceiling where a structure reaches past it is looking at a cap: the pick lands
    // there, on the ceiling, as the top of that structure.
    if (ceiling !== null && ray.direction.y < 0 && ray.origin.y > ceiling) {
      const along = (ceiling - ray.origin.y) / ray.direction.y
      if (terrainResult === null || along < terrainResult.distance) {
        const at = this.raycaster.ray.at(along, new THREE.Vector3())
        const cap = scene.capAt(at.x, at.z)
        if (cap) terrainResult = { surface: cap, point: at, objectId: null, distance: along, ray }
      }
    }

    if (objectHit && terrainResult) {
      return objectHit.distance <= terrainResult.distance ? objectHit : terrainResult
    }
    return objectHit ?? terrainResult ?? { ...EMPTY, ray }
  }

  /** Where a ray meets the horizontal plane at world height `y`. */
  pickPlane(camera: THREE.Camera, ndcX: number, ndcY: number, y: number): THREE.Vector3 | null {
    this.pointer.set(ndcX, ndcY)
    this.raycaster.setFromCamera(this.pointer, camera)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y)
    const out = new THREE.Vector3()
    return this.raycaster.ray.intersectPlane(plane, out) ? out : null
  }
}
