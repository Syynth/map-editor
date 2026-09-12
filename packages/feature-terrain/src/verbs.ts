/**
 * What the terrain verbs do, as pure functions from the document plus a few
 * parameters to patches. Nothing here applies anything: the document actor is
 * the only writer (#13), and both consumers in this package — the commands and
 * the stroke contract — hand what these return to `deps.apply` or to the
 * stroke actor.
 *
 * This file is the one implementation of the verbs, shared so that the
 * command form (`terrain.raise({ cells, delta })`, arguments filled in by a
 * palette or a test) and the stroke form (the same verb with the arguments
 * taken from the tool parameters under a dragged pointer) can never drift.
 */

import {
  SURFACE_CLIFF,
  SURFACE_TOP,
  autotileMask,
  brushCells,
  cellIndex,
  cliffPaint,
  fillCells,
  flatten,
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
  type Brush,
  type Cell,
  type Patch,
  type ReadonlyMapDoc,
  type SurfaceAddress,
} from '@map-editor/document'
import { defaultTopTile, sheetLayoutFor } from '@map-editor/geometry'

export type TerrainMode = 'sculpt' | 'paint'
export type SculptVerb = 'raise' | 'flatten' | 'ramp' | 'water'
export type PaintVerb = 'tile' | 'material' | 'tint'
export type StrokeShape = 'brush' | 'rect' | 'fill'

/**
 * The tool parameters a terrain stroke reads. This is the SHAPE, not the
 * owner: they live on the host's long-lived tools actor, where the panels and
 * the eyedropper already write them, and reach this package through
 * `FeatureDeps.params()`. Naming only the nine fields terrain uses — rather
 * than importing the host's eleven-field type, which #35 forbids — is what
 * keeps the seam structural.
 */
export interface TerrainParams {
  readonly terrainMode: TerrainMode
  readonly sculptVerb: SculptVerb
  readonly paintVerb: PaintVerb
  readonly strokeShape: StrokeShape
  readonly brush: Brush
  readonly material: number
  readonly tile: number
  readonly tint: number
  readonly rampDir: number
  /** Cells past a boundary before a sculpt stroke moves to the next cell; the prototype's dial. */
  readonly sculptDeadZone: number
}

/** The modifiers a stroke reads, on every terrain verb that has an inverse. */
export interface TerrainModifiers {
  readonly shift: boolean
  readonly alt: boolean
  readonly ctrl: boolean
}

/** The verb in effect, whichever mode is active — the feature's own context key. */
export function activeVerb(params: TerrainParams): SculptVerb | PaintVerb {
  return params.terrainMode === 'sculpt' ? params.sculptVerb : params.paintVerb
}

/** Cells a stroke touches, given the shape the artist chose. */
export function strokeCells(doc: ReadonlyMapDoc, params: Pick<TerrainParams, 'strokeShape' | 'brush'>, address: SurfaceAddress, anchor: Cell | null): Cell[] {
  switch (params.strokeShape) {
    case 'rect':
      if (!anchor) return [[address.x, address.y]]
      return rectCells(doc, anchor[0], anchor[1], address.x, address.y)
    case 'fill':
      return fillCells(doc, address.x, address.y)
    case 'brush':
      return brushCells(doc, address.x, address.y, params.brush)
  }
}

/**
 * The undo label, fixed at the press. Inside a stroke the document actor
 * ignores each tick's label — one stroke is one `Edit` — so this is the only
 * label a terrain drag shows, and it names the verb rather than a blanket
 * "Edit".
 */
export function terrainLabel(params: TerrainParams, modifiers: TerrainModifiers): string {
  if (params.terrainMode === 'sculpt') {
    switch (params.sculptVerb) {
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
  switch (params.paintVerb) {
    case 'material':
      return 'Set material'
    case 'tint':
      return modifiers.shift ? 'Clear tint' : 'Tint'
    case 'tile':
      return modifiers.shift ? 'Clear paint' : 'Paint'
  }
}

/** The tile the template would use at a cell with nothing painted over it. */
export function templateTileAt(doc: ReadonlyMapDoc, x: number, y: number): number {
  const layout = sheetLayoutFor(doc)
  const material = doc.terrain.material[cellIndex(doc.size, x, y)]
  return defaultTopTile(layout, material, autotileMask(doc, x, y))
}

/**
 * What alt-clicking a surface picks up, as the parameter change it implies.
 * Answering with the change rather than making it keeps this pure: the caller
 * hands it to `deps.setParams`, which is an event at the tools actor.
 */
export function eyedrop(doc: ReadonlyMapDoc, params: TerrainParams, address: SurfaceAddress): Partial<TerrainParams> {
  if (params.terrainMode === 'paint' && params.paintVerb === 'tint') {
    const tint = tintPaint(doc.paint, address.x, address.y)
    return tint === undefined ? {} : { tint }
  }
  if (params.terrainMode === 'paint' && params.paintVerb === 'material') {
    return { material: doc.terrain.material[cellIndex(doc.size, address.x, address.y)] }
  }
  if (address.kind === SURFACE_CLIFF) {
    const painted = cliffPaint(doc.paint, address.x, address.y, address.dir, address.level)
    return painted === undefined ? {} : { tile: painted }
  }
  return { tile: topPaint(doc.paint, address.x, address.y) ?? templateTileAt(doc, address.x, address.y) }
}

/**
 * One sculpt tick: the verb in `params`, over `cells`, addressed at `address`.
 * `anchorHeight` is the height sampled when the stroke began — flatten levels
 * to the cell that was pressed rather than following the terrain, and a stroke
 * is the only thing that knows which cell that was.
 */
export function sculptPatches(
  doc: ReadonlyMapDoc,
  params: TerrainParams,
  address: SurfaceAddress,
  cells: Cell[],
  modifiers: TerrainModifiers,
  anchorHeight: number,
): Patch[] {
  switch (params.sculptVerb) {
    case 'raise':
      return raise(doc, cells, modifiers.shift ? -1 : 1)
    case 'flatten':
      return flatten(doc, cells, anchorHeight)
    case 'ramp': {
      // Clicking a cliff face turns that edge into a ramp descending the way
      // the face points, which is the most direct reading of "toggle an edge
      // between cliff and ramp".
      const dir = address.kind === SURFACE_CLIFF ? address.dir : params.rampDir
      return dir < 0 ? [] : setRamp(doc, cells, dir)
    }
    case 'water':
      if (modifiers.shift) return setWater(doc, cells, null)
      // INTERIM (2026-09-12): pool one half-tile over the pressed cell, so
      // the verb does something visible on flat ground now that water is
      // never level with its ground. The verb is to be redesigned with the
      // layer view — water painted at the active layer — and this goes then.
      return setWater(doc, cells, doc.terrain.height[cellIndex(doc.size, address.x, address.y)] + 1)
  }
}

/** One paint tick, by the same rule. */
export function paintPatches(doc: ReadonlyMapDoc, params: TerrainParams, address: SurfaceAddress, cells: Cell[], modifiers: TerrainModifiers): Patch[] {
  const erase = modifiers.shift
  switch (params.paintVerb) {
    case 'material':
      return setMaterial(doc, cells, params.material)
    case 'tint':
      return paintTint(doc, cells, erase ? undefined : params.tint)
    case 'tile':
      if (address.kind === SURFACE_CLIFF) {
        // Paint the band that was clicked. A brush wider than one cell walks
        // the same level along the same face.
        const faces = cells
          .filter(([x, y]) => x === address.x || y === address.y)
          .map(([x, y]) => ({ x, y, dir: address.dir, level: address.level }))
        return paintCliff(doc, faces, erase ? undefined : params.tile)
      }
      if (address.kind === SURFACE_TOP) return paintTop(doc, cells, erase ? undefined : params.tile)
      return []
  }
}
