import { describe, expect, it } from 'vitest'

import { NO_WATER, cellIndex, createMap, type MapDoc } from './document'
import { flatten, raise, setWater } from './ops'
import type { Patch } from './edits'
import type { VoxelStructure } from './structure'

/**
 * Water is a surface over the terrain and never level with it (ruling of
 * 2026-09-12): the height ops clear it the moment the ground reaches the
 * line, and the water ops refuse to write a line the ground already meets.
 */

const ground = (doc: MapDoc) => doc.structures.ground as VoxelStructure

const apply = (doc: MapDoc, patches: Patch[]) => {
  const voxel = ground(doc)
  for (const patch of patches) {
    if (patch.t !== 'voxel') continue
    if (patch.field === 'height') voxel.terrain.height[patch.index] = patch.value
    if (patch.field === 'water') voxel.terrain.water[patch.index] = patch.value
  }
}

describe('water bound to the heightmap', () => {
  it('raising a column to its water line drains it in the same edit', () => {
    const doc = createMap(4, 4)
    const voxel = ground(doc)
    const index = cellIndex(voxel.size, 1, 1)
    voxel.terrain.height[index] = 1
    voxel.terrain.water[index] = 3
    apply(doc, raise(doc, voxel, [[1, 1]], 1))
    expect(voxel.terrain.water[index]).toBe(3)
    apply(doc, raise(doc, voxel, [[1, 1]], 1))
    expect(voxel.terrain.height[index]).toBe(3)
    expect(voxel.terrain.water[index]).toBe(NO_WATER)
  })

  it('flattening above the line drains; flattening below it keeps the water', () => {
    const doc = createMap(4, 4)
    const voxel = ground(doc)
    const index = cellIndex(voxel.size, 2, 2)
    voxel.terrain.height[index] = 1
    voxel.terrain.water[index] = 3
    apply(doc, flatten(doc, voxel, [[2, 2]], 2))
    expect(voxel.terrain.water[index]).toBe(3)
    apply(doc, flatten(doc, voxel, [[2, 2]], 5))
    expect(voxel.terrain.water[index]).toBe(NO_WATER)
  })

  it('setWater refuses a line at or below the ground and leaves the cell untouched', () => {
    const doc = createMap(4, 4)
    const voxel = ground(doc)
    const index = cellIndex(voxel.size, 0, 0)
    voxel.terrain.height[index] = 2
    expect(setWater(voxel, [[0, 0]], 2)).toEqual([])
    expect(setWater(voxel, [[0, 0]], 1)).toEqual([])
    expect(setWater(voxel, [[0, 0]], 3)).toHaveLength(1)
    // Clearing is always allowed.
    expect(setWater(voxel, [[0, 0]], null)).toHaveLength(1)
  })
})
