/**
 * The runtime scene: what a level looks like, built from the document.
 *
 * Every structure gets a group placed by its frame — its origin, its
 * quarter-turn, the height of what it stands on — and the group holds what
 * the structure's kind meshes to: a voxel volume's chunks (solid and water,
 * in its own local cells), a sketch's five parts (cap, rim, wall body, top
 * and bottom bands), each dressed in the material the document names.
 * Objects and lights are level-level and live beside the structures.
 *
 * A change arrives as dirty keys from the store: a chunk key names one
 * chunk of one voxel volume; a structure id names a structure whose own
 * data, placement or parent changed, which rebuilds it whole (and, because
 * the store marks descendants too, everything standing on it).
 */

import * as THREE from 'three'
import {
  HALF,
  SURFACE_SKETCH_CAP,
  SURFACE_SKETCH_WALL,
  allChunkKeys,
  frameOf,
  levelCentre,
  parseStructureChunkKey,
  structureChunkKey,
  type EdgeBand,
  type FillEdgeMaterial,
  type ReadonlyMapDoc,
  type ReadonlySketch,
  type ReadonlyVoxel,
  type RgbaImage,
  type SpriteAsset,
  type DocumentTarget,
} from '@papercut/document'
import { meshSketch, meshTerrainChunk, type EdgeSpec, type MeshBuffers, type SketchMesh } from '@papercut/geometry'
import { ObjectView, releaseReplaced, releaseTexture, rgbaTexture, spriteImages, type ObjectViewContext } from './billboard'
import { CUT_TINT, GHOST_TINT, layerView, withinLayers, type LayerRange } from './layers'
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
  faceAddr: Int32Array
  waterFaceAddr: Int32Array | null
  triangleCount: number
}

interface StructureView {
  group: THREE.Group
  chunks: Map<string, ChunkView>
  /** A sketch's parts, each with the face addresses a pick reads. */
  parts: Map<THREE.Mesh, Int32Array>
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

export interface SceneAssets {
  sheet: RgbaImage
  sprites: Record<string, SpriteAsset>
  /** Fill-and-edge textures by the names the document's surface materials use. */
  textures: Record<string, RgbaImage>
}

const SKETCH_PARTS = ['cap', 'rim', 'wallBody', 'wallTop', 'wallBottom'] as const
type SketchPart = (typeof SKETCH_PARTS)[number]

function bandSpec(band: EdgeBand | undefined): EdgeSpec {
  // A material without the band still meshes with a hair-thin one; the part is then not added.
  return band ? { width: band.width, segment: band.segment, repeat: band.repeat } : { width: 0.01, segment: 1, repeat: 'tile' }
}

/** What the mesher needs from a sketch and the two materials it names; `cut` slices it at that height above its base. */
export function sketchMeshOf(doc: ReadonlyMapDoc, sketch: ReadonlySketch, cut?: number): SketchMesh {
  const cap = doc.surfaceMaterials[sketch.capMaterial] as FillEdgeMaterial | undefined
  const wall = doc.surfaceMaterials[sketch.wallMaterial] as FillEdgeMaterial | undefined
  return meshSketch(
    { points: sketch.points.map((p) => ({ ...p })) },
    {
      height: sketch.layers * HALF,
      cut,
      cap: { fillScale: cap?.fill.scale ?? 0.5, rim: bandSpec(cap?.rim) },
      wall: { bodyScale: wall?.fill.scale ?? 0.5, top: bandSpec(wall?.top), bottom: bandSpec(wall?.bottom) },
      lip: sketch.lip,
      profile: { points: sketch.wall.points.map((p) => ({ ...p })), smooth: sketch.wall.smooth },
    },
  )
}

/** The buffers with every vertex coloured `tint`, the way the layer view marks a cut cap or a ghosted column. */
function tinted(buffers: MeshBuffers, tint: number): MeshBuffers {
  const colors = new Float32Array(buffers.colors.length)
  const r = ((tint >> 16) & 0xff) / 255
  const g = ((tint >> 8) & 0xff) / 255
  const b = (tint & 0xff) / 255
  for (let i = 0; i < colors.length; i += 3) {
    colors[i] = r
    colors[i + 1] = g
    colors[i + 2] = b
  }
  return { ...buffers, colors }
}

/** Which of a sketch's parts a material band dresses, and with what texture; `null` when the material has no such band. */
function textureForPart(doc: ReadonlyMapDoc, sketch: ReadonlySketch, part: SketchPart): string | null {
  const cap = doc.surfaceMaterials[sketch.capMaterial] as FillEdgeMaterial | undefined
  const wall = doc.surfaceMaterials[sketch.wallMaterial] as FillEdgeMaterial | undefined
  switch (part) {
    case 'cap':
      return cap?.fill.texture ?? null
    case 'rim':
      return cap?.rim?.texture ?? null
    case 'wallBody':
      return wall?.fill.texture ?? null
    case 'wallTop':
      return wall?.top?.texture ?? null
    case 'wallBottom':
      return wall?.bottom?.texture ?? null
  }
}

export class RuntimeScene {
  readonly scene = new THREE.Scene()
  /** Every structure's group; picking and export walk this. */
  readonly terrainGroup = new THREE.Group()
  readonly objectGroup = new THREE.Group()
  readonly sky = new Sky()
  sprites: Record<string, SpriteAsset>
  stats: SceneStats = { chunksBuilt: 0, triangles: 0, lastMeshMs: 0 }

  private structures = new Map<string, StructureView>()
  private views = new Map<string, ObjectView>()
  private terrainMaterial: THREE.MeshStandardMaterial
  private waterMaterial: THREE.MeshStandardMaterial
  private surfaceMaterials = new Map<string, THREE.MeshStandardMaterial>()
  private sheet: RgbaImage
  private textures: Record<string, RgbaImage>
  private sun = new THREE.DirectionalLight(0xffffff, 1)
  private hemisphere = new THREE.HemisphereLight(0xffffff, 0x444444, 1)
  private pointLights = new Map<string, THREE.PointLight>()
  private doc: ReadonlyMapDoc
  private layers: LayerRange | null = null

  constructor(doc: ReadonlyMapDoc, assets: SceneAssets) {
    this.doc = doc
    this.sheet = assets.sheet
    this.sprites = assets.sprites
    this.textures = assets.textures

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

  setDocument(doc: ReadonlyMapDoc): void {
    const filteringChanged = doc.filtering !== this.doc.filtering
    this.doc = doc
    if (filteringChanged) {
      this.dropViews()
      this.applySheet()
      for (const material of this.surfaceMaterials.values()) material.dispose()
      this.surfaceMaterials.clear()
    }
  }

  /** Draw the terrain with `sheet`, and give back the GPU texture of the sheet it replaces. */
  refreshSheet(sheet: RgbaImage): void {
    const previous = this.sheet
    this.sheet = sheet
    this.applySheet()
    // A document load regenerates the sheet as a new image every time; without this each one left a texture on the GPU.
    if (previous !== sheet) releaseTexture(previous)
  }

  /** Draw objects and backdrops with `sprites`, and give back the GPU textures of images the new set no longer has. */
  setSprites(sprites: Record<string, SpriteAsset>): void {
    const previous = this.sprites
    this.sprites = sprites
    this.dropViews()
    this.sky.apply(this.doc.atmosphere, this.sprites, this.doc.filtering === 'nearest')
    releaseReplaced(spriteImages(previous), spriteImages(sprites))
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

  /** The middle of the level's extent, derived from its structures. */
  mapCentre(): THREE.Vector3 {
    const [x, , z] = levelCentre(this.doc)
    return new THREE.Vector3(x, 0, z)
  }

  // --- structures -------------------------------------------------------------

  /** Narrow (or widen) the height range drawn. The caller rebuilds; this only records it. */
  setLayerRange(range: LayerRange | null): void {
    this.layers = range
  }

  private dropStructure(id: string): void {
    const view = this.structures.get(id)
    if (!view) return
    for (const chunk of view.chunks.values()) {
      chunk.solid.geometry.dispose()
      chunk.water?.geometry.dispose()
    }
    for (const mesh of view.parts.keys()) mesh.geometry.dispose()
    this.terrainGroup.remove(view.group)
    this.structures.delete(id)
  }

  private placeGroup(group: THREE.Group, id: string): void {
    const frame = frameOf(this.doc, id)
    group.position.set(frame.x, frame.y, frame.z)
    // A quarter turn maps local (x, z) to (−z, x) in the document; three's Y rotation of −90° does the same.
    group.rotation.y = (-frame.yaw * Math.PI) / 2
  }

  private ensureStructure(id: string): StructureView {
    let view = this.structures.get(id)
    if (!view) {
      view = { group: new THREE.Group(), chunks: new Map(), parts: new Map(), triangleCount: 0 }
      view.group.userData.structureId = id
      this.terrainGroup.add(view.group)
      this.structures.set(id, view)
    }
    this.placeGroup(view.group, id)
    return view
  }

  /** The voxel volume as the mesher should read it under the layer view: the range shifted into the volume's own heights. */
  private voxelSource(voxel: ReadonlyVoxel, base: number): ReadonlyVoxel {
    if (this.layers === null) return voxel
    const shift = Math.round(base / HALF)
    return layerView(voxel, { lo: this.layers.lo - shift, hi: this.layers.hi - shift })
  }

  private buildChunk(view: StructureView, voxel: ReadonlyVoxel, source: ReadonlyVoxel, key: string): void {
    const existing = view.chunks.get(key)
    if (existing) {
      view.group.remove(existing.solid)
      existing.solid.geometry.dispose()
      if (existing.water) {
        view.group.remove(existing.water)
        existing.water.geometry.dispose()
      }
      view.chunks.delete(key)
    }
    const { cx, cy } = parseStructureChunkKey(key)
    const mesh = meshTerrainChunk(this.doc, source, `${cx},${cy}`)
    if (mesh.solid.triangleCount === 0 && !mesh.water) return

    const solid = new THREE.Mesh(buildGeometry(mesh.solid), this.terrainMaterial)
    solid.castShadow = true
    solid.receiveShadow = true
    solid.userData.chunkKey = key
    solid.userData.surface = 'solid'
    solid.userData.structureId = voxel.id
    view.group.add(solid)

    let water: THREE.Mesh | null = null
    if (mesh.water) {
      water = new THREE.Mesh(buildGeometry(mesh.water), this.waterMaterial)
      water.receiveShadow = true
      water.renderOrder = WATER_RENDER_ORDER
      water.userData.chunkKey = key
      water.userData.surface = 'water'
      water.userData.structureId = voxel.id
      view.group.add(water)
    }
    view.chunks.set(key, { solid, water, faceAddr: mesh.solid.faceAddr, waterFaceAddr: mesh.water?.faceAddr ?? null, triangleCount: mesh.solid.triangleCount })
  }

  private surfaceMaterial(textureName: string | null, band: boolean): THREE.MeshStandardMaterial {
    const key = `${textureName ?? '-'}:${band ? 'band' : 'fill'}`
    let material = this.surfaceMaterials.get(key)
    if (!material) {
      const image = textureName ? this.textures[textureName] : undefined
      material = new THREE.MeshStandardMaterial({
        map: image ? rgbaTexture(image, this.doc.filtering === 'nearest') : null,
        color: image ? 0xffffff : 0xb06cd6,
        vertexColors: true,
        roughness: 1,
        metalness: 0,
        // Bands lie on the faces they dress: pushed toward the camera so they win the depth test.
        polygonOffset: band,
        polygonOffsetFactor: band ? -2 : 0,
        polygonOffsetUnits: band ? -2 : 0,
      })
      if (image) {
        const map = material.map as THREE.Texture
        map.wrapS = THREE.RepeatWrapping
        map.wrapT = band ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping
      }
      this.surfaceMaterials.set(key, material)
    }
    return material
  }

  private buildSketch(view: StructureView, sketch: ReadonlySketch, base: number): void {
    for (const mesh of view.parts.keys()) {
      view.group.remove(mesh)
      mesh.geometry.dispose()
    }
    view.parts.clear()
    if (!sketch.closed || sketch.points.length < 3) return

    // Under the layer view a sketch above the ceiling is not drawn; one the ceiling passes through is
    // sliced there, its cut face tinted like a cut column's; one wholly under the floor is ghosted.
    const height = sketch.layers * HALF
    let cut: number | undefined
    let tint: number | null = null
    if (this.layers !== null) {
      const ceiling = this.layers.hi * HALF
      if (base >= ceiling) return
      if (ceiling - base < height) {
        cut = ceiling - base
        tint = CUT_TINT
      } else if (base + height < this.layers.lo * HALF) tint = GHOST_TINT
    }

    const mesh = sketchMeshOf(this.doc, sketch, cut)
    for (const part of SKETCH_PARTS) {
      const raw = mesh[part]
      if (raw.triangleCount === 0) continue
      const buffers = tint !== null && (tint === GHOST_TINT || part === 'cap') ? tinted(raw, tint) : raw
      const texture = textureForPart(this.doc, sketch, part)
      const band = part !== 'cap' && part !== 'wallBody'
      // A band the material does not have is not a part of this sketch.
      if (band && texture === null) continue
      // The mesher addresses every face by outline segment; the surface kind says cap or wall.
      const faceAddr = new Int32Array(buffers.faceAddr)
      for (let i = 0; i < faceAddr.length; i += 4) faceAddr[i] = part === 'cap' || part === 'rim' ? SURFACE_SKETCH_CAP : SURFACE_SKETCH_WALL
      const node = new THREE.Mesh(buildGeometry(buffers), this.surfaceMaterial(texture, band))
      node.castShadow = !band
      node.receiveShadow = true
      node.renderOrder = band ? 1 : 0
      node.userData.structureId = sketch.id
      node.userData.surface = 'solid'
      node.userData.part = part
      view.group.add(node)
      view.parts.set(node, faceAddr)
    }
  }

  private buildStructure(id: string): void {
    const structure = this.doc.structures[id]
    if (!structure) {
      this.dropStructure(id)
      return
    }
    this.dropStructure(id)
    const view = this.ensureStructure(id)
    const base = view.group.position.y
    if (structure.kind === 'voxel') {
      const source = this.voxelSource(structure, base)
      for (const key of allChunkKeys(structure.size.width, structure.size.height)) {
        this.buildChunk(view, structure, source, structureChunkKey(id, ...(key.split(',').map(Number) as [number, number])))
      }
    } else {
      this.buildSketch(view, structure, base)
    }
    view.triangleCount = [...view.chunks.values()].reduce((sum, c) => sum + c.triangleCount, 0) + [...view.parts.values()].reduce((sum, a) => sum + a.length / 4, 0)
  }

  /** Rebuild everything: the document's set of structures is authoritative. */
  rebuildAll(): void {
    const start = performance.now()
    const wanted = new Set(this.doc.structureOrder)
    for (const id of [...this.structures.keys()]) if (!wanted.has(id)) this.dropStructure(id)
    for (const id of this.doc.structureOrder) this.buildStructure(id)
    this.finishStats(start, this.doc.structureOrder.length)
  }

  /** Rebuild what the store marked: chunks of voxel volumes by key, structures whole by id. */
  rebuild(dirty: { chunks: readonly string[]; structures: readonly string[] }): void {
    const start = performance.now()
    const whole = new Set(dirty.structures)
    for (const id of whole) this.buildStructure(id)
    let built = whole.size
    for (const key of dirty.chunks) {
      const { structure } = parseStructureChunkKey(key)
      if (whole.has(structure)) continue
      const voxel = this.doc.structures[structure]
      if (!voxel || voxel.kind !== 'voxel') continue
      const view = this.ensureStructure(structure)
      this.buildChunk(view, voxel, this.voxelSource(voxel, view.group.position.y), key)
      view.triangleCount = [...view.chunks.values()].reduce((sum, c) => sum + c.triangleCount, 0)
      built += 1
    }
    this.finishStats(start, built)
  }

  private finishStats(start: number, built: number): void {
    let triangles = 0
    for (const view of this.structures.values()) triangles += view.triangleCount
    this.stats = { chunksBuilt: built, triangles, lastMeshMs: performance.now() - start }
  }

  /** The structure a terrain mesh belongs to — what a pick names alongside the face. */
  structureIdFor(mesh: THREE.Object3D): string {
    return mesh.userData.structureId as string
  }

  faceAddressFor(mesh: THREE.Object3D): Int32Array | null {
    const view = this.structures.get(mesh.userData.structureId as string)
    if (!view) return null
    const part = view.parts.get(mesh as THREE.Mesh)
    if (part) return part
    const chunk = view.chunks.get(mesh.userData.chunkKey as string)
    if (!chunk) return null
    return mesh.userData.surface === 'water' ? chunk.waterFaceAddr : chunk.faceAddr
  }

  /** Every structure mesh, solid and water, across every structure. */
  terrainMeshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = []
    for (const view of this.structures.values()) for (const child of view.group.children) if ((child as THREE.Mesh).isMesh) out.push(child as THREE.Mesh)
    return out
  }

  /** The ground alone — what a pick lands on; the water surface is looked through. */
  solidTerrainMeshes(): THREE.Mesh[] {
    return this.terrainMeshes().filter((mesh) => mesh.userData.surface !== 'water')
  }

  // --- objects ----------------------------------------------------------------

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
      if (asset.emissive) {
        let light = this.pointLights.get(id)
        if (!light) {
          light = new THREE.PointLight(0xffce8a, 0, 9, 1.6)
          this.pointLights.set(id, light)
          this.objectGroup.add(light)
        }
        const nightness = 1 - Math.min(1, this.doc.atmosphere.sunIntensity / 1.2)
        light.intensity = 3.2 * nightness * object.scale
        light.position.set(object.position[0], object.position[1] + asset.heightTiles * object.scale * 0.86, object.position[2])
      }
    }
  }

  updateObjects(cameraYaw: number, dt: number, context: ObjectViewContext): void {
    for (const view of this.views.values()) {
      view.update(cameraYaw, dt, context)
      if (this.layers !== null && !withinLayers(this.layers, view.object.position[1], HALF)) view.group.visible = false
    }
  }

  objectViews(): ObjectView[] {
    return [...this.views.values()]
  }

  /** The scene node a target is drawn as: an object's group, or a structure's. `null` when it is not in the scene. */
  nodeOf(target: DocumentTarget): THREE.Object3D | null {
    if (target.kind === 'object') return this.views.get(target.id)?.group ?? null
    return this.structures.get(target.id)?.group ?? null
  }

  /** The world bounds of a target, for a highlight to frame; `null` when it is not in the scene or draws nothing. */
  boundsOf(target: DocumentTarget): THREE.Box3 | null {
    const node = this.nodeOf(target)
    if (!node) return null
    const box = new THREE.Box3().setFromObject(node)
    return box.isEmpty() ? null : box
  }

  objectGroups(): THREE.Object3D[] {
    return [...this.views.values()].map((view) => view.group)
  }

  dispose(): void {
    for (const id of [...this.structures.keys()]) this.dropStructure(id)
    for (const view of this.views.values()) view.dispose()
    this.views.clear()
    this.terrainMaterial.dispose()
    this.waterMaterial.dispose()
    for (const material of this.surfaceMaterials.values()) material.dispose()
    this.sky.dispose()
    releaseTexture(this.sheet)
    for (const image of [...spriteImages(this.sprites), ...Object.values(this.textures)]) releaseTexture(image)
  }
}
