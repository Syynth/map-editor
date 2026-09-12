/**
 * What a stroke means, per tool — the handlers the stroke actor runs.
 *
 * Moved here from `apps/editor/src/editor/tools.ts` with the stroke actor
 * (#66 step 4): the actor needs them and the app must not be the thing that
 * supplies them. The terrain and object tools are still one switch statement
 * rather than a feature module; step 5 pulls the terrain half into
 * `feature-terrain` against the same `StrokeHandler` contract, which is why
 * the shape here is the registry's rather than the app's old `StrokeContext`.
 *
 * The contract (registry `tools.ts`) is deliberately STATEFUL: a handler is
 * fresh per stroke and whatever the stroke accumulates — the rectangle anchor,
 * the height flatten samples at the press, the cell the last tick edited —
 * lives on it and dies with it. So a handler's methods are called exactly once
 * per phase, inside `enq`, never in a transition body (see `stroke.ts`).
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
 * to the view actor on the handler's behalf.
 */

import {
  SURFACE_CLIFF,
  SURFACE_TOP,
  addObject,
  autotileMask,
  brushCells,
  cellIndex,
  cliffPaint,
  defaultFacing,
  fillCells,
  flatten,
  groundedPosition,
  inBounds,
  newId,
  paintCliff,
  paintTint,
  paintTop,
  raise,
  rectCells,
  setMaterial,
  setRamp,
  setWater,
  tintPaint,
  topPaint,
  updateObject,
  type Cell,
  type DocumentReader,
  type MapObject,
  type Patch,
  type ReadonlyMapDoc,
  type SurfaceAddress,
} from '@map-editor/document'
import { defaultTopTile, sheetLayoutFor } from '@map-editor/geometry'
import type { StrokeHandler } from '@map-editor/registry'

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
}

export type EditorStrokeHandler = StrokeHandler<StrokeSample, Patch>

/** Cells a stroke touches, given the shape the artist chose. Also drives the brush preview, so it is exported. */
export function strokeCells(
  doc: ReadonlyMapDoc,
  shape: Pick<ToolsContext, 'strokeShape' | 'brush'>,
  address: SurfaceAddress,
  anchor: Cell | null,
): Cell[] {
  switch (shape.strokeShape) {
    case 'rect':
      if (!anchor) return [[address.x, address.y]]
      return rectCells(doc, anchor[0], anchor[1], address.x, address.y)
    case 'fill':
      return fillCells(doc, address.x, address.y)
    case 'brush':
      return brushCells(doc, address.x, address.y, shape.brush)
  }
}

/**
 * The handler for a left press at `sample` under the current tool, or
 * `undefined` when that tool has no stroke — the camera tool, whose drags are
 * the viewport's — so the host spawns nothing. `selection` is the id the host
 * read from the view actor at the press: the object tool's drag target when
 * the press lands on nothing selectable.
 */
export function createStrokeHandler(deps: StrokeDeps, sample: StrokeSample, selection: string | null): EditorStrokeHandler | undefined {
  switch (deps.tools().tool) {
    case 'terrain':
      return terrainStroke(deps, sample)
    case 'object':
      return objectStroke(deps, selection)
    case 'camera':
      return undefined
  }
}

// --- terrain ------------------------------------------------------------------

/** The tile the template would use here with nothing painted. */
function templateTileAt(doc: ReadonlyMapDoc, x: number, y: number): number {
  const layout = sheetLayoutFor(doc)
  const material = doc.terrain.material[cellIndex(doc.size, x, y)]
  return defaultTopTile(layout, material, autotileMask(doc, x, y))
}

function eyedrop(deps: StrokeDeps, address: SurfaceAddress): void {
  const doc = deps.reader.doc
  const tools = deps.tools()

  if (tools.terrainMode === 'paint' && tools.paintVerb === 'tint') {
    const tint = tintPaint(doc.paint, address.x, address.y)
    if (tint !== undefined) deps.setTools({ tint })
    return
  }

  if (tools.terrainMode === 'paint' && tools.paintVerb === 'material') {
    deps.setTools({ material: doc.terrain.material[cellIndex(doc.size, address.x, address.y)] })
    return
  }

  if (address.kind === SURFACE_CLIFF) {
    const painted = cliffPaint(doc.paint, address.x, address.y, address.dir, address.level)
    if (painted !== undefined) deps.setTools({ tile: painted })
    return
  }

  const painted = topPaint(doc.paint, address.x, address.y)
  deps.setTools({ tile: painted ?? templateTileAt(doc, address.x, address.y) })
}

/**
 * The undo label, fixed at the press. Inside a stroke the store ignores each
 * tick's label — one stroke is one `Edit` — so this is the only label a
 * terrain drag ever shows, and it names the verb rather than the old blanket
 * "Edit".
 */
function terrainLabel(tools: ToolsSnapshot, modifiers: PointerModifiers): string {
  if (tools.terrainMode === 'sculpt') {
    switch (tools.sculptVerb) {
      case 'raise':
        return modifiers.shift ? 'Lower' : 'Raise'
      case 'flatten':
        return 'Flatten'
      case 'ramp':
        return 'Toggle ramp'
      case 'water':
        return modifiers.shift ? 'Remove water' : 'Carve water'
    }
  }
  switch (tools.paintVerb) {
    case 'material':
      return 'Set material'
    case 'tint':
      return modifiers.shift ? 'Clear tint' : 'Tint'
    case 'tile':
      return modifiers.shift ? 'Clear paint' : 'Paint'
  }
}

function terrainStroke(deps: StrokeDeps, press: StrokeSample): EditorStrokeHandler {
  const doc = deps.reader.doc
  const address = press.pick.surface
  /** Anchor cell for rectangle strokes, and the corner a rectangle preview grows from. */
  const anchor: Cell | null = address ? [address.x, address.y] : null
  /** Height sampled when the stroke began, for flatten. */
  const anchorHeight = address && inBounds(doc.size, address.x, address.y) ? doc.terrain.height[cellIndex(doc.size, address.x, address.y)] : 0
  /** Cell last edited, so a drag does not re-apply to the same cell. */
  let lastCell: string | null = null

  function sculpt(address: SurfaceAddress, cells: Cell[], modifiers: PointerModifiers): Patch[] {
    const doc = deps.reader.doc
    const tools = deps.tools()
    switch (tools.sculptVerb) {
      case 'raise':
        return raise(doc, cells, modifiers.shift ? -1 : 1)
      case 'flatten':
        return flatten(doc, cells, anchorHeight)
      case 'ramp': {
        // Clicking a cliff face turns that edge into a ramp descending the way
        // the face points, which is the most direct reading of "toggle an edge
        // between cliff and ramp".
        const dir = address.kind === SURFACE_CLIFF ? address.dir : tools.rampDir
        return dir < 0 ? [] : setRamp(doc, cells, dir)
      }
      case 'water':
        if (modifiers.shift) return setWater(doc, cells, null)
        // Fill to the height of the cell that was clicked, so water pools at a
        // level rather than following the terrain.
        return setWater(doc, cells, doc.terrain.height[cellIndex(doc.size, address.x, address.y)])
    }
  }

  function paint(address: SurfaceAddress, cells: Cell[], modifiers: PointerModifiers): Patch[] {
    const doc = deps.reader.doc
    const tools = deps.tools()
    const erase = modifiers.shift
    switch (tools.paintVerb) {
      case 'material':
        return setMaterial(doc, cells, tools.material)
      case 'tint':
        return paintTint(doc, cells, erase ? undefined : tools.tint)
      case 'tile':
        if (address.kind === SURFACE_CLIFF) {
          // Paint the band that was clicked. A brush wider than one cell walks
          // the same level along the same face.
          const faces = cells
            .filter(([x, y]) => x === address.x || y === address.y)
            .map(([x, y]) => ({ x, y, dir: address.dir, level: address.level }))
          return paintCliff(doc, faces, erase ? undefined : tools.tile)
        }
        if (address.kind === SURFACE_TOP) return paintTop(doc, cells, erase ? undefined : tools.tile)
        return []
    }
  }

  function tick(sample: StrokeSample, phase: 'start' | 'move' | 'end'): Patch[] {
    const address = sample.pick.surface
    if (!address) return []

    if (sample.modifiers.alt) {
      if (phase === 'start') eyedrop(deps, address)
      return []
    }

    const tools = deps.tools()
    // Rectangle strokes only commit on release; everything else is live.
    if (tools.strokeShape === 'rect' && phase !== 'end') return []
    if (tools.strokeShape !== 'rect' && phase === 'end') return []

    const cellKey = `${address.x},${address.y},${address.kind},${address.dir},${address.level}`
    if (phase === 'move' && lastCell === cellKey) return []
    lastCell = cellKey

    const cells = strokeCells(deps.reader.doc, tools, address, anchor)
    return tools.terrainMode === 'sculpt' ? sculpt(address, cells, sample.modifiers) : paint(address, cells, sample.modifiers)
  }

  return {
    label: terrainLabel(deps.tools(), press.modifiers),
    begin: (sample) => tick(sample, 'start'),
    move: (sample) => tick(sample, 'move'),
    end: (sample) => tick(sample, 'end'),
  }
}

// --- objects ------------------------------------------------------------------

function objectStroke(deps: StrokeDeps, selection: string | null): EditorStrokeHandler {
  /** What a drag moves: the object pressed, the object placed, or failing both the selection at the press. */
  let target = selection

  return {
    label: 'Edit object',
    begin(sample) {
      const doc = deps.reader.doc
      const tools = deps.tools()
      const { pick, modifiers } = sample

      if (pick.objectId) {
        if (modifiers.alt) deps.setTools({ spriteName: doc.objects[pick.objectId]?.sprite ?? tools.spriteName })
        deps.select(pick.objectId)
        target = pick.objectId
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
      target = object.id
      return addObject(doc, object)
    },
    move(sample) {
      // Dragging a selected object moves it along the ground.
      if (!target || !sample.pick.point) return []
      const doc = deps.reader.doc
      const object = doc.objects[target]
      if (!object || object.locked) return []
      const position = groundedPosition(doc, sample.pick.point.x, sample.pick.point.z)
      return updateObject(doc, object.id, {
        position,
        anchorCell: object.anchorCell ? [Math.floor(position[0]), Math.floor(position[2])] : null,
      })
    },
    end: () => [],
  }
}
