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
  DIR_VECTORS,
  SURFACE_CLIFF,
  SURFACE_TOP,
  brushCells,
  facePaint,
  fillCells,
  flatten,
  materialAt,
  smooth,
  paintFace,
  paintTint,
  raise,
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
  type RampEdge,
  type ReadonlyMapDoc,
  type ReadonlyVoxel,
  type SurfaceAddress,
} from '@papercut/document'

export type TerrainMode = 'sculpt' | 'paint'
export type SculptVerb = 'raise' | 'flatten' | 'smooth' | 'ramp' | 'water'
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
  /** Half-tiles per pass of Raise, Lower and Smooth. */
  readonly strength: number
  /** The height Flatten sets, in half-tiles: sampled at each press unless pinned. */
  readonly height: number
  readonly heightPinned: boolean
  /** The ramp being dragged out: the cliff edge it starts from, how many cells the drag has taken it back, and how many the drop needs. `null` between drags. */
  readonly rampRun: RampDrag | null
  /** Cells past a boundary before a sculpt stroke moves to the next cell; the prototype's dial. */
  readonly sculptDeadZone: number
}

export interface RampDrag {
  readonly edge: RampEdge
  readonly run: number
  readonly needed: number
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
  strength: 2,
  height: 2,
  heightPinned: false,
  rampRun: null,
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
      case 'smooth':
        return 'Smooth'
      case 'ramp':
        return modifiers.shift ? 'Remove ramp' : 'Cut ramp'
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

/** The cells a ramp drag covers: `run` cells back from the edge, away from the side it descends toward. */
export function rampRunCells(drag: RampDrag): Cell[] {
  const [dx, dz] = DIR_VECTORS[drag.edge.dir]
  const cells: Cell[] = []
  for (let k = 0; k < drag.run; k++) cells.push([drag.edge.x - k * dx, drag.edge.z - k * dz])
  return cells
}

/**
 * One sculpt tick: the verb in `params`, over `cells`, addressed at `address`.
 * `anchorHeight` is the height sampled when the stroke began — flatten levels
 * to the cell that was pressed (or to the pinned height) rather than
 * following the terrain, and a stroke is the only thing that knows which
 * cell that was. The ramp verb is not here: a ramp is a drag, not a tick,
 * and `stroke.ts` owns it.
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
      return raise(doc, voxel, cells, modifiers.shift ? -params.strength : params.strength)
    case 'flatten':
      return flatten(doc, voxel, cells, params.heightPinned ? params.height : anchorHeight)
    case 'smooth':
      return smooth(doc, voxel, cells, params.strength)
    case 'ramp':
      return []
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
