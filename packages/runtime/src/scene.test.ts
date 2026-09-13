import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { HALF, allChunkKeys, createMap, createSketch, frameOf, type RgbaImage, type SpriteAsset } from '@papercut/document'
import { CUT_TINT, GHOST_TINT } from './layers'
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

describe('the layer view slices a sketch', () => {
  function withIsland(layers: number) {
    const doc = createMap(6, 6)
    const island = createSketch('ground', 'Island', { x: 1, z: 1, yaw: 0 })
    island.points = [
      { x: 0, z: 0, smooth: false },
      { x: 3, z: 0, smooth: false },
      { x: 3, z: 3, smooth: false },
      { x: 0, z: 3, smooth: false },
    ]
    island.closed = true
    island.layers = layers
    doc.structures[island.id] = island
    doc.structureOrder.push(island.id)
    const runtime = new RuntimeScene(doc, { sheet: solid(16, 5, [0, 255, 0, 255]), sprites, textures: {} })
    const parts = () => runtime.terrainMeshes().filter((mesh) => mesh.userData.structureId === island.id)
    const part = (name: string) => parts().find((mesh) => mesh.userData.part === name)
    return { runtime, base: frameOf(doc, island.id).y, parts, part }
  }
  const ys = (mesh: THREE.Mesh) => Array.from(mesh.geometry.getAttribute('position').array).filter((_, i) => i % 3 === 1)
  const firstColour = (mesh: THREE.Mesh) => {
    const c = mesh.geometry.getAttribute('color').array
    return ((Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255)) >>> 0
  }

  it('at its full height a sketch is whole and untinted', () => {
    const { runtime, part } = withIsland(4)
    runtime.rebuildAll()
    // Parts are meshed in the sketch's own frame; the group lifts them to its base.
    expect(Math.max(...ys(part('cap') as THREE.Mesh))).toBeCloseTo(4 * HALF)
    expect(firstColour(part('cap') as THREE.Mesh)).toBe(0xffffff)
  })

  it('a ceiling through the sketch slices it there and tints the cut face', () => {
    const { runtime, base, part } = withIsland(4)
    const baseLayers = Math.round(base / HALF)
    runtime.setLayerRange({ lo: 0, hi: baseLayers + 2 })
    runtime.rebuildAll()
    expect(Math.max(...ys(part('cap') as THREE.Mesh))).toBeCloseTo(2 * HALF)
    expect(Math.max(...ys(part('wallBody') as THREE.Mesh))).toBeCloseTo(2 * HALF)
    expect(firstColour(part('cap') as THREE.Mesh)).toBe(CUT_TINT)
    expect(firstColour(part('wallBody') as THREE.Mesh)).toBe(0xffffff)
  })

  it('a ceiling under the sketch hides it; a floor above it ghosts it', () => {
    const { runtime, base, parts, part } = withIsland(4)
    const baseLayers = Math.round(base / HALF)
    runtime.setLayerRange({ lo: 0, hi: baseLayers })
    runtime.rebuildAll()
    expect(parts()).toEqual([])
    runtime.setLayerRange({ lo: baseLayers + 5, hi: baseLayers + 9 })
    runtime.rebuildAll()
    expect(firstColour(part('cap') as THREE.Mesh)).toBe(GHOST_TINT)
    expect(firstColour(part('wallBody') as THREE.Mesh)).toBe(GHOST_TINT)
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
