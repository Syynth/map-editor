/**
 * What a stroke means, per tool.
 *
 * The tools share picking, strokes, commands and meshing, and differ only in
 * which ops they turn a pick into. That shared core was allowed to emerge from
 * writing the tools rather than being designed first, which is why this file
 * is a switch statement and not a framework.
 *
 * The shared verbs behave identically everywhere:
 *   Shift  — erase / invert (lower instead of raise, clear paint, remove water)
 *   Alt    — eyedropper (pick up whatever is under the cursor)
 *   Ctrl   — reach through objects to the terrain beneath
 */

import {
  NO_WATER,
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
  type EditorStore,
  type ReadonlyMapDoc,
  type MapObject,
  type SurfaceAddress,
} from '@map-editor/document'
import { defaultTopTile, sheetLayoutFor } from '@map-editor/geometry'
import type { PickResult } from '@map-editor/runtime'
import type { EditorState } from './state'
import type { PointerModifiers } from '@map-editor/viewport'

export interface StrokeContext {
  store: EditorStore
  state: EditorState
  setState: (changes: Partial<EditorState>) => void
  /** Anchor cell for rectangle strokes. */
  anchor: Cell | null
  /** Height sampled when the stroke began, for flatten. */
  anchorHeight: number
  /** Cell last edited, so a drag does not re-apply to the same cell. */
  lastCell: string | null
}

/** Cells a stroke touches, given the shape the artist chose. */
export function strokeCells(doc: ReadonlyMapDoc, state: EditorState, address: SurfaceAddress, anchor: Cell | null): Cell[] {
  switch (state.strokeShape) {
    case 'rect':
      if (!anchor) return [[address.x, address.y]]
      return rectCells(doc, anchor[0], anchor[1], address.x, address.y)
    case 'fill':
      return fillCells(doc, address.x, address.y)
    case 'brush':
    default:
      return brushCells(doc, address.x, address.y, state.brush)
  }
}

/** The tile the template would use here with nothing painted. */
function templateTileAt(doc: ReadonlyMapDoc, x: number, y: number): number {
  const layout = sheetLayoutFor(doc)
  const material = doc.terrain.material[cellIndex(doc.size, x, y)]
  return defaultTopTile(layout, material, autotileMask(doc, x, y))
}

function eyedrop(context: StrokeContext, address: SurfaceAddress): void {
  const { store, state, setState } = context
  const doc = store.reader.doc

  if (state.terrainMode === 'paint' && state.paintVerb === 'tint') {
    const tint = tintPaint(doc.paint, address.x, address.y)
    if (tint !== undefined) setState({ tint })
    return
  }

  if (state.terrainMode === 'paint' && state.paintVerb === 'material') {
    setState({ material: doc.terrain.material[cellIndex(doc.size, address.x, address.y)] })
    return
  }

  if (address.kind === SURFACE_CLIFF) {
    const painted = cliffPaint(doc.paint, address.x, address.y, address.dir, address.level)
    if (painted !== undefined) setState({ tile: painted })
    return
  }

  const painted = topPaint(doc.paint, address.x, address.y)
  setState({ tile: painted ?? templateTileAt(doc, address.x, address.y) })
}

/**
 * Apply one tick of a stroke. Returns true if the document changed.
 */
export function applyStroke(
  context: StrokeContext,
  pick: PickResult,
  modifiers: PointerModifiers,
  phase: 'start' | 'move' | 'end',
): void {
  const { store, state } = context
  const doc = store.reader.doc

  if (state.tool === 'object') {
    applyObjectStroke(context, pick, modifiers, phase)
    return
  }
  if (state.tool === 'camera') return

  const address = pick.surface
  if (!address) return

  if (modifiers.alt) {
    if (phase === 'start') eyedrop(context, address)
    return
  }

  // Rectangle strokes only commit on release; everything else is live.
  if (state.strokeShape === 'rect' && phase === 'move') return
  if (state.strokeShape === 'rect' && phase === 'start') return

  const cellKey = `${address.x},${address.y},${address.kind},${address.dir},${address.level}`
  if (phase === 'move' && context.lastCell === cellKey) return
  context.lastCell = cellKey

  const cells = strokeCells(doc, state, address, context.anchor)

  if (state.terrainMode === 'sculpt') {
    applySculpt(context, address, cells, modifiers)
  } else {
    applyPaint(context, address, cells, modifiers)
  }
}

function applySculpt(
  context: StrokeContext,
  address: SurfaceAddress,
  cells: Cell[],
  modifiers: PointerModifiers,
): void {
  const { store, state } = context
  const doc = store.reader.doc

  switch (state.sculptVerb) {
    case 'raise':
      store.apply(modifiers.shift ? 'Lower' : 'Raise', raise(doc, cells, modifiers.shift ? -1 : 1))
      break

    case 'flatten':
      store.apply('Flatten', flatten(doc, cells, context.anchorHeight))
      break

    case 'ramp': {
      // Clicking a cliff face turns that edge into a ramp descending the way
      // the face points, which is the most direct reading of "toggle an edge
      // between cliff and ramp".
      const dir = address.kind === SURFACE_CLIFF ? address.dir : state.rampDir
      if (dir < 0) break
      store.apply('Toggle ramp', setRamp(doc, cells, dir))
      break
    }

    case 'water': {
      if (modifiers.shift) {
        store.apply('Remove water', setWater(doc, cells, null))
      } else {
        // Fill to the height of the cell that was clicked, so water pools at a
        // level rather than following the terrain.
        const level = doc.terrain.height[cellIndex(doc.size, address.x, address.y)]
        store.apply('Carve water', setWater(doc, cells, level))
      }
      break
    }
  }
}

function applyPaint(
  context: StrokeContext,
  address: SurfaceAddress,
  cells: Cell[],
  modifiers: PointerModifiers,
): void {
  const { store, state } = context
  const doc = store.reader.doc
  const erase = modifiers.shift

  switch (state.paintVerb) {
    case 'material':
      store.apply('Set material', setMaterial(doc, cells, state.material))
      break

    case 'tint':
      store.apply(erase ? 'Clear tint' : 'Tint', paintTint(doc, cells, erase ? undefined : state.tint))
      break

    case 'tile':
    default:
      if (address.kind === SURFACE_CLIFF) {
        // Paint the band that was clicked. A brush wider than one cell walks
        // the same level along the same face.
        const faces = cells
          .filter(([x, y]) => x === address.x || y === address.y)
          .map(([x, y]) => ({ x, y, dir: address.dir, level: address.level }))
        store.apply(
          erase ? 'Clear cliff paint' : 'Paint cliff',
          paintCliff(doc, faces, erase ? undefined : state.tile),
        )
      } else if (address.kind === SURFACE_TOP) {
        store.apply(
          erase ? 'Clear paint' : 'Paint',
          paintTop(doc, cells, erase ? undefined : state.tile),
        )
      }
      break
  }
}

function applyObjectStroke(
  context: StrokeContext,
  pick: PickResult,
  modifiers: PointerModifiers,
  phase: 'start' | 'move' | 'end',
): void {
  const { store, state, setState } = context
  const doc = store.reader.doc

  if (phase === 'start') {
    if (pick.objectId) {
      if (modifiers.alt) {
        setState({ spriteName: doc.objects[pick.objectId]?.sprite ?? state.spriteName })
      }
      setState({ selectedObjectId: pick.objectId })
      return
    }

    if (modifiers.shift) return
    if (!pick.point) return

    const position = groundedPosition(doc, pick.point.x, pick.point.z)
    const object: MapObject = {
      id: newId(),
      name: state.spriteName,
      sprite: state.spriteName,
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
    store.apply('Place object', addObject(doc, object))
    setState({ selectedObjectId: object.id })
    return
  }

  // Dragging a selected object moves it along the ground.
  if (phase === 'move' && state.selectedObjectId && pick.point) {
    const object = doc.objects[state.selectedObjectId]
    if (!object || object.locked) return
    const position = groundedPosition(doc, pick.point.x, pick.point.z)
    store.apply(
      'Move object',
      updateObject(doc, object.id, {
        position,
        anchorCell: object.anchorCell
          ? [Math.floor(position[0]), Math.floor(position[2])]
          : null,
      }),
    )
  }
}

export function waterlessDoc(doc: ReadonlyMapDoc): boolean {
  return doc.terrain.water.every((value) => value === NO_WATER)
}
