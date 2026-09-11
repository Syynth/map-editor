/**
 * Autotiling for terrain tops.
 *
 * A 4-bit edge mask: a neighbour counts as connected when it shares the cell's
 * material AND sits at the same height. Height matters because a grass cell
 * two tiles above its grass neighbour is across a cliff, not continuous with
 * it, and should get an edge tile.
 *
 * Off-map neighbours count as connected, so the map border does not draw a
 * ring of edge tiles around the whole level.
 */

import { DIR_VECTORS, cellIndex, inBounds, type MapDoc } from './document'

export const MASK_NORTH = 1
export const MASK_EAST = 2
export const MASK_SOUTH = 4
export const MASK_WEST = 8

/** Direction index -> mask bit. DIR_VECTORS order is E, S, W, N. */
const DIR_TO_BIT = [MASK_EAST, MASK_SOUTH, MASK_WEST, MASK_NORTH]

export function autotileMask(doc: MapDoc, x: number, y: number): number {
  const index = cellIndex(doc.size, x, y)
  const material = doc.terrain.material[index]
  const height = doc.terrain.height[index]

  let mask = 0
  for (let dir = 0; dir < 4; dir++) {
    const [dx, dy] = DIR_VECTORS[dir]
    const nx = x + dx
    const ny = y + dy

    if (!inBounds(doc.size, nx, ny)) {
      mask |= DIR_TO_BIT[dir]
      continue
    }

    const neighbour = cellIndex(doc.size, nx, ny)
    const sameMaterial = doc.terrain.material[neighbour] === material
    const sameHeight = doc.terrain.height[neighbour] === height
    if (sameMaterial && sameHeight) mask |= DIR_TO_BIT[dir]
  }
  return mask
}
