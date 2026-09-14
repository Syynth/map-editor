/**
 * The project: what every map in a folder shares (decision-log, 2026-09-14).
 *
 * A project is a folder anchored on `papercut.json`. The file holds the
 * material library, the resolution profile, the sheets the materials draw
 * from and the maps in order — everything that would drift if two maps each
 * kept a copy. A map stores only the material ids its voxels hold; a sheet's
 * tile tags stay in the sidecar beside the image, so a sheet is portable
 * between projects.
 *
 * Plain data, read strictly: like the map, one format version and no
 * migrations until a project worth keeping exists. Paths in the file are
 * relative to the folder, forward-slashed, and a sheet is NAMED by its file
 * name — `sheets/ground.png` is the sheet `ground.png`, which is what a
 * material's `TerrainRef` and a terrain set's `sheet` say — so a project
 * can be moved, and a sheet's sidecar and its materials never disagree about
 * what it is called.
 */

import { DEFAULT_MATERIALS, PLACEHOLDER_SHEET, defaultCameraRig, type CameraRig, type DeepReadonly, type MaterialDef, type TerrainRef } from './document'
import { LoadError } from './io'

export const PROJECT_FORMAT_VERSION = 1
/** The file a project is anchored on, at the root of its folder. */
export const PROJECT_FILE = 'papercut.json'
/** Where a project keeps its maps and its sheets, relative to the folder. */
export const MAPS_DIR = 'maps'
export const SHEETS_DIR = 'sheets'

export interface ResolutionProfile {
  /** Pixels per tile. Texture detail only — never world scale. */
  texelDensity: number
  filtering: 'nearest' | 'linear'
}

/** An image the project draws from, and the terrain set that tags it, if it has one. */
export interface SheetEntry {
  /** Relative to the project folder: `sheets/ground.png`. */
  path: string
  /** Pixels per tile the sheet was authored at; checked against the profile, never rescaled. */
  tile: number
  /** The sidecar's path, or `null` for an image nothing autotiles from (sprites, say). */
  terrainSet: string | null
}

export interface ProjectDoc {
  formatVersion: number
  name: string
  resolution: ResolutionProfile
  sheets: SheetEntry[]
  /** The library, in priority order (see `MaterialDef`). */
  materials: MaterialDef[]
  /** The rig every new map starts from. */
  camera: CameraRig
  /** The maps, by path relative to the folder, in the order the project shows them. */
  maps: string[]
}

export type ReadonlyProjectDoc = DeepReadonly<ProjectDoc>

/** The name a sheet goes by — its file name — from its path in the project. */
export function sheetName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The placeholder set's entry: the sheet the default materials point into, beside its sidecar. */
export function placeholderSheet(tile: number): SheetEntry {
  return { path: `${SHEETS_DIR}/${PLACEHOLDER_SHEET}`, tile, terrainSet: `${SHEETS_DIR}/${PLACEHOLDER_SHEET.replace(/\.png$/, '')}.terrain.json` }
}

/** A project with the placeholder sheet and the default materials, and no maps yet. */
export function createProject(name = 'Untitled Project', texelDensity = 16): ProjectDoc {
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    name,
    resolution: { texelDensity, filtering: 'nearest' },
    sheets: [placeholderSheet(texelDensity)],
    materials: DEFAULT_MATERIALS.map((m) => ({ ...m })),
    camera: defaultCameraRig(),
    maps: [],
  }
}

/** A material names its terrains or it is not a material; the rest defaults. Ids are unique, or the list is refused. */
export function normaliseMaterials(raw: unknown): MaterialDef[] {
  if (!Array.isArray(raw)) return DEFAULT_MATERIALS.map((m) => ({ ...m }))
  if (raw.length === 0) throw new LoadError('A project has at least one material.')
  const ids = new Set<number>()
  return raw.map((value, index) => {
    const m = value as Partial<MaterialDef>
    const top = m.top as Partial<TerrainRef> | undefined
    if (!top || typeof top.sheet !== 'string' || typeof top.terrain !== 'string') throw new LoadError(`Material ${index} names no terrain.`)
    const side = m.side as Partial<TerrainRef> | undefined
    const id = typeof m.id === 'number' && Number.isInteger(m.id) && m.id >= 0 ? m.id : index
    if (ids.has(id)) throw new LoadError(`Two materials share the id ${id}.`)
    ids.add(id)
    return {
      id,
      name: typeof m.name === 'string' ? m.name : `Material ${index + 1}`,
      color: typeof m.color === 'number' ? m.color : 0x808080,
      role: m.role === 'top' || m.role === 'wall' ? m.role : 'any',
      top: { sheet: top.sheet, terrain: top.terrain },
      ...(side && typeof side.sheet === 'string' && typeof side.terrain === 'string' ? { side: { sheet: side.sheet, terrain: side.terrain } } : {}),
    }
  })
}

const isRelativePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..')

function normaliseSheets(raw: unknown): SheetEntry[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new LoadError('The sheet list is not a list.')
  const names = new Set<string>()
  return raw.map((value, index) => {
    const s = value as Partial<SheetEntry>
    if (!isRelativePath(s.path)) throw new LoadError(`Sheet ${index} has no path inside the project.`)
    const name = sheetName(s.path)
    if (names.has(name)) throw new LoadError(`Two sheets are both called ${name}; a sheet is named by its file name.`)
    names.add(name)
    if (typeof s.tile !== 'number' || !Number.isInteger(s.tile) || s.tile <= 0) throw new LoadError(`Sheet ${name} has no tile size.`)
    if (s.terrainSet !== null && s.terrainSet !== undefined && !isRelativePath(s.terrainSet)) throw new LoadError(`Sheet ${name} names a terrain set outside the project.`)
    return { path: s.path, tile: s.tile, terrainSet: s.terrainSet ?? null }
  })
}

function normaliseResolution(raw: unknown): ResolutionProfile {
  const r = (raw ?? {}) as Partial<ResolutionProfile>
  const texelDensity = r.texelDensity ?? 16
  if (typeof texelDensity !== 'number' || !Number.isInteger(texelDensity) || texelDensity <= 0) throw new LoadError('The texel density is not a whole number of pixels.')
  return { texelDensity, filtering: r.filtering === 'linear' ? 'linear' : 'nearest' }
}

export function parseProject(text: string): ProjectDoc {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch (error) {
    throw new LoadError(`Not a project file: ${(error as Error).message}`)
  }
  if (!raw || typeof raw !== 'object') throw new LoadError('Not a project file.')
  if (raw.formatVersion !== PROJECT_FORMAT_VERSION) {
    throw new LoadError(`This project is format ${String(raw.formatVersion)}; this build reads format ${PROJECT_FORMAT_VERSION}.`)
  }
  if (raw.maps !== undefined && (!Array.isArray(raw.maps) || !raw.maps.every(isRelativePath))) throw new LoadError('The map list holds something that is not a path inside the project.')
  return {
    formatVersion: PROJECT_FORMAT_VERSION,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Untitled Project',
    resolution: normaliseResolution(raw.resolution),
    sheets: normaliseSheets(raw.sheets),
    materials: normaliseMaterials(raw.materials),
    camera: { ...defaultCameraRig(), ...((raw.camera as Partial<CameraRig>) ?? {}) },
    maps: [...((raw.maps) ?? [])],
  }
}

export function serializeProject(project: ReadonlyProjectDoc): string {
  return JSON.stringify(project, null, 2)
}
