/**
 * Spike: is TypeScript meshing fast enough while brushing?
 *
 * The number that matters is not the whole map, it is one brush tick. A stroke
 * dirties the 3x3 neighbourhood of chunks around the cursor, and that work has
 * to fit comfortably inside a 16.7 ms frame. Whole-map timings only matter for
 * load and for the "convert to blocks" style bulk operations.
 *
 * Run with `npm run bench`.
 */
import { bench, describe } from 'vitest'

import { allChunkKeys } from '../chunks'
import { cellIndex, createMap, type MapDoc } from '../document'
import { meshTerrainChunk } from './terrain'

function hilly(width: number, height: number): MapDoc {
  const doc = createMap(width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = cellIndex(doc.size, x, y)
      const h =
        4 +
        Math.round(3 * Math.sin(x * 0.22) + 3 * Math.cos(y * 0.19) + 2 * Math.sin((x + y) * 0.11))
      doc.terrain.height[index] = Math.max(0, h)
      doc.terrain.material[index] = (x + y) % 4
    }
  }
  return doc
}

const map128 = hilly(128, 128)
const keys128 = allChunkKeys(128, 128)
const middle = keys128[Math.floor(keys128.length / 2)]

// The 3x3 neighbourhood a brush tick actually dirties.
const brushChunks = ['3,3', '4,3', '5,3', '3,4', '4,4', '5,4', '3,5', '4,5', '5,5']

describe('terrain mesher', () => {
  bench('one chunk (16x16 cells), hilly', () => {
    meshTerrainChunk(map128, middle)
  })

  bench('one brush tick (9 chunks)', () => {
    for (const key of brushChunks) meshTerrainChunk(map128, key)
  })

  bench('whole 128x128 map (64 chunks)', () => {
    for (const key of keys128) meshTerrainChunk(map128, key)
  })
})
