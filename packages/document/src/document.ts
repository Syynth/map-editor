/**
 * The document model.
 *
 * Everything the editor knows about a map lives here as plain, serializable
 * data. Geometry is never stored — it is derived from this by the meshers.
 *
 * Expensive-to-reverse decisions, made deliberately and once:
 *
 *  1. `formatVersion` exists from the first commit, even while there is only
 *     one version of it. Migrations are cheap to add and impossible to
 *     retrofit.
 *  2. Heights are integer HALF-TILE units. `height: 3` means a top surface at
 *     1.5 world units. Half steps were listed as an open question; storing
 *     integers of a half unit costs nothing now and avoids a file migration
 *     later if we decide we want them.
 *  3. One world unit is one tile, always. Pixel density is a per-map setting
 *     that changes texture detail only, never scale.
 *  4. Paint is addressed in stable grid coordinates, never per mesh face.
 *     See `paint.ts` for the full invariant — it is the single most important
 *     rule in this file.
 */

import { defaultSurfaceMaterials, type FillEdgeMaterial, type ReadonlyVoxel, type Structure, type VoxelStructure } from './structure'

export const FORMAT_VERSION = 2

export type Direction = 0 | 1 | 2 | 3
/** +X east, +Z south, -X west, -Z north. Index order used everywhere. */
export const DIR_VECTORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
]
export const DIR_NAMES = ['East', 'South', 'West', 'North'] as const

/** No ramp on this cell. */
export const NO_RAMP = -1
/** No water in this column. */
export const NO_WATER = -32768

export interface MapSize {
  width: number
  height: number
}

/**
 * Parallel arrays, one entry per cell, indexed `y * width + x`.
 * Plain number arrays rather than typed arrays so the document is JSON without
 * a serializer. If profiling ever demands typed arrays, that is a change to
 * `io.ts` and this interface, not to any tool.
 */
export interface TerrainData {
  /** Integer half-tiles. */
  height: number[]
  /** Index into `materials`. The default look before anything is painted. */
  material: number[]
  /** Direction the ramp descends toward, or NO_RAMP. */
  ramp: number[]
  /** Water surface height in half-tiles, or NO_WATER. */
  water: number[]
}

/**
 * Painted overrides. Keys are stable grid addresses (see paint.ts).
 *
 * Entries are NEVER deleted when geometry shrinks. A cliff face that stops
 * existing leaves its paint behind, dormant; raising the terrain again brings
 * it back. That dormancy is the whole mechanism behind "paint survives
 * sculpt", and it works precisely because nothing garbage-collects this.
 */
export interface PaintLayers {
  /** `${x},${y}` -> tile id */
  top: Record<string, number>
  /** `${x},${y},${dir},${level}` -> tile id */
  cliff: Record<string, number>
  /** `${x},${y}` -> packed 0xRRGGBB */
  tint: Record<string, number>
}

export type DisplayMode =
  | 'fixed'
  | 'billboardY'
  | 'billboardFull'
  | 'crossed'
  | 'extruded'
  | 'auto'

export const DISPLAY_MODES: DisplayMode[] = [
  'fixed',
  'billboardY',
  'billboardFull',
  'crossed',
  'extruded',
  'auto',
]

export type BackSide = 'none' | 'mirror' | 'dark' | 'image'
export type FacingTransition = 'instant' | 'flip' | 'crossfade'
export type Hinge = 'center' | 'base' | 'edge'

/**
 * Paper Mario style facing and flip behaviour. Firm that it exists; the
 * specific knobs are the tentative part.
 */
export interface FacingConfig {
  /** How many directional images the sprite has. */
  facings: 1 | 2 | 4 | 8
  /** Reuse the right-hand images mirrored for the left side. */
  mirror: boolean
  back: BackSide
  transition: FacingTransition
  durationMs: number
  /** Degrees of overlap before a facing switches back, to stop flicker. */
  hysteresisDeg: number
  hinge: Hinge
}

export function defaultFacing(): FacingConfig {
  return {
    facings: 1,
    mirror: true,
    back: 'mirror',
    transition: 'flip',
    durationMs: 260,
    hysteresisDeg: 8,
    hinge: 'center',
  }
}

export interface MapObject {
  id: string
  name: string
  /** Asset key into the sprite library. */
  sprite: string
  position: [number, number, number]
  rotationY: number
  scale: number
  display: DisplayMode
  facing: FacingConfig
  /**
   * Grounding. When set, the object rides the terrain: sculpting the cell
   * moves it instead of burying it.
   */
  anchorCell: [number, number] | null
  /** Stable per-instance seed, so variation exports identically every time. */
  seed: number
  locked: boolean
  hidden: boolean
}

export interface CameraBounds {
  yawMin: number
  yawMax: number
  pitchMin: number
  pitchMax: number
  distMin: number
  distMax: number
}

export interface CameraRig {
  yaw: number
  pitch: number
  distance: number
  fov: number
  bounds: CameraBounds
  /** 0 means continuous; 90 gives detents. */
  yawSnapDeg: number
  projection: 'perspective' | 'orthographic'
}

export interface Atmosphere {
  preset: string
  fogColor: number
  fogNear: number
  fogFar: number
  skyTop: number
  skyHorizon: number
  skyBottom: number
  sunColor: number
  sunIntensity: number
  ambientIntensity: number
  sunAzimuth: number
  sunElevation: number
  /** Post-processing. Presets move these together; sliders are secondary. */
  bloom: number
  tiltShift: number
  /** Painted distant scenery: the no-modeling answer to far-off mountains. */
  backdrop: BackdropCard[]
}

export interface BackdropCard {
  sprite: string
  /** World height of the card's bottom edge. */
  base: number
  height: number
  /** Distance from map centre. */
  radius: number
  /** 0..1, how much it lags the camera. */
  parallax: number
  opacity: number
}

export interface MaterialDef {
  name: string
  /** Column block on the template sheet. See template.ts for the layout. */
  block: number
  /** Fallback colour when no sheet is loaded. */
  color: number
}

export interface MapDoc {
  formatVersion: number
  id: string
  name: string
  /** Pixels per tile. Texture detail only — never world scale. */
  texelDensity: number
  filtering: 'nearest' | 'linear'
  materials: MaterialDef[]
  /** The fill-and-edge materials sketches are dressed in, by name. */
  surfaceMaterials: Record<string, FillEdgeMaterial>
  /**
   * What the level is made of: a scene graph of structures (see
   * `structure.ts`). The terrain, its size and its paint live on a voxel
   * structure, not here; the level has no size of its own — its extent is
   * whatever its structures cover.
   */
  structures: Record<string, Structure>
  structureOrder: string[]
  objects: Record<string, MapObject>
  objectOrder: string[]
  camera: CameraRig
  atmosphere: Atmosphere
}

/**
 * The document as everyone but the document actor sees it (#13).
 *
 * A structural, recursive `readonly` over `MapDoc`: every property, every
 * array and every nested object. Verified during prototyping to reject all
 * four write shapes — indexed assignment (`doc.terrain.height[i] = h`),
 * record assignment (`doc.paint.top[key] = t`), array mutation (`push`,
 * `splice`) and property replacement (`doc.name = …`) — while leaving reads
 * untouched. No branding is needed because the arrays are plain `number[]`
 * and the records plain `Record<string, number>`: the mapped type is enough,
 * and `MapDoc` itself is assignable to it, so a read-only helper accepts both.
 *
 * Functions never become readonly: `T extends (...args) => unknown` short-
 * circuits before the mapping so a future method-bearing value would keep its
 * callable type. `MapDoc` has none today; the clause costs nothing and stops
 * the type silently turning a function into an object of readonly keys.
 *
 * The mapped clause is homomorphic over a type parameter, which is what makes
 * TypeScript map a tuple to a readonly tuple and an array to a readonly array
 * rather than to an object with numeric keys — `position` stays
 * `readonly [number, number, number]`, not `{ readonly 0: number; … }`.
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T

export type ReadonlyMapDoc = DeepReadonly<MapDoc>

export function cellIndex(size: MapSize, x: number, y: number): number {
  return y * size.width + x
}

export function inBounds(size: MapSize, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < size.width && y < size.height
}

/** Height in half-tiles, or the edge value clamped, for out-of-bounds reads. */
export function heightAt(voxel: ReadonlyVoxel, x: number, y: number): number {
  const cx = Math.min(Math.max(x, 0), voxel.size.width - 1)
  const cy = Math.min(Math.max(y, 0), voxel.size.height - 1)
  return voxel.terrain.height[cellIndex(voxel.size, cx, cy)]
}

export function materialAt(voxel: ReadonlyVoxel, x: number, y: number): number {
  const cx = Math.min(Math.max(x, 0), voxel.size.width - 1)
  const cy = Math.min(Math.max(y, 0), voxel.size.height - 1)
  return voxel.terrain.material[cellIndex(voxel.size, cx, cy)]
}

/** Half-tile units to world units. */
export const HALF = 0.5

export function worldHeight(halfTiles: number): number {
  return halfTiles * HALF
}

export const DEFAULT_MATERIALS: MaterialDef[] = [
  { name: 'Grass', block: 0, color: 0x6aa84f },
  { name: 'Dirt', block: 1, color: 0x8b6b45 },
  { name: 'Stone', block: 2, color: 0x8e8e8e },
  { name: 'Sand', block: 3, color: 0xd9c27e },
]

export const ATMOSPHERE_PRESETS: Record<string, Omit<Atmosphere, 'preset' | 'backdrop'>> = {
  'Clear noon': {
    fogColor: 0xbcd7ee,
    fogNear: 24,
    fogFar: 90,
    skyTop: 0x4a8fd4,
    skyHorizon: 0xbcd7ee,
    skyBottom: 0xe8e0cf,
    sunColor: 0xfff3d6,
    sunIntensity: 1.5,
    ambientIntensity: 0.65,
    sunAzimuth: 135,
    sunElevation: 55,
    bloom: 0.35,
    tiltShift: 0.25,
  },
  'Misty dusk': {
    fogColor: 0xc2a3b4,
    fogNear: 10,
    fogFar: 55,
    skyTop: 0x3b3560,
    skyHorizon: 0xe0a17c,
    skyBottom: 0x6d5470,
    sunColor: 0xffb27a,
    sunIntensity: 1.1,
    ambientIntensity: 0.5,
    sunAzimuth: 250,
    sunElevation: 12,
    bloom: 0.7,
    tiltShift: 0.55,
  },
  'Night festival': {
    fogColor: 0x1d2340,
    fogNear: 8,
    fogFar: 48,
    skyTop: 0x090d22,
    skyHorizon: 0x27305c,
    skyBottom: 0x151a30,
    sunColor: 0x9fb6ff,
    sunIntensity: 0.35,
    ambientIntensity: 0.35,
    sunAzimuth: 300,
    sunElevation: 35,
    bloom: 1.1,
    tiltShift: 0.45,
  },
  Overcast: {
    fogColor: 0xc8cdd2,
    fogNear: 18,
    fogFar: 70,
    skyTop: 0x8f9aa6,
    skyHorizon: 0xc8cdd2,
    skyBottom: 0xb3b8bd,
    sunColor: 0xe8eef5,
    sunIntensity: 0.75,
    ambientIntensity: 0.85,
    sunAzimuth: 180,
    sunElevation: 60,
    bloom: 0.2,
    tiltShift: 0.3,
  },
}

/** Preset fog distances are authored for a map this many tiles across. */
export const PRESET_REFERENCE_SPAN = 32

/**
 * Fog distances in a preset describe a *look*, not an absolute distance, so
 * they scale with the map. Without this, opening a 64-tile map with a preset
 * authored against a 32-tile one buries the far half of the level in fog.
 */
export function makeAtmosphere(preset = 'Clear noon', mapSpan = PRESET_REFERENCE_SPAN): Atmosphere {
  const base = ATMOSPHERE_PRESETS[preset] ?? ATMOSPHERE_PRESETS['Clear noon']
  const scale = Math.max(0.25, mapSpan / PRESET_REFERENCE_SPAN)
  return {
    preset,
    ...base,
    fogNear: Math.round(base.fogNear * scale),
    fogFar: Math.round(base.fogFar * scale),
    backdrop: [],
  }
}

export function defaultCameraRig(): CameraRig {
  return {
    yaw: 45,
    pitch: 35,
    distance: 22,
    fov: 30,
    bounds: {
      yawMin: -180,
      yawMax: 180,
      pitchMin: 20,
      pitchMax: 60,
      distMin: 8,
      distMax: 40,
    },
    yawSnapDeg: 0,
    projection: 'perspective',
  }
}

let idCounter = 0

/** Stable IDs assigned at creation and never changed. Prefab overrides will depend on this. */
export function newId(prefix = 'obj'): string {
  idCounter += 1
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, '0')
  return `${prefix}_${rand}${idCounter.toString(36)}`
}

/** A flat voxel volume of `width` × `height` cells at height 2, standing on `parent` (or the ground). */
export function createVoxel(width: number, height: number, name = 'Ground', parent: string | null = null, id = newId('vox')): VoxelStructure {
  const count = width * height
  return {
    id,
    kind: 'voxel',
    name,
    parent,
    placement: { x: 0, z: 0, yaw: 0 },
    size: { width, height },
    terrain: {
      height: new Array<number>(count).fill(2),
      material: new Array<number>(count).fill(0),
      ramp: new Array<number>(count).fill(NO_RAMP),
      water: new Array<number>(count).fill(NO_WATER),
    },
    paint: { top: {}, cliff: {}, tint: {} },
  }
}

/** A new level: one root voxel volume of the given size, and nothing else. Its id is always `ground`, so a test or a tour can name it without looking it up. */
export function createMap(width = 32, height = 32, name = 'Untitled Map'): MapDoc {
  const ground = createVoxel(width, height, 'Ground', null, 'ground')
  return {
    formatVersion: FORMAT_VERSION,
    id: newId('map'),
    name,
    texelDensity: 16,
    filtering: 'nearest',
    materials: DEFAULT_MATERIALS.map((m) => ({ ...m })),
    surfaceMaterials: defaultSurfaceMaterials(),
    structures: { [ground.id]: ground },
    structureOrder: [ground.id],
    objects: {},
    objectOrder: [],
    camera: defaultCameraRig(),
    atmosphere: makeAtmosphere('Clear noon', Math.max(width, height)),
  }
}
