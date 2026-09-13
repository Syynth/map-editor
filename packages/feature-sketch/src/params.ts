/**
 * The Sketch tool's parameters: what it is doing (drawing a new outline, or
 * editing the points of one), how points snap, and which sketch is open
 * under the pen. The host holds this slice opaquely; `sketch.params` is the
 * command that changes the first two, and the stroke sets `drawing` itself.
 */

import { snapTo, type SnapMode } from '@papercut/document'

export type SketchMode = 'draw' | 'edit'
export type SketchSnap = SnapMode

export interface SketchParams {
  readonly sketchMode: SketchMode
  readonly sketchSnap: SketchSnap
  /** The sketch being drawn — open, taking points — or `null` when the next press starts one. */
  readonly drawing: string | null
}

export const SKETCH_DEFAULTS: SketchParams = { sketchMode: 'draw', sketchSnap: 'grid', drawing: null }

export { snapTo }
