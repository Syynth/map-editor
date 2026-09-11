/**
 * Display modes, facings and the Paper Mario flip.
 *
 * This is the first piece of the reference runtime. The editor viewport and
 * play mode both drive objects through `ObjectView`, so an object cannot look
 * one way while building and another way in game — the "what you see is what
 * ships" principle is structural here rather than aspirational.
 *
 * The flip is the interesting one. A sprite that changes facing rotates a full
 * 180 degrees about its hinge and swaps to the new image at the edge-on
 * midpoint, where the swap is invisible because the quad has no width on
 * screen. That is what sells the paper-cutout feel.
 */

import * as THREE from 'three'

import type { CameraRig, MapObject } from '@core/document'
import { wrapDegrees, yawIsFree } from './camera'
import type { SpriteAsset } from './textures'

const DEG = Math.PI / 180

/** Thickness of an extruded slab, in world units (tiles). */
const EXTRUDE_THICKNESS = 0.12
const EXTRUDE_LAYERS = 7

const textureCache = new WeakMap<HTMLCanvasElement, THREE.CanvasTexture>()

export function canvasTexture(canvas: HTMLCanvasElement, nearest: boolean): THREE.CanvasTexture {
  const cached = textureCache.get(canvas)
  if (cached) {
    cached.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter
    cached.minFilter = nearest ? THREE.NearestMipmapNearestFilter : THREE.LinearMipmapLinearFilter
    cached.needsUpdate = true
    return cached
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter
  texture.minFilter = nearest ? THREE.NearestMipmapNearestFilter : THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 4
  textureCache.set(canvas, texture)
  return texture
}

/**
 * Resolve `auto` against the rig, per brief section 8: a camera that barely
 * rotates can use a cheap fixed plane; one that orbits needs a billboard.
 */
export function resolveDisplayMode(object: MapObject, rig: CameraRig): Exclude<MapObject['display'], 'auto'> {
  if (object.display !== 'auto') return object.display
  const span = yawIsFree(rig) ? 360 : Math.abs(rig.bounds.yawMax - rig.bounds.yawMin)
  if (span <= 20) return 'fixed'
  if (object.facing.facings > 1) return 'fixed'
  return 'billboardY'
}

/**
 * Which facing image a camera at `cameraYaw` should see.
 * Returns the image index plus whether it must be drawn mirrored.
 */
export function pickFacing(
  object: MapObject,
  cameraYaw: number,
  current: number | null,
): { index: number; mirrored: boolean } {
  const count = object.facing.facings
  if (count <= 1) return { index: 0, mirrored: false }

  const relative = wrapDegrees(cameraYaw - object.rotationY)
  const sector = 360 / count
  // 0 is the front, indices increase clockwise.
  let index = Math.round(wrapDegrees(relative) / sector)
  index = ((index % count) + count) % count

  // Hysteresis: stay on the current facing until the angle has crossed the
  // boundary by the configured margin, so a camera resting on a boundary does
  // not strobe between two images.
  if (current !== null && current !== index && object.facing.hysteresisDeg > 0) {
    const centreOfCurrent = current * sector
    const offset = Math.abs(wrapDegrees(relative - centreOfCurrent))
    if (offset < sector / 2 + object.facing.hysteresisDeg) index = current
  }

  if (object.facing.mirror && count >= 4) {
    // The left half reuses the right half's art, mirrored.
    const mirroredIndex = (count - index) % count
    if (index > count / 2) return { index: mirroredIndex, mirrored: true }
  }
  return { index, mirrored: false }
}

function planeGeometry(width: number, height: number, hinge: MapObject['facing']['hinge']): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(width, height)
  // Pivot defaults to bottom-centre; the hinge moves the rotation axis.
  let offsetX = 0
  const offsetY = height / 2
  if (hinge === 'edge') offsetX = width / 2
  geometry.translate(offsetX, offsetY, 0)
  return geometry
}

function makeMaterial(texture: THREE.Texture, emissive: boolean): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: texture,
    transparent: false,
    // Alpha-masked rather than blended: it sorts correctly against terrain and
    // maps straight onto glTF's alphaMode MASK on export.
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    emissiveMap: emissive ? texture : null,
    emissive: emissive ? new THREE.Color(0xffd9a0) : new THREE.Color(0x000000),
    emissiveIntensity: emissive ? 1.0 : 0,
    roughness: 1,
    metalness: 0,
  })
}

export interface ObjectViewContext {
  rig: CameraRig
  nearest: boolean
  /** Play mode uses movement direction; the editor uses camera yaw. */
  facingOverride?: number | null
}

/**
 * One placed object in the scene. Owns its meshes and its own flip state.
 */
export class ObjectView {
  readonly group = new THREE.Group()
  /** Rotated by the flip; the hinge lives at its origin. */
  private readonly pivot = new THREE.Group()
  private meshes: THREE.Mesh[] = []
  private material: THREE.MeshStandardMaterial
  private fadeMaterial: THREE.MeshStandardMaterial | null = null
  private fadeMesh: THREE.Mesh | null = null

  private asset: SpriteAsset
  private mode: Exclude<MapObject['display'], 'auto'> = 'fixed'

  private currentFacing = 0
  private mirrored = false
  private flipAngle = 0
  private flipping = false
  private pendingFacing = 0
  private pendingMirrored = false
  private fade = 0

  object: MapObject

  constructor(object: MapObject, asset: SpriteAsset, context: ObjectViewContext) {
    this.object = object
    this.asset = asset
    this.material = makeMaterial(canvasTexture(asset.facings[0], context.nearest), asset.emissive)
    this.group.add(this.pivot)
    this.rebuild(object, asset, context)
  }

  /** Rebuild geometry. Called on creation and whenever the object changes shape. */
  rebuild(object: MapObject, asset: SpriteAsset, context: ObjectViewContext): void {
    this.object = object
    this.asset = asset
    this.mode = resolveDisplayMode(object, context.rig)

    for (const mesh of this.meshes) {
      this.pivot.remove(mesh)
      mesh.geometry.dispose()
    }
    this.meshes = []
    if (this.fadeMesh) {
      this.pivot.remove(this.fadeMesh)
      this.fadeMesh.geometry.dispose()
      this.fadeMesh = null
    }

    const width = asset.widthTiles * object.scale
    const height = asset.heightTiles * object.scale
    const hinge = object.facing.hinge

    this.material.map = canvasTexture(asset.facings[0], context.nearest)
    this.material.needsUpdate = true

    if (this.mode === 'crossed') {
      for (const angle of [0, Math.PI / 2]) {
        const mesh = new THREE.Mesh(planeGeometry(width, height, hinge), this.material)
        mesh.rotation.y = angle
        mesh.castShadow = true
        mesh.receiveShadow = true
        this.meshes.push(mesh)
        this.pivot.add(mesh)
      }
    } else if (this.mode === 'extruded') {
      // The alpha silhouette given real thickness. A true extrusion would walk
      // the alpha mask and build side walls; a short stack of layered quads
      // gets the paper-cutout read and a solid shadow for a fraction of the
      // cost, which is the right trade until an artist says otherwise.
      for (let layer = 0; layer < EXTRUDE_LAYERS; layer++) {
        const mesh = new THREE.Mesh(planeGeometry(width, height, hinge), this.material)
        mesh.position.z = (layer / (EXTRUDE_LAYERS - 1) - 0.5) * EXTRUDE_THICKNESS * object.scale
        mesh.castShadow = true
        mesh.receiveShadow = true
        this.meshes.push(mesh)
        this.pivot.add(mesh)
      }
    } else {
      const mesh = new THREE.Mesh(planeGeometry(width, height, hinge), this.material)
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.meshes.push(mesh)
      this.pivot.add(mesh)
    }

    // Crossfade needs a second quad to blend against.
    if (object.facing.transition === 'crossfade' && object.facing.facings > 1) {
      this.fadeMaterial = makeMaterial(this.material.map, asset.emissive)
      this.fadeMaterial.transparent = true
      this.fadeMaterial.alphaTest = 0.01
      this.fadeMaterial.depthWrite = false
      this.fadeMesh = new THREE.Mesh(planeGeometry(width, height, hinge), this.fadeMaterial)
      this.fadeMesh.position.z = 0.001
      this.pivot.add(this.fadeMesh)
      this.fadeMesh.visible = false
    }

    // The hinge decides where the pivot sits relative to the object origin.
    this.pivot.position.set(
      hinge === 'edge' ? -(width / 2) : 0,
      0,
      0,
    )

    this.group.position.set(...object.position)
    this.group.visible = !object.hidden
    this.applyFacing(this.currentFacing, this.mirrored, context.nearest)
  }

  private applyFacing(index: number, mirrored: boolean, nearest: boolean): void {
    const canvas = this.asset.facings[Math.min(index, this.asset.facings.length - 1)]
    const texture = canvasTexture(canvas, nearest)
    this.material.map = texture
    if (this.asset.emissive) this.material.emissiveMap = texture
    this.material.needsUpdate = true
    // Mirroring flips the quad rather than the texture, so one canvas serves
    // both sides without a second upload.
    const sign = mirrored ? -1 : 1
    for (const mesh of this.meshes) mesh.scale.x = Math.abs(mesh.scale.x) * sign
    this.currentFacing = index
    this.mirrored = mirrored
  }

  /**
   * @param cameraYaw   degrees, the direction the camera looks from
   * @param dt          seconds
   */
  update(cameraYaw: number, dt: number, context: ObjectViewContext): void {
    const object = this.object
    this.group.visible = !object.hidden
    if (object.hidden) return

    // --- orientation ------------------------------------------------------
    switch (this.mode) {
      case 'billboardY':
        this.group.rotation.set(0, cameraYaw * DEG, 0)
        break
      case 'billboardFull': {
        const pitch = -(context.rig.pitch ?? 0) * DEG
        this.group.rotation.set(pitch, cameraYaw * DEG, 0)
        break
      }
      case 'fixed':
      case 'crossed':
      case 'extruded':
        this.group.rotation.set(0, object.rotationY * DEG, 0)
        break
    }

    // --- which image ------------------------------------------------------
    const facingSource = context.facingOverride ?? cameraYaw
    const wanted = pickFacing(object, facingSource, this.flipping ? this.pendingFacing : this.currentFacing)

    const changed = wanted.index !== this.currentFacing || wanted.mirrored !== this.mirrored

    if (changed && !this.flipping) {
      if (object.facing.transition === 'instant') {
        this.applyFacing(wanted.index, wanted.mirrored, context.nearest)
      } else {
        this.flipping = true
        this.flipAngle = 0
        this.fade = 0
        this.pendingFacing = wanted.index
        this.pendingMirrored = wanted.mirrored
      }
    }

    if (this.flipping) {
      const duration = Math.max(0.016, object.facing.durationMs / 1000)
      const step = dt / duration

      if (object.facing.transition === 'crossfade' && this.fadeMesh && this.fadeMaterial) {
        this.fade = Math.min(1, this.fade + step)
        this.fadeMesh.visible = true
        this.fadeMaterial.map = canvasTexture(this.asset.facings[this.pendingFacing], context.nearest)
        this.fadeMaterial.opacity = this.fade
        this.fadeMaterial.needsUpdate = true
        if (this.fade >= 1) {
          this.applyFacing(this.pendingFacing, this.pendingMirrored, context.nearest)
          this.fadeMesh.visible = false
          this.flipping = false
        }
      } else {
        const previous = this.flipAngle
        this.flipAngle = Math.min(Math.PI, this.flipAngle + step * Math.PI)
        // Swap at the edge-on midpoint, where the quad is invisible.
        if (previous < Math.PI / 2 && this.flipAngle >= Math.PI / 2) {
          this.applyFacing(this.pendingFacing, this.pendingMirrored, context.nearest)
        }
        this.pivot.rotation.y = this.flipAngle
        if (this.flipAngle >= Math.PI) {
          this.flipAngle = 0
          this.pivot.rotation.y = 0
          this.flipping = false
        }
      }
    }

    // --- the far side -----------------------------------------------------
    // Only meaningful for a flat plane with a single image; anything with real
    // facings has already chosen the right one above.
    if (object.facing.facings === 1 && this.mode === 'fixed') {
      const relative = Math.abs(wrapDegrees(cameraYaw - object.rotationY))
      const behind = relative > 90
      switch (object.facing.back) {
        case 'none':
          this.group.visible = !behind
          break
        case 'dark':
          this.material.color.setScalar(behind ? 0.35 : 1)
          break
        case 'image':
          if (this.asset.facings.length > 1) {
            const wantIndex = behind ? 1 : 0
            if (wantIndex !== this.currentFacing) this.applyFacing(wantIndex, false, context.nearest)
          }
          break
        case 'mirror':
        default:
          this.material.color.setScalar(1)
          break
      }
    }

    // Hinge 'base' folds the sprite down from its foot, which is what makes a
    // pop-up book effect possible; nothing else to do beyond the pivot offset.
  }

  setPosition(position: [number, number, number]): void {
    this.group.position.set(...position)
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.geometry.dispose()
    if (this.fadeMesh) this.fadeMesh.geometry.dispose()
    this.material.dispose()
    this.fadeMaterial?.dispose()
    this.meshes = []
  }
}
