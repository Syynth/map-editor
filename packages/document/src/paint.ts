/**
 * Paint addressing — the most important data decision in the project.
 *
 * THE INVARIANT
 * -------------
 * Paint is addressed in stable grid coordinates that describe *where on the
 * map* a surface is, never *which triangle* it came out as. Concretely:
 *
 *   - a face override is keyed by voxel and side:  (x, z, y, dir)
 *   - tint is keyed by cell:                        (x, z)
 *
 * `y` is the LAYER of the voxel the face belongs to and `dir` its side: 0–3
 * east, south, west, north, `FACE_TOP` and `FACE_BOTTOM`. It is deliberately
 * not a row index counted from the top or the bottom of a cliff, and
 * deliberately not a triangle.
 *
 * Why that matters, in two cases the brief raises:
 *
 *   Sculpting. Lower a cliff and the faces of the voxels that went stop
 *   being meshed. Their overrides stay in the record, dormant. Raise it back
 *   and the same keys resolve again, so the artist's work reappears instead
 *   of having been quietly destroyed.
 *
 *   Profile strips (brief section 5). If a cliff's cross-section silhouette
 *   is swept along the edge, changing the profile changes how a face is
 *   *shaped*, and could change how many triangles it takes, but it does not
 *   change which voxels exist. Indexing by voxel keeps the profile a purely
 *   geometric concern that can never scramble paint.
 *
 * The dormancy mechanism needs no code at all. It works because NOTHING ever
 * deletes paint on a sculpt operation. Sculpt commands touch `voxels.*` and
 * never `paint.*`. If you find yourself writing a cleanup pass that prunes
 * "orphaned" paint, that is this invariant being broken.
 *
 * What a face override holds is a MATERIAL, never a tile: the tile drawn at
 * any corner follows from the materials around it (spec §3). Layer order
 * when the mesher resolves a face's material:
 *
 *   1. the voxel's own material — its top terrain on top, its side terrain
 *      on the sides
 *   2. the override in these records
 *   3. a stamped tile on top, later
 */

import type { DeepReadonly, PaintLayers } from './document'

/** The side ids beyond the four compass sides. */
export const FACE_TOP = 4
export const FACE_BOTTOM = 5

export function faceKey(x: number, z: number, y: number, dir: number): string {
  return `${x},${z},${y},${dir}`
}

export function tintKey(x: number, z: number): string {
  return `${x},${z}`
}

export function parseFaceKey(key: string): { x: number; z: number; y: number; dir: number } {
  const [x, z, y, dir] = key.split(',').map(Number)
  return { x, z, y, dir }
}

/** Undefined means "no override" — the voxel's own material. */
export function facePaint(paint: DeepReadonly<PaintLayers>, x: number, z: number, y: number, dir: number): number | undefined {
  return paint.faces[faceKey(x, z, y, dir)]
}

export function tintPaint(paint: DeepReadonly<PaintLayers>, x: number, z: number): number | undefined {
  return paint.tint[tintKey(x, z)]
}

/**
 * Diagnostic only. Counts face overrides that address faces which do not
 * currently exist — i.e. dormant work that would come back if the geometry
 * were restored. Shown in the editor's status bar so the artist can see that
 * their painting is being preserved rather than lost.
 *
 * This function must never be used to decide what to delete.
 */
export function countDormant(paint: DeepReadonly<PaintLayers>, faceExists: (key: string) => boolean): number {
  let dormant = 0
  for (const key of Object.keys(paint.faces)) if (!faceExists(key)) dormant += 1
  return dormant
}
