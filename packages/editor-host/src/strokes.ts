/**
 * What a stroke means, per tool — the handlers the stroke actor runs.
 *
 * Moved here from `apps/editor/src/editor/tools.ts` with the stroke actor
 * (#66 step 4). What is left is the SWITCH and the object tool: the terrain
 * tool's handler is the `feature-terrain` module's, reached through the
 * `ToolContract` its owner contributed (`deps.contract`), so the host holds no
 * copy of a terrain verb at all. The host cannot import a feature (#35), and
 * the contract is exactly the seam that makes it unnecessary — a declared tool
 * is enumerable before anything runs, and its handler arrives with the deps.
 *
 * A tool whose feature is not installed simply strokes nothing: `contract`
 * answers `undefined`, `createStrokeHandler` passes that on, and the gesture
 * actor spawns no stroke. That is the same answer a press that missed the
 * terrain gets, and the same one the camera tool gets.
 *
 * The contract (registry `tools.ts`) is deliberately STATEFUL: a handler is
 * fresh per stroke and whatever the stroke accumulates — the object a drag is
 * moving, and on the terrain side the rectangle anchor and the flatten height
 * — lives on it and dies with it. So a handler's methods are called exactly
 * once per phase, inside `enq`, never in a transition body (see `stroke.ts`).
 *
 * The shared verbs behave identically everywhere:
 *   Shift  — erase / invert (lower instead of raise, clear paint, remove water)
 *   Alt    — eyedropper (pick up whatever is under the cursor)
 *   Ctrl   — reach through objects to the terrain beneath
 *
 * Two things a stroke changes that are not the document — the eyedropper's
 * tool parameters and the object tool's selection — leave through `StrokeDeps`
 * as typed events to the tools and view actors. They are NOT commands: a
 * command has an id, is declared in the registry and arrives by `dispatch`,
 * and none of that is true of these. #11 has handlers never read ambient
 * selection, so the object being dragged is fixed at the press from the id
 * the host filled in, and a change to selection is the host sending `select`
 * to the view actor on the handler's behalf. A feature's handler reaches the
 * same two doors through `FeatureDeps.setParams`, which is the same event.
 */

import {
  addObject,
  defaultFacing,
  groundedPosition,
  newId,
  updateObject,
  type DocumentReader,
  type MapObject,
  type Patch,
  type SurfaceAddress,
} from '@map-editor/document'
import type { StrokeHandler, ToolContract } from '@map-editor/registry'

import type { TerrainMode, ToolSettings, ToolsContext } from './tools'

/** The keyboard state that rides on a pointer event. `button` is not here: it belongs to the press, not the motion. */
export interface PointerModifiers {
  readonly shift: boolean
  readonly alt: boolean
  readonly ctrl: boolean
}

/**
 * What the viewport picked under the pointer, in the shape the stroke needs
 * and no more. Structural on purpose: `runtime`'s `PickResult` is assignable
 * (its `point` is a `Vector3`, which has `x` and `z`) without this package
 * naming `three` or depending on `runtime` at all.
 */
export interface PickSample {
  readonly surface: SurfaceAddress | null
  readonly point: { readonly x: number; readonly z: number } | null
  readonly objectId: string | null
  /**
   * Mid-stroke only: where the pointer's ray meets the horizontal plane
   * through the press's hit, whatever is under the cursor now. A handler
   * that MOVES something reads this rather than `point`, which mid-drag is
   * the dragged sprite or a cliff face the ray crossed. Absent on a press
   * (the press point is its own plane point) and from a test that has no
   * camera; `point` is the fallback.
   */
  readonly plane?: { readonly x: number; readonly z: number } | null
}

export const NO_PICK: PickSample = { surface: null, point: null, objectId: null }

/** One tick's input to a handler: the pick plus the modifiers held at that instant. */
export interface StrokeSample {
  readonly pick: PickSample
  readonly modifiers: PointerModifiers
}

/** The tools actor's snapshot, flattened: its state (`terrainMode`) beside its context. */
export interface ToolsSnapshot extends ToolsContext {
  readonly terrainMode: TerrainMode
}

export interface StrokeDeps {
  readonly reader: DocumentReader
  /** Read per tick, not captured at the press: `]` mid-drag widens the brush, as it always did. */
  tools(): ToolsSnapshot
  /** The eyedropper's output. The host turns it into a `settings` event to the tools actor. */
  setTools(settings: ToolSettings): void
  /** The object tool's output. The host turns it into a `select` event to the view actor. */
  select(id: string | null): void
  /**
   * The contract behind a declared tool, or `undefined` when nobody declared
   * it or its owner contributed none — `Host.toolContract`, handed in rather
   * than imported, because this file is below `host.ts` and the lookup needs
   * the live feature instances.
   */
  contract(toolId: string): ToolContract<StrokeSample, Patch> | undefined
}

export type EditorStrokeHandler = StrokeHandler<StrokeSample, Patch>

/**
 * The handler for a left press at `sample` under the current tool, or
 * `undefined` when that tool declines the press, so the host spawns nothing
 * and the pointer-down falls through to arbitration. `selection` is the id
 * the host read from the view actor at the press: the drag target when the
 * press lands on nothing selectable.
 */
export function createStrokeHandler(deps: StrokeDeps, sample: StrokeSample, selection: string | null): EditorStrokeHandler | undefined {
  switch (deps.tools().tool) {
    case 'terrain':
      // The feature's, by the tool's id and nothing else (#9's join). It
      // declines a press that missed the terrain by answering `undefined`,
      // which is the same thing this function does with it.
      return deps.contract('terrain')?.stroke(sample)
    case 'select':
      return selectStroke(deps, selection)
    case 'object':
      return objectStroke(deps, selection)
  }
}

// --- select -------------------------------------------------------------------

/**
 * Select addresses what already exists: a press on an object selects it and
 * a drag moves it; a press on nothing clears the selection, unless shift is
 * held, which is the convention every reference app shares for "keep what I
 * have". It never places. Alt on an object is the sprite eyedropper, as it is
 * for the object tool, because "pick this one up" reads the same in both.
 *
 * What it does NOT do yet is select terrain: the region half of the design
 * (marquee, expand, contract) waits on a typed selection on the view actor.
 */
function selectStroke(deps: StrokeDeps, selection: string | null): EditorStrokeHandler {
  const drag = new Drag(deps, selection)

  return {
    label: 'Move object',
    begin(sample) {
      const { pick, modifiers } = sample
      if (pick.objectId) {
        if (modifiers.alt) deps.setTools({ spriteName: deps.reader.doc.objects[pick.objectId]?.sprite ?? deps.tools().spriteName })
        deps.select(pick.objectId)
        drag.grab(pick.objectId, pick)
        return []
      }
      if (!modifiers.shift) {
        deps.select(null)
        drag.release()
      }
      return []
    },
    move: (sample) => drag.move(sample),
    end: () => [],
  }
}

// --- objects ------------------------------------------------------------------

/**
 * The object tool places. A press on empty ground adds the current sprite
 * there and selects it — a creation tool selects what it just made, so the
 * inspector shows it without a tool switch — and the rest of the drag moves
 * it. A press on an existing object selects and drags that instead of
 * placing a second one on top of it.
 */
function objectStroke(deps: StrokeDeps, selection: string | null): EditorStrokeHandler {
  /** What a drag moves: the object pressed, the object placed, or failing both the selection at the press. */
  const drag = new Drag(deps, selection)

  return {
    label: 'Edit object',
    begin(sample) {
      const doc = deps.reader.doc
      const tools = deps.tools()
      const { pick, modifiers } = sample

      if (pick.objectId) {
        if (modifiers.alt) deps.setTools({ spriteName: doc.objects[pick.objectId]?.sprite ?? tools.spriteName })
        deps.select(pick.objectId)
        drag.grab(pick.objectId, pick)
        return []
      }

      if (modifiers.shift) return []
      if (!pick.point) return []

      const position = groundedPosition(doc, pick.point.x, pick.point.z)
      const object: MapObject = {
        id: newId(),
        name: tools.spriteName,
        sprite: tools.spriteName,
        position,
        rotationY: doc.camera.yaw,
        scale: 1,
        display: 'auto',
        facing: defaultFacing(),
        anchorCell: [Math.floor(position[0]), Math.floor(position[2])],
        seed: Math.floor(Math.random() * 0xffff),
        locked: false,
        hidden: false,
      }
      deps.select(object.id)
      drag.grab(object.id, pick)
      return addObject(doc, object)
    },
    move: (sample) => drag.move(sample),
    end: () => [],
  }
}

/**
 * Dragging an object along the ground, the way a grab feels in every app
 * that has one: the point you pressed stays under the pointer. The offset
 * between the object and the press's plane point is taken once at the grab
 * and kept, so the object never jumps to the cursor, and each tick reads the
 * pointer's position on the PRESS's plane (`pick.plane`) rather than
 * whatever the ray hits now — mid-drag that is the dragged sprite itself,
 * whose hit point slides along the billboard and made the motion feel
 * constrained to an axis for no reason. Height follows the terrain.
 */
class Drag {
  private target: string | null
  private offset = { x: 0, z: 0 }

  constructor(
    private readonly deps: StrokeDeps,
    selection: string | null,
  ) {
    // The selection at the press is the fallback target, held without an
    // offset: a drag that starts on it uses the grab; one that starts beside
    // it (a shift-press on empty ground) moves nothing.
    this.target = selection
  }

  grab(id: string, pick: PickSample): void {
    this.target = id
    const object = this.deps.reader.doc.objects[id]
    const at = pick.plane ?? pick.point
    this.offset = object && at ? { x: object.position[0] - at.x, z: object.position[2] - at.z } : { x: 0, z: 0 }
  }

  release(): void {
    this.target = null
  }

  move(sample: StrokeSample): readonly Patch[] {
    const at = sample.pick.plane ?? sample.pick.point
    if (!this.target || !at) return []
    const doc = this.deps.reader.doc
    const object = doc.objects[this.target]
    if (!object || object.locked) return []
    const position = groundedPosition(doc, at.x + this.offset.x, at.z + this.offset.z)
    return updateObject(doc, object.id, {
      position,
      anchorCell: object.anchorCell ? [Math.floor(position[0]), Math.floor(position[2])] : null,
    })
  }
}
