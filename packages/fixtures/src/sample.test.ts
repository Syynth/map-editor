import { describe, expect, it } from 'vitest'

import { DIR_VECTORS, NO_RAMP, RAMP_LOW_CORNERS, cornerHeights, rampDirAt, topHeight, type VoxelStructure } from '@papercut/document'

import { createSampleMap } from './sample'

describe('the sample map', () => {
  it('cuts every ramp so that it meets the ground it descends to', () => {
    const doc = createSampleMap()
    const ground = doc.structures.ground as VoxelStructure
    let ramps = 0
    for (let y = 0; y < ground.size.height; y++) {
      for (let x = 0; x < ground.size.width; x++) {
        const dir = rampDirAt(ground, x, y)
        if (dir === NO_RAMP) continue
        ramps += 1
        const [dx, dy] = DIR_VECTORS[dir]
        const corners = cornerHeights(ground, x, y)
        // The two low corners sit exactly on the neighbour's top, and the high side is the plateau.
        for (const corner of RAMP_LOW_CORNERS[dir]) expect(corners[corner]).toBe(topHeight(ground, x + dx, y + dy))
        expect(Math.max(...corners)).toBe(topHeight(ground, x, y))
      }
    }
    expect(ramps).toBeGreaterThan(0)
  })
})
