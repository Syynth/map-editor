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
  AIR,
  SURFACE_CLIFF,
  SURFACE_TOP,
  brushCells,
  clearRampRun,
  facePaint,
  fillCells,
  flatten,
  materialAt,
  paintFace,
  paintTint,
  raise,
  rampRun,
  rampRunLength,
  rectCells,
  setMaterial,
  setWater,
  tintPaint,
  topHeight,
  voxelAt,
  type Brush,
  type Cell,
  type FaceRef,
  type Patch,
  type ReadonlyMapDoc,
  type ReadonlyVoxel,
  type SurfaceAddress,
} from '@papercut/document'

export type TerrainMode = 'sculpt' | 'paint'
export type SculptVerb = 'raise' | 'flatten' | 'ramp' | 'water'
export type PaintVerb = 'material' | 'tint'
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
  readonly tint: number
  /** Cells past a boundary before a sculpt stroke moves to the next cell; the prototype's dial. */
  readonly sculptDeadZone: number
}

/** The modifiers a stroke reads, on every terrain verb that has an inverse. */
/** What the feature starts with; the host seeds its parameter slice from this. */
export const TERRAIN_DEFAULTS: TerrainParams = {
  terrainMode: 'sculpt',
  sculptVerb: 'raise',
  paintVerb: 'material',
  strokeShape: 'brush',
  brush: { size: 1, shape: 'square' },
  material: 0,
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
      return modifiers.shift ? 'Clear face' : 'Set material'
    case 'tint':
      return modifiers.shift ? 'Clear tint' : 'Tint'
  }
}

/** The face of a voxel a cliff-band address names: the band's layer, on that side. */
function faceOf(address: SurfaceAddress, x: number, z: number): FaceRef {
  return { x, z, y: Math.floor(address.level / 2), dir: address.dir }
}

/** The material a band is drawn with: its face override, else the voxel's own (the column's top, should the band sit in a slab's air). */
function bandMaterial(voxel: ReadonlyVoxel, address: SurfaceAddress): number {
  const face = faceOf(address, address.x, address.y)
  const override = facePaint(voxel.paint, face.x, face.z, face.y, face.dir)
  if (override !== undefined) return override
  const material = voxelAt(voxel, face.x, face.z, face.y)
  return material === AIR ? materialAt(voxel, address.x, address.y) : material
}

/**
 * What alt-clicking a surface picks up, as the parameter change it implies.
 * Answering with the change rather than making it keeps this pure: the caller
 * hands it to `deps.setParams`, which is an event at the tools actor.
 */
export function eyedrop(voxel: ReadonlyVoxel, params: TerrainParams, address: SurfaceAddress): Partial<TerrainParams> {
  if (params.terrainMode === 'paint' && params.paintVerb === 'tint') {
    const tint = tintPaint(voxel.paint, address.x, address.y)
    return tint === undefined ? {} : { tint }
  }
  // A band answers with what it is drawn with; a top with the column's top voxel.
  return { material: address.kind === SURFACE_CLIFF ? bandMaterial(voxel, address) : materialAt(voxel, address.x, address.y) }
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

/**
 * One paint tick, by the same rule. The Material brush is one brush for
 * every face (spec §4): on a top it sets the column's top voxel's material;
 * on a cliff band it sets that face's override, and shift clears it back to
 * the voxel's own. A brush wider than one cell walks the same level along
 * the same face.
 */
export function paintPatches(voxel: ReadonlyVoxel, params: TerrainParams, address: SurfaceAddress, cells: Cell[], modifiers: TerrainModifiers): Patch[] {
  const erase = modifiers.shift
  switch (params.paintVerb) {
    case 'material':
      if (address.kind === SURFACE_CLIFF) {
        const faces = cells.filter(([x, y]) => x === address.x || y === address.y).map(([x, y]) => faceOf(address, x, y))
        return paintFace(voxel, faces, erase ? undefined : params.material)
      }
      if (address.kind === SURFACE_TOP) return erase ? [] : setMaterial(voxel, cells, params.material)
      return []
    case 'tint':
      return paintTint(voxel, cells, erase ? undefined : params.tint)
  }
}
