/**
 * Autotiling: which of a cell's four neighbours continue the same surface.
 *
 * A neighbour counts when it has the same material at the same height, or
 * when it lies outside the volume — the border is treated as continuing so
 * the edge of a volume reads as ground running on, not as a cliff-top rim.
 */

import { DIR_VECTORS, cellIndex, inBounds } from './document'
import type { ReadonlyVoxel } from './structure'

export const MASK_NORTH = 1
export const MASK_EAST = 2
export const MASK_SOUTH = 4
export const MASK_WEST = 8

const DIR_TO_BIT = [MASK_EAST, MASK_SOUTH, MASK_WEST, MASK_NORTH]

export function autotileMask(voxel: ReadonlyVoxel, x: number, y: number): number {
  const index = cellIndex(voxel.size, x, y)
  const material = voxel.terrain.material[index]
  const height = voxel.terrain.height[index]
  let mask = 0
  for (let dir = 0; dir < 4; dir++) {
    const [dx, dy] = DIR_VECTORS[dir]
    const nx = x + dx
    const ny = y + dy
    if (!inBounds(voxel.size, nx, ny)) {
      mask |= DIR_TO_BIT[dir]
      continue
    }
    const neighbour = cellIndex(voxel.size, nx, ny)
    const sameMaterial = voxel.terrain.material[neighbour] === material
    const sameHeight = voxel.terrain.height[neighbour] === height
    if (sameMaterial && sameHeight) mask |= DIR_TO_BIT[dir]
  }
  return mask
}
