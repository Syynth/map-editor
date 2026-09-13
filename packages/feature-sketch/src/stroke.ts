/**
 * The Sketch tool's stroke contract.
 *
 * Draw mode: a press puts a point down. The first press of an outline makes
 * the sketch — standing on whatever structure was pressed — and every press
 * after adds a point in that sketch's own frame, snapped as the parameters
 * say (Ctrl — Cmd on a Mac — frees one press, as it frees every drag). Pressing the first point again, once there are three, closes the
 * outline. Nothing drags while drawing.
 *
 * Edit mode: a press near a point of any closed sketch selects that point
 * and drags it; a press on a sketch's cap or wall selects the sketch; a
 * press on nothing clears the selection. The press plane (`pick.plane`)
 * steers a drag, as every drag in the editor does since #103.
 */

import {
  HALF,
  SURFACE_SKETCH_CAP,
  SURFACE_SKETCH_WALL,
  addStructure,
  addSketchPoint,
  closeSketch,
  createSketch,
  frameOf,
  placeStructure,
  toLocal,
  updateSketchPoint,
  structureOf,
  type Patch,
  type ReadonlyMapDoc,
  type ReadonlySketch,
  type SurfaceAddress,
} from '@papercut/document'

import type { FeatureDeps, StrokeHandler, ToolContract } from './deps'
import { snapTo, type SketchSnap } from './params'

export interface SketchSample {
  readonly pick: {
    readonly surface: SurfaceAddress | null
    readonly point: { readonly x: number; readonly z: number } | null
    readonly plane?: { readonly x: number; readonly z: number } | null
    readonly handle?: { readonly structure: string; readonly index: number } | null
  }
  readonly modifiers: { readonly shift: boolean; readonly alt: boolean; readonly ctrl: boolean }
}

export type SketchStrokeHandler = StrokeHandler<SketchSample, Patch>

/** Within this many world units of the first point, a press closes the outline. */
export const CLOSE_RADIUS = 0.6
/** Within this many world units of a point, a press grabs it. */
export const HANDLE_RADIUS = 0.5

/** Where the pointer is for the tool: on the press plane mid-stroke, the ground hit at the press. */
function pointOf(sample: SketchSample): { x: number; z: number } | null {
  return sample.pick.plane ?? sample.pick.point
}

/** The nearest point of any closed sketch to a world position, within reach. */
export function nearestSketchPoint(doc: ReadonlyMapDoc, worldX: number, worldZ: number): { sketch: ReadonlySketch; index: number } | null {
  let best: { sketch: ReadonlySketch; index: number; distance: number } | null = null
  for (const id of doc.structureOrder) {
    const sketch = structureOf(doc, id, 'sketch')
    if (!sketch) continue
    const [lx, lz] = toLocal(frameOf(doc, id), worldX, worldZ)
    sketch.points.forEach((point, index) => {
      const distance = Math.hypot(point.x - lx, point.z - lz)
      if (distance <= HANDLE_RADIUS && (best === null || distance < best.distance)) best = { sketch, index, distance }
    })
  }
  return best
}

function firstVoxelId(doc: ReadonlyMapDoc): string | null {
  for (const id of doc.structureOrder) if (doc.structures[id]?.kind === 'voxel') return id
  return null
}

function localSnapped(doc: ReadonlyMapDoc, frameId: string, world: { x: number; z: number }, snap: SketchSnap): { x: number; z: number } {
  const [lx, lz] = toLocal(frameOf(doc, frameId), world.x, world.z)
  return { x: snapTo(lx, snap), z: snapTo(lz, snap) }
}

function drawStroke(deps: FeatureDeps): SketchStrokeHandler {
  return {
    label: 'Draw sketch',
    begin(sample) {
      const world = pointOf(sample)
      if (!world) return []
      const doc = deps.doc()
      const params = deps.params()
      const snap = sample.modifiers.ctrl ? 'free' : params.sketchSnap
      const open = params.drawing !== null ? structureOf(doc, params.drawing, 'sketch') : undefined

      if (!open || open.closed) {
        // A new outline, standing on what was pressed (or the ground): its first point is the press.
        const parent = sample.pick.surface?.structure ?? firstVoxelId(doc)
        if (!parent) return []
        const count = doc.structureOrder.filter((id) => doc.structures[id]?.kind === 'sketch').length
        const sketch = createSketch(parent, `Sketch ${count + 1}`)
        // The sketch sits at its parent's origin, so its frame is the parent's; the point is measured there.
        sketch.points = [{ ...localSnapped(doc, parent, world, snap), smooth: !sample.modifiers.alt }]
        deps.setParams({ drawing: sketch.id })
        deps.select({ kind: 'structure', id: sketch.id })
        return addStructure(doc, sketch)
      }

      const point = localSnapped(doc, open.id, world, snap)
      const first = open.points[0]
      if (open.points.length >= 3 && first && Math.hypot(first.x - point.x, first.z - point.z) <= CLOSE_RADIUS) {
        deps.setParams({ drawing: null })
        return closeSketch(doc, open.id)
      }
      return addSketchPoint(doc, open.id, { ...point, smooth: !sample.modifiers.alt })
    },
    move: () => [],
    end: () => [],
  }
}

function grabbedHandle(doc: ReadonlyMapDoc, sample: SketchSample): { sketch: string; index: number } | null {
  const handle = sample.pick.handle
  if (!handle || !structureOf(doc, handle.structure, 'sketch')?.points[handle.index]) return null
  return { sketch: handle.structure, index: handle.index }
}

function nearest(doc: ReadonlyMapDoc, world: { x: number; z: number }): { sketch: string; index: number } | null {
  const hit = nearestSketchPoint(doc, world.x, world.z)
  return hit ? { sketch: hit.sketch.id, index: hit.index } : null
}

function editStroke(deps: FeatureDeps): SketchStrokeHandler {
  /** A point being dragged, or a whole sketch being moved by the offset between its placement and the grab. */
  let target: { kind: 'point'; sketch: string; index: number } | { kind: 'sketch'; sketch: string; offset: { x: number; z: number } } | null = null
  return {
    label: 'Move sketch',
    begin(sample) {
      const doc = deps.doc()
      const world = pointOf(sample)
      // The handle the viewport found under the pointer, where it is drawn; failing that, the nearest point to the hit.
      const hit = grabbedHandle(doc, sample) ?? (world ? nearest(doc, world) : null)
      if (hit) {
        target = { kind: 'point', ...hit }
        deps.select({ kind: 'sketchPoint', structure: hit.sketch, index: hit.index })
        return []
      }
      const surface = sample.pick.surface
      if (surface && (surface.kind === SURFACE_SKETCH_CAP || surface.kind === SURFACE_SKETCH_WALL)) {
        const sketch = structureOf(doc, surface.structure, 'sketch')
        deps.select({ kind: 'structure', id: surface.structure })
        // Grab the sketch by where it was pressed: the placement moves by how far the pointer travels in the parent's frame.
        if (sketch && world) {
          const [px, pz] = toLocal(parentFrame(doc, sketch), world.x, world.z)
          target = { kind: 'sketch', sketch: sketch.id, offset: { x: sketch.placement.x - px, z: sketch.placement.z - pz } }
        }
        return []
      }
      if (!sample.modifiers.shift) deps.select(null)
      return []
    },
    move(sample) {
      const world = pointOf(sample)
      if (!target || !world) return []
      const doc = deps.doc()
      const snap = sample.modifiers.ctrl ? 'free' : deps.params().sketchSnap
      if (target.kind === 'point') return updateSketchPoint(doc, target.sketch, target.index, localSnapped(doc, target.sketch, world, snap))
      const sketch = structureOf(doc, target.sketch, 'sketch')
      if (!sketch) return []
      const [px, pz] = toLocal(parentFrame(doc, sketch), world.x, world.z)
      const placement = { x: snapTo(px + target.offset.x, snap), z: snapTo(pz + target.offset.z, snap), yaw: sketch.placement.yaw }
      return placeStructure(doc, sketch.id, placement)
    },
    end: () => [],
  }
}

/** The frame a sketch's placement is measured in: its parent's, or the world at the root. */
function parentFrame(doc: ReadonlyMapDoc, sketch: ReadonlySketch) {
  return sketch.parent ? frameOf(doc, sketch.parent) : { x: 0, z: 0, yaw: 0 as const, y: 0 }
}

export function sketchContract(deps: FeatureDeps): ToolContract<SketchSample, Patch> {
  return {
    stroke: () => (deps.params().sketchMode === 'draw' ? drawStroke(deps) : editStroke(deps)),
  }
}

/** The height a sketch's points sit at in world space: its base, plus its cap once closed. */
export function sketchPointHeight(doc: ReadonlyMapDoc, sketch: ReadonlySketch): number {
  return frameOf(doc, sketch.id).y + (sketch.closed && sketch.points.length >= 3 ? sketch.layers * HALF : 0)
}
