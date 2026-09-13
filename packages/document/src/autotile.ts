/**
 * Autotiling: which of a cell's four neighbours continue the same surface.
 *
 * A neighbour counts when it has the same material at the same height, or
 * when it lies outside the volume — the border is treated as continuing so
 * the edge of a volume reads as ground running on, not as a cliff-top rim.
 */

import { DIR_VECTORS, inBounds } from './document'
import type { ReadonlyVoxel } from './structure'
import { materialAt, topHeight } from './voxels'

export const MASK_NORTH = 1
export const MASK_EAST = 2
export const MASK_SOUTH = 4
export const MASK_WEST = 8

const DIR_TO_BIT = [MASK_EAST, MASK_SOUTH, MASK_WEST, MASK_NORTH]

export function autotileMask(voxel: ReadonlyVoxel, x: number, y: number): number {
  const material = materialAt(voxel, x, y)
  const height = topHeight(voxel, x, y)
  let mask = 0
  for (let dir = 0; dir < 4; dir++) {
    const [dx, dy] = DIR_VECTORS[dir]
    const nx = x + dx
    const ny = y + dy
    if (!inBounds(voxel.size, nx, ny)) {
      mask |= DIR_TO_BIT[dir]
      continue
    }
    const sameMaterial = materialAt(voxel, nx, ny) === material
    const sameHeight = topHeight(voxel, nx, ny) === height
    if (sameMaterial && sameHeight) mask |= DIR_TO_BIT[dir]
  }
  return mask
}
