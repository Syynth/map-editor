import { describe, expect, it } from 'vitest'

import { NO_WATER, cellIndex, createMap } from './document'
import { flatten, raise, setWater } from './ops'
import type { Patch } from './edits'

/**
 * Water is a surface over the terrain and never level with it (ruling of
 * 2026-09-12): the height ops clear it the moment the ground reaches the
 * line, and the water ops refuse to write a line the ground already meets.
 */

const apply = (doc: ReturnType<typeof createMap>, patches: Patch[]) => {
  for (const patch of patches) {
    if (patch.t !== 'terrain') continue
    if (patch.field === 'height') doc.terrain.height[patch.index] = patch.value
    if (patch.field === 'water') doc.terrain.water[patch.index] = patch.value
  }
}

describe('water bound to the heightmap', () => {
  it('raising a column to its water line drains it in the same edit', () => {
    const doc = createMap(4, 4)
    const index = cellIndex(doc.size, 1, 1)
    doc.terrain.height[index] = 1
    doc.terrain.water[index] = 3
    apply(doc, raise(doc, [[1, 1]], 1))
    expect(doc.terrain.water[index]).toBe(3)
    apply(doc, raise(doc, [[1, 1]], 1))
    expect(doc.terrain.height[index]).toBe(3)
    expect(doc.terrain.water[index]).toBe(NO_WATER)
  })

  it('flattening above the line drains; flattening below it keeps the water', () => {
    const doc = createMap(4, 4)
    const index = cellIndex(doc.size, 2, 2)
    doc.terrain.height[index] = 1
    doc.terrain.water[index] = 3
    apply(doc, flatten(doc, [[2, 2]], 2))
    expect(doc.terrain.water[index]).toBe(3)
    apply(doc, flatten(doc, [[2, 2]], 5))
    expect(doc.terrain.water[index]).toBe(NO_WATER)
  })

  it('setWater refuses a line at or below the ground and leaves the cell untouched', () => {
    const doc = createMap(4, 4)
    const index = cellIndex(doc.size, 0, 0)
    doc.terrain.height[index] = 2
    expect(setWater(doc, [[0, 0]], 2)).toEqual([])
    expect(setWater(doc, [[0, 0]], 1)).toEqual([])
    expect(setWater(doc, [[0, 0]], 3)).toHaveLength(1)
    // Clearing is always allowed.
    expect(setWater(doc, [[0, 0]], null)).toHaveLength(1)
  })
})
