/**
 * Snapping, one convention for everything that moves (ruling of 2026-09-12,
 * "Select tool"): to the cell grid by default, to half cells, or not at all —
 * free positions are still rounded to a hundredth so a saved file stays
 * readable. A modifier held during a drag makes one drag free without
 * changing the setting.
 */

export type SnapMode = 'grid' | 'half' | 'free'

/**
 * What the grid means for the thing being snapped: a structure's placement
 * and a sketch's points trace cell CORNERS, while an object — a cell-sized
 * sprite — stands in a cell's CENTRE, so a tree snapped to the grid lands in
 * the middle of a tile, not on the line between two. Half-cell snapping is
 * the same lattice either way.
 */
export type SnapAnchor = 'corner' | 'centre'

export function snapTo(value: number, snap: SnapMode, anchor: SnapAnchor = 'corner'): number {
  if (snap === 'free') return Math.round(value * 100) / 100
  if (snap === 'half') return Math.round(value * 2) / 2
  return anchor === 'centre' ? Math.floor(value) + 0.5 : Math.round(value)
}
