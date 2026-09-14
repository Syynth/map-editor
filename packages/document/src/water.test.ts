import { describe, expect, it } from 'vitest'

import { NO_WATER, cellIndex, createMap, type MapDoc } from './document'
import { applyPatches } from './edits'
import { flatten, raise, setWater } from './ops'
import type { VoxelStructure } from './structure'
import { fillColumn, topHeight } from './voxels'

/**
 * Water is a surface over the terrain and never level with it (ruling of
 * 2026-09-12): the height ops clear it the moment the ground reaches the
 * line, and the water ops refuse to write a line the ground already meets.
 * The ground is a column of voxels now; its "height" is the derived top.
 */

const ground = (doc: MapDoc) => doc.structures.ground as VoxelStructure

describe('water bound to the column tops', () => {
  it('raising a column to its water line drains it in the same edit', () => {
    const doc = createMap(4, 4)
    const voxel = ground(doc)
    const index = cellIndex(voxel.size, 1, 1)
    fillColumn(voxel, 1, 1, 1)
    voxel.water[index] = 3
    applyPatches(doc, raise(doc, voxel, [[1, 1]], 1))
    expect(voxel.water[index]).toBe(3)
    applyPatches(doc, raise(doc, voxel, [[1, 1]], 1))
    expect(topHeight(voxel, 1, 1)).toBe(3)
    expect(voxel.water[index]).toBe(NO_WATER)
  })

  it('flattening above the line drains; flattening below it keeps the water', () => {
    const doc = createMap(4, 4)
    const voxel = ground(doc)
    const index = cellIndex(voxel.size, 2, 2)
    fillColumn(voxel, 2, 2, 1)
    voxel.water[index] = 3
    applyPatches(doc, flatten(doc, voxel, [[2, 2]], 2))
    expect(voxel.water[index]).toBe(3)
    applyPatches(doc, flatten(doc, voxel, [[2, 2]], 5))
    expect(voxel.water[index]).toBe(NO_WATER)
  })

  it('setWater refuses a line at or below the ground and leaves the cell untouched', () => {
    const doc = createMap(4, 4)
    const voxel = ground(doc)
    fillColumn(voxel, 0, 0, 2)
    expect(setWater(voxel, [[0, 0]], 2)).toEqual([])
    expect(setWater(voxel, [[0, 0]], 1)).toEqual([])
    expect(setWater(voxel, [[0, 0]], 3)).toHaveLength(1)
    // Clearing is always allowed.
    expect(setWater(voxel, [[0, 0]], null)).toHaveLength(1)
  })
})
