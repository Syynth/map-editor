import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { allChunkKeys, createMap, type RgbaImage, type SpriteAsset } from '@map-editor/document'
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
  return new RuntimeScene(createMap(width, height), { sheet: solid(16, 5, [0, 255, 0, 255]), sprites })
}

describe('full rebuild reconciles chunks', () => {
  it('drops chunks the replaced map had and the new one does not', () => {
    const runtime = scene(36, 36)
    runtime.rebuildChunks()

    const wide = allChunkKeys(36, 36)
    expect(wide.length).toBe(9)
    const drawnWide = runtime.terrainMeshes().map((mesh) => mesh.userData.chunkKey as string)
    expect(new Set(drawnWide)).toEqual(new Set(wide))

    // The one change no dirty chunk describes: a smaller document swapped in
    // underneath. Keys 1,0 .. 2,2 have no cells any more.
    runtime.setDocument(createMap(6, 6))
    runtime.rebuildChunks()

    const drawnSmall = runtime.terrainMeshes().map((mesh) => mesh.userData.chunkKey as string)
    expect(new Set(drawnSmall)).toEqual(new Set(allChunkKeys(6, 6)))
    expect(runtime.faceAddressFor(staleMesh('2,2'))).toBeNull()

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
    runtime.rebuildChunks()
    const before = runtime.terrainMeshes().length

    // A dirty-chunk pass names one key. It must not be read as "only this
    // chunk exists" and sweep the other eight away.
    runtime.rebuildChunks(['1,1'])
    expect(runtime.terrainMeshes().length).toBe(before)
    expect(runtime.stats.chunksBuilt).toBe(1)
  })
})

/** Stands in for a mesh the old map left behind, to prove nothing answers for it. */
function staleMesh(key: string): THREE.Object3D {
  const object = new THREE.Object3D()
  object.userData.chunkKey = key
  object.userData.surface = 'solid'
  return object
}
