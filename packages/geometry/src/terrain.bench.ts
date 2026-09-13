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
import { describe, test } from 'vitest'

import {
  allChunkKeys,
  cellIndex,
  createMap,
  type MapDoc,
  type ReadonlyMapDoc,
  type VoxelStructure,
} from '@papercut/document'
import { meshTerrainChunk } from './terrain'

/** The root voxel volume a fresh level has, mutable for setup: `createMap` names it `ground`. */
const ground = (doc: ReadonlyMapDoc | MapDoc): VoxelStructure => doc.structures.ground as VoxelStructure


function hilly(width: number, height: number): MapDoc {
  const doc = createMap(width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = cellIndex(ground(doc).size, x, y)
      const h =
        4 +
        Math.round(3 * Math.sin(x * 0.22) + 3 * Math.cos(y * 0.19) + 2 * Math.sin((x + y) * 0.11))
      ground(doc).terrain.height[index] = Math.max(0, h)
      ground(doc).terrain.material[index] = (x + y) % 4
    }
  }
  return doc
}

const map128 = hilly(128, 128)
const keys128 = allChunkKeys(128, 128)
const middle = keys128[Math.floor(keys128.length / 2)]

// The 3x3 neighbourhood a brush tick actually dirties.
const brushChunks = ['3,3', '4,3', '5,3', '3,4', '4,4', '5,4', '3,5', '4,5', '5,5']

// Vitest 5 moved `bench` off the module exports and onto the test context: a
// benchmark is now a registration you await inside a test, so each timing below
// is one test that reports a benchmark rather than a top-level `bench()` call.
//
// Read the numbers as an upper bound, not a clean measurement. Vitest 5 prints a
// "accessed module export getters too many times" warning for all three cases
// here (tracking `cellIndex`, `inBounds`, `HALF`, `DIR_VECTORS` and friends from
// packages/document/src/document.ts): under the module runner every cross-module
// import is a getter call, and the mesher reads those in its innermost loops. The
// overhead is the harness's, not the mesher's, so real runtime work is somewhat
// faster than what prints. We do not suppress the warning — see
// https://vitest.dev/guide/benchmarking#module-runner-overhead. What the numbers
// are still good for is the comparison that matters: brush tick vs. 16.7 ms, and
// this run vs. the last one.
describe('terrain mesher', () => {
  test('one chunk (16x16 cells), hilly', async ({ bench }) => {
    await bench('one chunk (16x16 cells), hilly', () => {
      meshTerrainChunk(map128, ground(map128), middle)
    }).run()
  })

  test('one brush tick (9 chunks)', async ({ bench }) => {
    await bench('one brush tick (9 chunks)', () => {
      for (const key of brushChunks) meshTerrainChunk(map128, ground(map128), key)
    }).run()
  })

  test('whole 128x128 map (64 chunks)', async ({ bench }) => {
    await bench('whole 128x128 map (64 chunks)', () => {
      for (const key of keys128) meshTerrainChunk(map128, ground(map128), key)
    }).run()
  })
})
