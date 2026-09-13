import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { HALF, SURFACE_SKETCH_CAP, SURFACE_TOP, allChunkKeys, createMap, createSketch, fillColumn, topHeight, type RgbaImage, type SpriteAsset, type VoxelStructure } from '@papercut/document'
import { Picker } from './picking'
import { rgbaTexture } from './billboard'
import { RuntimeScene } from './scene'

// Raw pixels by hand, same as `export.test.ts`: the scene runs under plain
// Node, so nothing here may reach for a canvas.
function solid(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i)
  return { width, height, data }
}

const sprites: Record<string, SpriteAsset> = {
  rock: { name: 'rock', facings: [solid(4, 6, [255, 0, 0, 255])], widthTiles: 1, heightTiles: 1.5, emissive: false },
}

function scene(width: number, height: number): RuntimeScene {
  return new RuntimeScene(createMap(width, height), { sheet: solid(16, 5, [0, 255, 0, 255]), sprites, textures: {} })
}

describe('full rebuild reconciles chunks', () => {
  it('drops chunks the replaced map had and the new one does not', () => {
    const runtime = scene(36, 36)
    runtime.rebuildAll()

    const wide = allChunkKeys(36, 36).map((key) => `ground/${key}`)
    expect(wide.length).toBe(9)
    const drawnWide = runtime.terrainMeshes().map((mesh) => mesh.userData.chunkKey as string)
    expect(new Set(drawnWide)).toEqual(new Set(wide))

    // The one change no dirty chunk describes: a smaller document swapped in
    // underneath. Keys 1,0 .. 2,2 have no cells any more.
    runtime.setDocument(createMap(6, 6))
    runtime.rebuildAll()

    const drawnSmall = runtime.terrainMeshes().map((mesh) => mesh.userData.chunkKey as string)
    expect(new Set(drawnSmall)).toEqual(new Set(allChunkKeys(6, 6).map((key) => `ground/${key}`)))
    expect(runtime.faceAddressFor(staleMesh('ground/2,2'))).toBeNull()

    // Nothing from the replaced map is still parented, so nothing from it is
    // still drawn or still in the raycast set.
    const reach = runtime.terrainMeshes().flatMap((mesh) => {
      mesh.geometry.computeBoundingBox()
      const box = mesh.geometry.boundingBox
      return box ? [box.max.x, box.max.z] : []
    })
    expect(Math.max(...reach)).toBeLessThanOrEqual(6)
  })

  it('keeps a partial rebuild partial', () => {
    const runtime = scene(36, 36)
    runtime.rebuildAll()
    const before = runtime.terrainMeshes().length

    // A dirty-chunk pass names one key. It must not be read as "only this
    // chunk exists" and sweep the other eight away.
    runtime.rebuild({ chunks: ['ground/1,1'], structures: [] })
    expect(runtime.terrainMeshes().length).toBe(before)
    expect(runtime.stats.chunksBuilt).toBe(1)
  })
})

/** Stands in for a mesh the old map left behind, to prove nothing answers for it. */
function staleMesh(key: string): THREE.Object3D {
  const object = new THREE.Object3D()
  object.userData.chunkKey = key
  object.userData.surface = 'solid'
  object.userData.structureId = 'ground'
  return object
}

describe('the layer view is a section cut: nothing is rebuilt', () => {
  /** A 6 × 6 map with one raised column and a square island on the ground. */
  function level() {
    const doc = createMap(6, 6)
    const g = doc.structures.ground as VoxelStructure
    fillColumn(g, 4, 4, 12)
    const island = createSketch('ground', 'Island', { x: 0, z: 0, yaw: 0 })
    island.points = [
      { x: 0, z: 0, smooth: false },
      { x: 3, z: 0, smooth: false },
      { x: 3, z: 3, smooth: false },
      { x: 0, z: 3, smooth: false },
    ]
    island.closed = true
    island.layers = 6
    doc.structures[island.id] = island
    doc.structureOrder.push(island.id)
    const runtime = new RuntimeScene(doc, { sheet: solid(16, 5, [0, 255, 0, 255]), sprites, textures: {} })
    runtime.rebuildAll()
    return { doc, runtime, island, ground: g }
  }

  it('moves the plane and shows the caps, and leaves every mesh it drew exactly as it was', () => {
    const { runtime, island } = level()
    const before = runtime.terrainMeshes()
    const disposed: THREE.BufferGeometry[] = []
    for (const mesh of before) mesh.geometry.addEventListener('dispose', () => disposed.push(mesh.geometry))
    const solidMaterial = before.find((mesh) => mesh.userData.surface === 'solid')?.material as THREE.Material
    expect(solidMaterial.clippingPlanes).toEqual([runtime.section.plane])
    const caps = () => runtime.scene.getObjectsByProperty('name', '').filter((node) => node.userData.surface === 'section')
    // One cap for the voxel volume, one for the island; hidden while the whole level is drawn, and never a terrain mesh.
    expect(caps().map((cap) => cap.userData.structureId as string).sort()).toEqual(['ground', island.id].sort())
    expect(caps().every((cap) => !cap.visible)).toBe(true)
    expect(before.some((mesh) => mesh.userData.surface === 'section')).toBe(false)

    runtime.setLayerRange({ lo: 2, hi: 6 })
    expect(runtime.terrainMeshes()).toEqual(before)
    expect(disposed).toEqual([])
    expect(runtime.section.ceiling).toBe(6 * HALF)
    expect(runtime.section.plane.constant).toBeCloseTo(6 * HALF, 2)
    expect(caps().every((cap) => cap.visible)).toBe(true)

    runtime.setLayerRange({ lo: 0, hi: 3 })
    expect(runtime.terrainMeshes()).toEqual(before)
    expect(disposed).toEqual([])

    runtime.setLayerRange(null)
    expect(runtime.section.ceiling).toBeNull()
    expect(caps().every((cap) => !cap.visible)).toBe(true)
  })

  it('finds the cap a pick lands on: the top of whatever the ceiling passes through, the highest standing one first', () => {
    const { runtime, island, ground } = level()
    const base = topHeight(ground, 0, 0)
    expect(runtime.capAt(4.5, 4.5)).toBeNull()

    runtime.setLayerRange({ lo: 0, hi: base + 2 })
    // The raised column reaches past the ceiling: its top is the cap there.
    expect(runtime.capAt(4.5, 4.5)).toMatchObject({ structure: 'ground', kind: SURFACE_TOP, x: 4, y: 4 })
    // Flat ground below the ceiling is not cut.
    expect(runtime.capAt(5.5, 1.5)).toBeNull()
    // The island stands on the ground and its cap is above the ceiling: the island, not the ground under it.
    expect(runtime.capAt(1.5, 1.5)).toMatchObject({ structure: island.id, kind: SURFACE_SKETCH_CAP })
  })

  it('a pick straight down into a cut lands on the ceiling, on the cap', () => {
    const { runtime, ground } = level()
    const base = topHeight(ground, 0, 0)
    runtime.setLayerRange({ lo: 0, hi: base + 2 })
    runtime.scene.updateMatrixWorld(true)
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 500)
    camera.position.set(4.5, 40, 4.5)
    camera.lookAt(4.5, 0, 4.5)
    camera.updateMatrixWorld(true)
    const pick = new Picker().pick(runtime, camera, 0, 0)
    expect(pick.surface).toMatchObject({ structure: 'ground', kind: SURFACE_TOP, x: 4, y: 4 })
    expect(pick.point?.y).toBeCloseTo((base + 2) * HALF)

    // With no range, the same ray lands on the column's own top.
    runtime.setLayerRange(null)
    const whole = new Picker().pick(runtime, camera, 0, 0)
    expect(whole.surface).toMatchObject({ kind: SURFACE_TOP, x: 4, y: 4 })
    expect(whole.point?.y).toBeCloseTo(12 * HALF)
  })
})

describe('a structure that moved is re-placed, not remeshed', () => {
  it('moves its group and everything standing on it, and disposes no geometry', () => {
    const doc = createMap(8, 8)
    const island = createSketch('ground', 'Island', { x: 1, z: 1, yaw: 0 })
    island.points = [
      { x: 0, z: 0, smooth: false },
      { x: 3, z: 0, smooth: false },
      { x: 3, z: 3, smooth: false },
    ]
    island.closed = true
    const tier = createSketch(island.id, 'Tier', { x: 1, z: 1, yaw: 0 })
    tier.points = island.points
    tier.closed = true
    for (const s of [island, tier]) {
      doc.structures[s.id] = s
      doc.structureOrder.push(s.id)
    }
    const runtime = new RuntimeScene(doc, { sheet: solid(16, 5, [0, 255, 0, 255]), sprites, textures: {} })
    runtime.rebuildAll()
    const before = runtime.terrainMeshes()
    const disposed: THREE.BufferGeometry[] = []
    for (const mesh of before) mesh.geometry.addEventListener('dispose', () => disposed.push(mesh.geometry))

    island.placement = { x: 4, z: 2, yaw: 1 }
    runtime.rebuild({ chunks: [], structures: [], moved: [island.id, tier.id] })

    expect(runtime.terrainMeshes()).toEqual(before)
    expect(disposed).toEqual([])
    const groupOf = (id: string) => before.find((mesh) => mesh.userData.structureId === id)?.parent
    expect(groupOf(island.id)?.position.x).toBe(4)
    expect(groupOf(island.id)?.rotation.y).toBeCloseTo(-Math.PI / 2)
    // The tier stands on the island, a quarter turn with it.
    expect(groupOf(tier.id)?.rotation.y).toBeCloseTo(-Math.PI / 2)
    expect(groupOf(tier.id)?.position.x).not.toBe(2)
  })
})

describe('bounds of a target', () => {
  it('frames an object or a structure of any kind, and answers null for what is not in the scene', () => {
    const doc = createMap(6, 6)
    const island = createSketch('ground', 'Island', { x: 1, z: 1, yaw: 0 })
    island.points = [
      { x: 0, z: 0, smooth: false },
      { x: 2, z: 0, smooth: false },
      { x: 2, z: 2, smooth: false },
      { x: 0, z: 2, smooth: false },
    ]
    island.closed = true
    island.layers = 2
    doc.structures[island.id] = island
    doc.structureOrder.push(island.id)
    const runtime = new RuntimeScene(doc, { sheet: solid(16, 5, [0, 255, 0, 255]), sprites, textures: {} })
    runtime.rebuildAll()

    const ground = runtime.boundsOf({ kind: 'structure', id: 'ground' })
    expect(ground?.min.x).toBeCloseTo(0)
    expect(ground?.max.x).toBeCloseTo(6)
    // The default wall flares out at its base, so the box is a little wider than the outline, centred on it.
    const sketch = runtime.boundsOf({ kind: 'structure', id: island.id })
    expect(((sketch?.min.x ?? 0) + (sketch?.max.x ?? 0)) / 2).toBeCloseTo(2)
    expect(sketch?.min.x).toBeLessThan(1)
    expect(sketch?.max.x).toBeGreaterThan(3)
    expect((sketch?.max.y ?? 0) - (sketch?.min.y ?? 0)).toBeCloseTo(2 * HALF, 1)
    expect(runtime.boundsOf({ kind: 'structure', id: 'nope' })).toBeNull()
    expect(runtime.boundsOf({ kind: 'object', id: 'nope' })).toBeNull()
  })
})

describe('textures the scene no longer draws with go back to the GPU', () => {
  /** How many times each image's texture has been disposed, watched from its first creation. */
  function watch(...images: RgbaImage[]) {
    const counts = new Map<RgbaImage, number>(images.map((image) => [image, 0]))
    for (const image of images) rgbaTexture(image, true).addEventListener('dispose', () => counts.set(image, (counts.get(image) ?? 0) + 1))
    return counts
  }

  it('releases the old sheet when a new one replaces it — as every document load does — and keeps a sheet handed in again', () => {
    const first = solid(16, 5, [0, 255, 0, 255])
    const second = solid(16, 5, [0, 0, 255, 255])
    const runtime = new RuntimeScene(createMap(4, 4), { sheet: first, sprites, textures: {} })
    const disposed = watch(first, second)

    runtime.refreshSheet(first)
    expect(disposed.get(first)).toBe(0)
    runtime.refreshSheet(second)
    expect(disposed.get(first)).toBe(1)
    expect(disposed.get(second)).toBe(0)
    // The released image is forgotten: asking again makes a fresh texture rather than handing back the disposed one.
    expect(rgbaTexture(first, true)).not.toBe(undefined)
  })

  it('releases the images a new sprite set dropped, and only those', () => {
    const kept = sprites.rock
    const tree: SpriteAsset = { name: 'tree', facings: [solid(4, 6, [0, 128, 0, 255])], widthTiles: 1, heightTiles: 2, emissive: false }
    const runtime = new RuntimeScene(createMap(4, 4), { sheet: solid(16, 5, [0, 255, 0, 255]), sprites: { rock: kept }, textures: {} })
    const disposed = watch(kept.facings[0], tree.facings[0])

    runtime.setSprites({ rock: kept, tree })
    expect(disposed.get(kept.facings[0])).toBe(0)
    runtime.setSprites({ tree })
    expect(disposed.get(kept.facings[0])).toBe(1)
    expect(disposed.get(tree.facings[0])).toBe(0)
  })
})
