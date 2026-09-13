/**
 * The layer view's range and colours: the heights the artist narrowed the view
 * to (the slicer-style slider on the stage's right edge —
 * `docs/design/select-first.html`), what a cut cap and what lies under the
 * floor are drawn in, and which objects the range shows.
 *
 * A VIEW of the document, not a change to it. It is drawn by `section.ts` on
 * the GPU; nothing here rewrites a height.
 */

export interface LayerRange {
  /** Lowest height shown, in half-tiles. */
  readonly lo: number
  /** Highest height shown, in half-tiles; columns above it are cut here. */
  readonly hi: number
}

/** What a cut shows where it opened a solid: cooler and lighter, so it reads as "there is more above". */
export const CUT_TINT = 0x9aa4b8
/** What lies under the floor is darkened by this: context rather than subject. */
export const GHOST_TINT = 0x2a2f3a

/** Whether a world-space height (an object's base) is inside the range. */
export function withinLayers(range: LayerRange | null, worldY: number, half: number): boolean {
  if (range === null) return true
  const halfTiles = worldY / half
  return halfTiles >= range.lo && halfTiles <= range.hi
}
