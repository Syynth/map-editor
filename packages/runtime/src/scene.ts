/**
 * The reference runtime scene.
 *
 * This is the package the brief describes in section 14: it reads a document
 * (or, after export, the glTF extras carrying the same data) and sets up
 * terrain, objects, lights, fog and sky. The editor viewport renders through
 * it and so does play mode, which is what makes "the editor matches the game"
 * true by construction instead of by discipline.
 *
 * Terrain geometry is managed imperatively, chunk by chunk. Only chunks the
 * store marks dirty are rebuilt, so a brush stroke does not touch the rest of
 * the map.
 */

import * as THREE from 'three'

import { allChunkKeys, type MapDoc, type MapObject } from '@map-editor/document'
import { meshTerrainChunk, type MeshBuffers } from '@map-editor/geometry'
import { ObjectView, canvasTexture, type ObjectViewContext } from './billboard'
import { Sky, sunDirection } from './sky'
import { generateSprites, generateTerrainSheet, type SpriteAsset } from './textures'

function buildGeometry(buffers: MeshBuffers): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(buffers.normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(buffers.uvs, 2))
  geometry.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 3))
  geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1))
  geometry.computeBoundingSphere()
  return geometry
}

interface ChunkView {
  solid: THREE.Mesh
  water: THREE.Mesh | null
  /** Kept so picking can turn a raycast hit back into a document coordinate. */
  faceAddr: Int32Array
  waterFaceAddr: Int32Array | null
  triangleCount: number
}

export interface SceneStats {
  chunksBuilt: number
  triangles: number
  lastMeshMs: number
}

export class RuntimeScene {
  readonly scene = new THREE.Scene()
  readonly terrainGroup = new THREE.Group()
  readonly objectGroup = new THREE.Group()
  readonly sky = new Sky()

  sprites: Record<string, SpriteAsset>
  stats: SceneStats = { chunksBuilt: 0, triangles: 0, lastMeshMs: 0 }

  private chunks = new Map<string, ChunkView>()
  private views = new Map<string, ObjectView>()
  private terrainMaterial: THREE.MeshStandardMaterial
  private waterMaterial: THREE.MeshStandardMaterial
  private sheetTexture: THREE.CanvasTexture | null = null
  private sun = new THREE.DirectionalLight(0xffffff, 1)
  private hemisphere = new THREE.HemisphereLight(0xffffff, 0x444444, 1)
  private pointLights = new Map<string, THREE.PointLight>()
  private doc: MapDoc
  private lastSignature = ''

  constructor(doc: MapDoc) {
    this.doc = doc
    this.sprites = generateSprites(doc.texelDensity)

    this.terrainMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      alphaTest: 0.5,
    })
    this.waterMaterial = new THREE.MeshStandardMaterial({
      color: 0x3f7fb0,
      transparent: true,
      opacity: 0.66,
      roughness: 0.25,
      metalness: 0,
    })

    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    const shadowCamera = this.sun.shadow.camera
    shadowCamera.near = 0.5
    shadowCamera.far = 200
    shadowCamera.left = -60
    shadowCamera.right = 60
    shadowCamera.top = 60
    shadowCamera.bottom = -60
    this.sun.shadow.bias = -0.0009
    this.sun.shadow.normalBias = 0.02

    this.scene.add(this.sky.group)
    this.scene.add(this.terrainGroup)
    this.scene.add(this.objectGroup)
    this.scene.add(this.sun)
    this.scene.add(this.sun.target)
    this.scene.add(this.hemisphere)

    this.refreshSheet()
    this.applyAtmosphere()
  }

  setDocument(doc: MapDoc): void {
    const resolutionChanged =
      doc.texelDensity !== this.doc.texelDensity || doc.filtering !== this.doc.filtering
    this.doc = doc
    if (resolutionChanged) {
      this.sprites = generateSprites(doc.texelDensity)
      for (const view of this.views.values()) view.dispose()
      this.views.clear()
      this.objectGroup.clear()
    }
    this.refreshSheet()
  }

  /**
   * The template sheet. Regenerated when the materials or the resolution
   * profile change; an artist-supplied sheet replaces it wholesale.
   */
  refreshSheet(sheet?: HTMLCanvasElement): void {
    const signature =
      sheet
        ? `custom:${sheet.width}x${sheet.height}`
        : `${this.doc.texelDensity}:${this.doc.filtering}:${this.doc.materials
            .map((m) => `${m.name}${m.color}`)
            .join(',')}`
    if (!sheet && signature === this.lastSignature) return
    this.lastSignature = signature

    const canvas = sheet ?? generateTerrainSheet(this.doc.materials, this.doc.texelDensity)
    this.sheetTexture = canvasTexture(canvas, this.doc.filtering === 'nearest')
    this.terrainMaterial.map = this.sheetTexture
    this.terrainMaterial.needsUpdate = true
  }

  applyAtmosphere(): void {
    const atmosphere = this.doc.atmosphere
    this.scene.fog = new THREE.Fog(atmosphere.fogColor, atmosphere.fogNear, atmosphere.fogFar)

    this.sun.color.setHex(atmosphere.sunColor)
    this.sun.intensity = atmosphere.sunIntensity
    const direction = sunDirection(atmosphere)
    const centre = this.mapCentre()
    this.sun.position.copy(centre).addScaledVector(direction, 80)
    this.sun.target.position.copy(centre)
    this.sun.target.updateMatrixWorld()

    this.hemisphere.color.setHex(atmosphere.skyHorizon)
    this.hemisphere.groundColor.setHex(atmosphere.fogColor)
    this.hemisphere.intensity = atmosphere.ambientIntensity

    this.sky.apply(atmosphere, this.sprites, this.doc.filtering === 'nearest')
  }

  mapCentre(): THREE.Vector3 {
    return new THREE.Vector3(this.doc.size.width / 2, 0, this.doc.size.height / 2)
  }

  /** Rebuild the given chunks. Pass nothing to rebuild everything. */
  rebuildChunks(keys?: string[]): void {
    const list = keys ?? allChunkKeys(this.doc.size.width, this.doc.size.height)
    const start = performance.now()

    for (const key of list) {
      const existing = this.chunks.get(key)
      if (existing) {
        this.terrainGroup.remove(existing.solid)
        existing.solid.geometry.dispose()
        if (existing.water) {
          this.terrainGroup.remove(existing.water)
          existing.water.geometry.dispose()
        }
        this.chunks.delete(key)
      }

      const mesh = meshTerrainChunk(this.doc, key)
      if (mesh.solid.triangleCount === 0 && !mesh.water) continue

      const solid = new THREE.Mesh(buildGeometry(mesh.solid), this.terrainMaterial)
      solid.castShadow = true
      solid.receiveShadow = true
      solid.userData.chunkKey = key
      solid.userData.surface = 'solid'
      this.terrainGroup.add(solid)

      let water: THREE.Mesh | null = null
      if (mesh.water) {
        water = new THREE.Mesh(buildGeometry(mesh.water), this.waterMaterial)
        water.receiveShadow = true
        water.userData.chunkKey = key
        water.userData.surface = 'water'
        this.terrainGroup.add(water)
      }

      this.chunks.set(key, {
        solid,
        water,
        faceAddr: mesh.solid.faceAddr,
        waterFaceAddr: mesh.water?.faceAddr ?? null,
        triangleCount: mesh.solid.triangleCount,
      })
    }

    // Sum across every live chunk, not just the ones rebuilt this pass, so a
    // partial rebuild does not make the readout collapse to the brush.
    let triangles = 0
    for (const chunk of this.chunks.values()) triangles += chunk.triangleCount

    this.stats = {
      chunksBuilt: list.length,
      triangles,
      lastMeshMs: performance.now() - start,
    }
  }

  faceAddressFor(mesh: THREE.Object3D): Int32Array | null {
    const chunk = this.chunks.get(mesh.userData.chunkKey as string)
    if (!chunk) return null
    return mesh.userData.surface === 'water' ? chunk.waterFaceAddr : chunk.faceAddr
  }

  terrainMeshes(): THREE.Mesh[] {
    return this.terrainGroup.children.filter((child): child is THREE.Mesh => (child as THREE.Mesh).isMesh)
  }

  /** Reconcile object views against the document. */
  syncObjects(context: ObjectViewContext): void {
    const wanted = new Set(this.doc.objectOrder)

    for (const [id, view] of this.views) {
      if (!wanted.has(id)) {
        this.objectGroup.remove(view.group)
        view.dispose()
        this.views.delete(id)
        const light = this.pointLights.get(id)
        if (light) {
          this.objectGroup.remove(light)
          this.pointLights.delete(id)
        }
      }
    }

    for (const id of this.doc.objectOrder) {
      const object = this.doc.objects[id]
      if (!object) continue
      const asset = this.sprites[object.sprite] ?? this.sprites.rock
      let view = this.views.get(id)

      if (!view) {
        view = new ObjectView(object, asset, context)
        view.group.userData.objectId = id
        this.views.set(id, view)
        this.objectGroup.add(view.group)
      } else if (view.object !== object) {
        view.rebuild(object, asset, context)
        view.group.userData.objectId = id
      }
      view.setPosition(object.position)

      // Lights are mostly implicit: a lamp prop carries its own point light.
      if (asset.emissive) {
        let light = this.pointLights.get(id)
        if (!light) {
          light = new THREE.PointLight(0xffce8a, 0, 9, 1.6)
          this.pointLights.set(id, light)
          this.objectGroup.add(light)
        }
        // Dim in daylight, bright at night, driven by the sky preset.
        const nightness = 1 - Math.min(1, this.doc.atmosphere.sunIntensity / 1.2)
        light.intensity = 3.2 * nightness * object.scale
        light.position.set(
          object.position[0],
          object.position[1] + asset.heightTiles * object.scale * 0.86,
          object.position[2],
        )
      }
    }
  }

  updateObjects(cameraYaw: number, dt: number, context: ObjectViewContext): void {
    for (const view of this.views.values()) view.update(cameraYaw, dt, context)
  }

  objectViews(): ObjectView[] {
    return [...this.views.values()]
  }

  objectGroups(): THREE.Object3D[] {
    return [...this.views.values()].map((view) => view.group)
  }

  dispose(): void {
    for (const chunk of this.chunks.values()) {
      chunk.solid.geometry.dispose()
      chunk.water?.geometry.dispose()
    }
    this.chunks.clear()
    for (const view of this.views.values()) view.dispose()
    this.views.clear()
    this.terrainMaterial.dispose()
    this.waterMaterial.dispose()
    this.sky.dispose()
  }
}

export type { MapObject }
