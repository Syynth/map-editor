/**
 * Terrain geometry queries shared by the mesher, object grounding and the
 * play-mode character controller. One definition of "how high is the ground
 * here", so a character never walks through a slope the mesher drew.
 */

import { HALF, NO_RAMP, cellIndex, inBounds, type ReadonlyMapDoc } from './document'

/** Corner order for a cell: c00, c01, c11, c10 (matching the mesher's quad). */
export const CORNER_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
]

/** Corners on the descending side of a ramp, by ramp direction. */
export const RAMP_LOW_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [3, 2],
  [1, 2],
  [0, 1],
  [3, 0],
]

/** A ramp drops one full tile, which is two half-tile units. */
export const RAMP_DROP = 2

/** The four corner heights of a cell, in half-tile units. */
export function cornerHeights(doc: ReadonlyMapDoc, x: number, y: number): [number, number, number, number] {
  const index = cellIndex(doc.size, x, y)
  const h = doc.terrain.height[index]
  const corners: [number, number, number, number] = [h, h, h, h]
  const ramp = doc.terrain.ramp[index]
  if (ramp !== NO_RAMP) {
    for (const corner of RAMP_LOW_CORNERS[ramp]) corners[corner] = h - RAMP_DROP
  }
  return corners
}

/**
 * World-space ground height at an arbitrary point, interpolated across the
 * cell so ramps are continuous rather than stepped.
 */
export function groundHeight(doc: ReadonlyMapDoc, worldX: number, worldZ: number): number {
  const cx = Math.floor(worldX)
  const cy = Math.floor(worldZ)
  if (!inBounds(doc.size, cx, cy)) return 0

  const [c00, c01, c11, c10] = cornerHeights(doc, cx, cy)
  const fx = worldX - cx
  const fz = worldZ - cy

  // Bilinear across the cell. c00 at (0,0), c10 at (1,0), c01 at (0,1), c11 at (1,1).
  const north = c00 + (c10 - c00) * fx
  const south = c01 + (c11 - c01) * fx
  return (north + (south - north) * fz) * HALF
}

/** Centre of a cell in world space, sitting on the surface. */
export function cellCentreWorld(doc: ReadonlyMapDoc, x: number, y: number): [number, number, number] {
  return [x + 0.5, groundHeight(doc, x + 0.5, y + 0.5), y + 0.5]
}
