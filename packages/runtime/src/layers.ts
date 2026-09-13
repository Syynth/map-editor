/**
 * The layer view: the document as the viewport draws it while the artist has
 * narrowed the height range they are looking at (the slicer-style slider on
 * the stage's right edge — `docs/design/select-first.html`).
 *
 * A VIEW of the document, not a change to it: heights above the ceiling are
 * clamped to it, so the mesher draws a cap where a column was cut and the
 * cliff rules produce its sides for free; water over the ceiling is dropped;
 * and a cut cap or a column entirely under the floor is tinted through the
 * paint layer the mesher already reads, so no shader learns what a layer is.
 * The copy is one pass over the height and water arrays per rebuild, which
 * the chunk mesher dwarfs.
 */

import { NO_WATER, cellIndex, tintKey, type ReadonlyVoxel } from '@papercut/document'

export interface LayerRange {
  /** Lowest height shown, in half-tiles. */
  readonly lo: number
  /** Highest height shown, in half-tiles; columns above it are cut here. */
  readonly hi: number
}

/** The cap of a cut column: cooler and lighter, so it reads as "there is more above". */
export const CUT_TINT = 0x9aa4b8
/** A column wholly under the floor: dark, so it reads as context rather than subject. */
export const GHOST_TINT = 0x2a2f3a

export function layerView(voxel: ReadonlyVoxel, range: LayerRange | null): ReadonlyVoxel {
  if (range === null) return voxel
  const heights = voxel.terrain.height.slice()
  const water = voxel.terrain.water.slice()
  const tint: Record<string, number> = { ...voxel.paint.tint }
  for (let y = 0; y < voxel.size.height; y++) {
    for (let x = 0; x < voxel.size.width; x++) {
      const index = cellIndex(voxel.size, x, y)
      const height = heights[index]
      if (height > range.hi) {
        heights[index] = range.hi
        tint[tintKey(x, y)] = CUT_TINT
      } else if (height < range.lo) {
        tint[tintKey(x, y)] = GHOST_TINT
      }
      if (water[index] !== NO_WATER && water[index] > range.hi) water[index] = NO_WATER
    }
  }
  return { ...voxel, terrain: { ...voxel.terrain, height: heights, water }, paint: { ...voxel.paint, tint } }
}

/** Whether a world-space height (an object's base) is inside the range. */
export function withinLayers(range: LayerRange | null, worldY: number, half: number): boolean {
  if (range === null) return true
  const halfTiles = worldY / half
  return halfTiles >= range.lo && halfTiles <= range.hi
}
