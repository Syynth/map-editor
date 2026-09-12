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
 *
 * The art is an input, never a default (#47). The scene takes its template
 * sheet and sprite library as raw pixels from whoever composes it — the editor
 * generates placeholders through `fixtures`, a game would load real art — and
 * has no way to draw any itself. That is what keeps this package free of the
 * DOM: a runtime that could fall back to a canvas would need one.
 */

import * as THREE from 'three'

import { HALF, allChunkKeys, type ReadonlyMapDoc, type RgbaImage, type SpriteAsset } from '@map-editor/document'
import { meshTerrainChunk, type MeshBuffers } from '@map-editor/geometry'
import { ObjectView, rgbaTexture, type ObjectViewContext } from './billboard'
import { layerView, withinLayers, type LayerRange } from './layers'
import { Sky, sunDirection } from './sky'

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

/**
 * After the viewport's overlays (900–901), so the water surface composites
 * over a preview drawn on the lake bed and the preview reads as under water.
 */
export const WATER_RENDER_ORDER = 1000

export interface SceneStats {
  chunksBuilt: number
  triangles: number
  lastMeshMs: number
}

/**
 * Everything the scene textures with. Both halves are authored at the
 * document's texel density; the composition root regenerates or reloads them
 * when that changes and hands the new ones to `refreshSheet` / `setSprites`.
 */
export interface SceneAssets {
  /** The template sheet, laid out as `packages/geometry/src/template.ts` says. */
  sheet: RgbaImage
  /** Keyed by `MapObject.sprite`; an unknown name falls back to `rock`. */
  sprites: Record<string, SpriteAsset>
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
  private sheet: RgbaImage
  private sun = new THREE.DirectionalLight(0xffffff, 1)
  private hemisphere = new THREE.HemisphereLight(0xffffff, 0x444444, 1)
  private pointLights = new Map<string, THREE.PointLight>()
  private doc: ReadonlyMapDoc

  /** The height range the artist is looking at, or `null` for all of it. See `layers.ts`. */
  private layers: LayerRange | null = null

  constructor(doc: ReadonlyMapDoc, assets: SceneAssets) {
    this.doc = doc
    this.sheet = assets.sheet
    this.sprites = assets.sprites

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
      // A translucent surface that wrote depth would hide whatever the editor
      // draws on the lake bed under it — the brush preview, the hover. It
      // draws last instead (`WATER_RENDER_ORDER`) and tints what is below.
      depthWrite: false,
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

    this.applySheet()
    this.applyAtmosphere()
  }

  /**
   * Swap the document underneath the scene. The art is not touched: a density
   * or material change is the composition root's to notice, and it answers
   * with `refreshSheet` / `setSprites`. Filtering IS answered here, because it
   * is a document setting applied to art the scene already holds.
   */
  setDocument(doc: ReadonlyMapDoc): void {
    const filteringChanged = doc.filtering !== this.doc.filtering
    this.doc = doc
    if (filteringChanged) {
      this.dropViews()
      this.applySheet()
    }
  }

  /** The template sheet, generated or artist-supplied; the caller cannot tell which and neither can this. */
  refreshSheet(sheet: RgbaImage): void {
    this.sheet = sheet
    this.applySheet()
  }

  /**
   * Replace the sprite library. Every view and backdrop is rebuilt from it on
   * the next sync, since the old images may be at the wrong density.
   */
  setSprites(sprites: Record<string, SpriteAsset>): void {
    this.sprites = sprites
    this.dropViews()
    this.sky.apply(this.doc.atmosphere, this.sprites, this.doc.filtering === 'nearest')
  }

  private applySheet(): void {
    this.terrainMaterial.map = rgbaTexture(this.sheet, this.doc.filtering === 'nearest')
    this.terrainMaterial.needsUpdate = true
  }

  private dropViews(): void {
    for (const view of this.views.values()) view.dispose()
    this.views.clear()
    this.objectGroup.clear()
    this.pointLights.clear()
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

  /** Remove a chunk's meshes from the scene and free their geometry. */
  private dropChunk(key: string): void {
    const existing = this.chunks.get(key)
    if (!existing) return
    this.terrainGroup.remove(existing.solid)
    existing.solid.geometry.dispose()
    if (existing.water) {
      this.terrainGroup.remove(existing.water)
      existing.water.geometry.dispose()
    }
    this.chunks.delete(key)
  }

  /** Rebuild the given chunks. Pass nothing to rebuild everything. */
  /** Narrow (or widen) the height range drawn. The caller rebuilds the chunks; this only records it. */
  setLayerRange(range: LayerRange | null): void {
    this.layers = range
  }

  rebuildChunks(keys?: string[]): void {
    const list = keys ?? allChunkKeys(this.doc.size.width, this.doc.size.height)
    const start = performance.now()
    // What the mesher reads: the document, or its layer view while a range is set.
    const source = layerView(this.doc, this.layers)

    // A full rebuild is authoritative about which chunks exist, so it also has
    // to drop the ones that no longer do. Replacing a map with a smaller one
    // leaves keys behind that the new document has no cells for, and nothing
    // else would ever remove them: they would keep drawing the replaced map
    // and keep answering hover and terrain picking. Same reconciliation
    // `syncObjects` does for object views.
    if (!keys) {
      const wanted = new Set(list)
      for (const key of [...this.chunks.keys()]) if (!wanted.has(key)) this.dropChunk(key)
    }

    for (const key of list) {
      this.dropChunk(key)

      const mesh = meshTerrainChunk(source, key)
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
        water.renderOrder = WATER_RENDER_ORDER
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

  /** The ground alone — what a pick lands on; the water surface is looked through. */
  solidTerrainMeshes(): THREE.Mesh[] {
    return this.terrainMeshes().filter((mesh) => mesh.userData.surface !== 'water')
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
    for (const view of this.views.values()) {
      view.update(cameraYaw, dt, context)
      // An object outside the layer range is hidden the same way a hidden
      // object is — after `update`, which sets visibility from the object.
      if (this.layers !== null && !withinLayers(this.layers, view.object.position[1], HALF)) view.group.visible = false
    }
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
