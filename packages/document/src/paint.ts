/**
 * Paint addressing — the most important data decision in the project.
 *
 * THE INVARIANT
 * -------------
 * Paint is addressed in stable grid coordinates that describe *where on the
 * map* a surface is, never *which triangle* it came out as. Concretely:
 *
 *   - terrain tops are keyed by cell:                 (x, y)
 *   - cliff faces are keyed by cell, side and level:  (x, y, dir, level)
 *   - tint is keyed by cell:                          (x, y)
 *
 * `level` is the ABSOLUTE half-tile level of the face band, measured from
 * world zero. It is deliberately not a row index counted from the top or the
 * bottom of the cliff, and deliberately not a row of the swept profile.
 *
 * Why that matters, in two cases the brief raises:
 *
 *   Sculpting. Lower a cliff from 8 half-tiles to 5 and the bands at levels
 *   5, 6 and 7 stop being meshed. Their paint stays in the record, dormant.
 *   Raise it back and the same keys resolve again, so the artist's work
 *   reappears instead of having been quietly destroyed.
 *
 *   Profile strips (brief section 5). If a cliff's cross-section silhouette
 *   is swept along the edge, changing the profile changes how the band is
 *   *shaped*, and could change how many triangles it takes, but it does not
 *   change which absolute levels exist. Indexing by level keeps the profile a
 *   purely geometric concern that can never scramble paint. Had we indexed by
 *   profile row, editing the silhouette would shuffle every painted face.
 *
 * The dormancy mechanism needs no code at all. It works because NOTHING ever
 * deletes paint on a sculpt operation. Sculpt commands touch `terrain.*` and
 * never `paint.*`. If you find yourself writing a cleanup pass that prunes
 * "orphaned" paint, that is this invariant being broken.
 *
 * Layer order when the mesher resolves a surface's appearance:
 *
 *   1. the template's automatic default (from the cell material + autotiling)
 *   2. the painted override in these records
 *   3. fixtures on top (buildings; not in the prototype slice)
 */

import type { Direction, PaintLayers } from './document'

export function topKey(x: number, y: number): string {
  return `${x},${y}`
}

export function tintKey(x: number, y: number): string {
  return `${x},${y}`
}

export function cliffKey(x: number, y: number, dir: number, level: number): string {
  return `${x},${y},${dir},${level}`
}

export function parseCliffKey(key: string): {
  x: number
  y: number
  dir: Direction
  level: number
} {
  const [x, y, dir, level] = key.split(',').map(Number)
  return { x, y, dir: dir as Direction, level }
}

/** Undefined means "no override" — fall through to the template default. */
export function topPaint(paint: PaintLayers, x: number, y: number): number | undefined {
  return paint.top[topKey(x, y)]
}

export function cliffPaint(
  paint: PaintLayers,
  x: number,
  y: number,
  dir: number,
  level: number,
): number | undefined {
  return paint.cliff[cliffKey(x, y, dir, level)]
}

export function tintPaint(paint: PaintLayers, x: number, y: number): number | undefined {
  return paint.tint[tintKey(x, y)]
}

/**
 * Diagnostic only. Counts paint entries that address surfaces which do not
 * currently exist — i.e. dormant work that would come back if the geometry
 * were restored. Shown in the editor's status bar so the artist can see that
 * their painting is being preserved rather than lost.
 *
 * This function must never be used to decide what to delete.
 */
export function countDormant(
  paint: PaintLayers,
  surfaceExists: (kind: 'top' | 'cliff', key: string) => boolean,
): { top: number; cliff: number } {
  let top = 0
  let cliff = 0
  for (const key of Object.keys(paint.top)) if (!surfaceExists('top', key)) top += 1
  for (const key of Object.keys(paint.cliff)) if (!surfaceExists('cliff', key)) cliff += 1
  return { top, cliff }
}
