/**
 * The Sketch tool's parameters: what it is doing (drawing a new outline, or
 * editing the points of one), how points snap, and which sketch is open
 * under the pen. The host holds this slice opaquely; `sketch.params` is the
 * command that changes the first two, and the stroke sets `drawing` itself.
 */

export type SketchMode = 'draw' | 'edit'
export type SketchSnap = 'grid' | 'half' | 'free'

export interface SketchParams {
  readonly sketchMode: SketchMode
  readonly sketchSnap: SketchSnap
  /** The sketch being drawn — open, taking points — or `null` when the next press starts one. */
  readonly drawing: string | null
}

export const SKETCH_DEFAULTS: SketchParams = { sketchMode: 'draw', sketchSnap: 'grid', drawing: null }

/** Snap a coordinate: to the cell grid, to half cells, or not at all (rounded to a hundredth so a file stays readable). */
export function snapTo(value: number, snap: SketchSnap): number {
  if (snap === 'free') return Math.round(value * 100) / 100
  const step = snap === 'grid' ? 1 : 0.5
  return Math.round(value / step) * step
}
