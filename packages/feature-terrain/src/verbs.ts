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
  clearRampRun,
  cliffPaint,
  fillCells,
  flatten,
  materialAt,
  paintCliff,
  paintTint,
  paintTop,
  raise,
  rampRun,
  rampRunLength,
  rectCells,
  setMaterial,
  setWater,
  tintPaint,
  topHeight,
  topPaint,
  type Brush,
  type Cell,
  type Patch,
  type ReadonlyMapDoc,
  type ReadonlyVoxel,
  type SurfaceAddress,
} from '@papercut/document'
import { defaultTopTile, sheetLayoutFor } from '@papercut/geometry'

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
  /** Cells past a boundary before a sculpt stroke moves to the next cell; the prototype's dial. */
  readonly sculptDeadZone: number
}

/** The modifiers a stroke reads, on every terrain verb that has an inverse. */
/** What the feature starts with; the host seeds its parameter slice from this. */
export const TERRAIN_DEFAULTS: TerrainParams = {
  terrainMode: 'sculpt',
  sculptVerb: 'raise',
  paintVerb: 'tile',
  strokeShape: 'brush',
  brush: { size: 1, shape: 'square' },
  material: 0,
  tile: 0,
  tint: 0xffffff,
  sculptDeadZone: 0.2,
}

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
export function strokeCells(voxel: ReadonlyVoxel, params: Pick<TerrainParams, 'strokeShape' | 'brush'>, address: SurfaceAddress, anchor: Cell | null): Cell[] {
  switch (params.strokeShape) {
    case 'rect':
      if (!anchor) return [[address.x, address.y]]
      return rectCells(voxel, anchor[0], anchor[1], address.x, address.y)
    case 'fill':
      return fillCells(voxel, address.x, address.y)
    case 'brush':
      return brushCells(voxel, address.x, address.y, params.brush)
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
export function templateTileAt(doc: ReadonlyMapDoc, voxel: ReadonlyVoxel, x: number, y: number): number {
  const layout = sheetLayoutFor(doc)
  return defaultTopTile(layout, materialAt(voxel, x, y), autotileMask(voxel, x, y))
}

/**
 * What alt-clicking a surface picks up, as the parameter change it implies.
 * Answering with the change rather than making it keeps this pure: the caller
 * hands it to `deps.setParams`, which is an event at the tools actor.
 */
export function eyedrop(doc: ReadonlyMapDoc, voxel: ReadonlyVoxel, params: TerrainParams, address: SurfaceAddress): Partial<TerrainParams> {
  if (params.terrainMode === 'paint' && params.paintVerb === 'tint') {
    const tint = tintPaint(voxel.paint, address.x, address.y)
    return tint === undefined ? {} : { tint }
  }
  if (params.terrainMode === 'paint' && params.paintVerb === 'material') {
    return { material: materialAt(voxel, address.x, address.y) }
  }
  if (address.kind === SURFACE_CLIFF) {
    const painted = cliffPaint(voxel.paint, address.x, address.y, address.dir, address.level)
    return painted === undefined ? {} : { tile: painted }
  }
  return { tile: topPaint(voxel.paint, address.x, address.y) ?? templateTileAt(doc, voxel, address.x, address.y) }
}

/**
 * One sculpt tick: the verb in `params`, over `cells`, addressed at `address`.
 * `anchorHeight` is the height sampled when the stroke began — flatten levels
 * to the cell that was pressed rather than following the terrain, and a stroke
 * is the only thing that knows which cell that was.
 */
export function sculptPatches(
  doc: ReadonlyMapDoc,
  voxel: ReadonlyVoxel,
  params: TerrainParams,
  address: SurfaceAddress,
  cells: Cell[],
  modifiers: TerrainModifiers,
  anchorHeight: number,
): Patch[] {
  switch (params.sculptVerb) {
    case 'raise':
      return raise(doc, voxel, cells, modifiers.shift ? -1 : 1)
    case 'flatten':
      return flatten(doc, voxel, cells, anchorHeight)
    case 'ramp': {
      // A cliff face cuts a ramp back from that edge, as long a run as the
      // drop needs (the drag that chooses the run is the tool rework's); a
      // ramp's own top removes the run it belongs to.
      if (address.kind === SURFACE_CLIFF) {
        const edge = { x: address.x, z: address.y, dir: address.dir }
        const run = rampRunLength(voxel, edge)
        return run === null ? [] : rampRun(doc, voxel, edge, run)
      }
      return clearRampRun(doc, voxel, address.x, address.y)
    }
    case 'water':
      if (modifiers.shift) return setWater(voxel, cells, null)
      // INTERIM (2026-09-12): pool one half-tile over the pressed cell, so
      // the verb does something visible on flat ground now that water is
      // never level with its ground. The verb is to be redesigned with the
      // layer view — water painted at the active layer — and this goes then.
      return setWater(voxel, cells, topHeight(voxel, address.x, address.y) + 1)
  }
}

/** One paint tick, by the same rule. */
export function paintPatches(voxel: ReadonlyVoxel, params: TerrainParams, address: SurfaceAddress, cells: Cell[], modifiers: TerrainModifiers): Patch[] {
  const erase = modifiers.shift
  switch (params.paintVerb) {
    case 'material':
      return setMaterial(voxel, cells, params.material)
    case 'tint':
      return paintTint(voxel, cells, erase ? undefined : params.tint)
    case 'tile':
      if (address.kind === SURFACE_CLIFF) {
        // Paint the band that was clicked. A brush wider than one cell walks
        // the same level along the same face.
        const faces = cells
          .filter(([x, y]) => x === address.x || y === address.y)
          .map(([x, y]) => ({ x, y, dir: address.dir, level: address.level }))
        return paintCliff(voxel, faces, erase ? undefined : params.tile)
      }
      if (address.kind === SURFACE_TOP) return paintTop(voxel, cells, erase ? undefined : params.tile)
      return []
  }
}
