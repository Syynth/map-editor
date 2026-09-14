/**
 * A project folder on disk: opening one, creating one, and the maps and
 * sheets inside it (decision-log 2026-09-14, "The app opens projects only").
 *
 * The folder is anchored on `papercut.json`; everything else is where the
 * project file says it is, relative to the folder. Opening reads the project
 * file strictly and then each sheet with a terrain set: the sidecar and the
 * image. A sheet that cannot be read is a WARNING, not a failure — the
 * project opens, the sheet is reported, and the runtime draws the materials
 * that pointed into it from the placeholder set or as flat colour — because
 * a missing PNG is the artist's to relink, not a reason to refuse the level.
 *
 * Every write here is whole-file: a map, the project file, a sheet. Nothing
 * is patched in place, so a crash mid-write loses one file, never a folder.
 */

import { MAPS_DIR, PROJECT_FILE, SHEETS_DIR, createMap, createProject, deserialize, parseProject, serialize, serializeProject, sheetName, type MapDoc, type ProjectDoc, type ReadonlyMapDoc, type ReadonlyProjectDoc, type SheetEntry } from '@papercut/document'
import { parseTerrainSet, serializeTerrainSet, type LoadedSet, type TerrainSet } from '@papercut/geometry'

import type { ImageCodec } from './codec'
import { joinPath, parentPath, type ProjectFs } from './fs'

export interface OpenedProject {
  project: ProjectDoc
  /** The terrain sets that loaded, one per sheet with a sidecar, in the project's order. */
  sets: LoadedSet[]
  /** What could not be loaded, one line each, in the artist's terms. */
  warnings: string[]
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Read one sheet's sidecar and image; `null`, with the reason, when either is not there or not right. */
async function loadSheet(fs: ProjectFs, folder: string, entry: SheetEntry, codec: ImageCodec): Promise<{ set: LoadedSet | null; warning: string | null }> {
  const name = sheetName(entry.path)
  if (entry.terrainSet === null) return { set: null, warning: null }
  let set: TerrainSet
  try {
    set = parseTerrainSet(JSON.parse(await fs.readTextFile(joinPath(folder, entry.terrainSet))))
  } catch (error) {
    return { set: null, warning: `${entry.terrainSet}: ${messageOf(error)}` }
  }
  // The project names the sheet by its file; a sidecar written for another file name is retagged, not refused.
  if (set.sheet !== name) set = { ...set, sheet: name }
  if (set.tile !== entry.tile) return { set: null, warning: `${entry.terrainSet} tags ${set.tile} px tiles, but the project lists ${name} at ${entry.tile} px.` }
  let image
  try {
    image = await codec.decode(await fs.readFile(joinPath(folder, entry.path)))
  } catch (error) {
    return { set: null, warning: `${entry.path}: ${messageOf(error)}` }
  }
  if (image.width !== set.columns * set.tile || image.height !== set.rows * set.tile) {
    return { set: null, warning: `${entry.path} is ${image.width}×${image.height}, but its terrain set describes ${set.columns}×${set.rows} tiles of ${set.tile} px.` }
  }
  return { set: { set, image }, warning: null }
}

/** Open the project in `folder`: its file, then every sheet it lists. Throws only when the project file itself is missing or unreadable. */
export async function openProject(fs: ProjectFs, folder: string, codec: ImageCodec): Promise<OpenedProject> {
  const project = parseProject(await fs.readTextFile(joinPath(folder, PROJECT_FILE)))
  const sets: LoadedSet[] = []
  const warnings: string[] = []
  for (const entry of project.sheets) {
    const { set, warning } = await loadSheet(fs, folder, entry, codec)
    if (set) sets.push(set)
    if (warning) warnings.push(warning)
  }
  for (const map of project.maps) if (!(await fs.exists(joinPath(folder, map)))) warnings.push(`${map} is listed but not in the folder.`)
  return { project, sets, warnings }
}

export async function readMap(fs: ProjectFs, folder: string, path: string): Promise<MapDoc> {
  return deserialize(await fs.readTextFile(joinPath(folder, path)))
}

export async function writeMap(fs: ProjectFs, folder: string, path: string, doc: ReadonlyMapDoc): Promise<void> {
  await fs.writeFile(joinPath(folder, path), serialize(doc))
}

export async function writeProject(fs: ProjectFs, folder: string, project: ReadonlyProjectDoc): Promise<void> {
  await fs.writeFile(joinPath(folder, PROJECT_FILE), serializeProject(project))
}

/** A file name from a map's name: `Harbour Town` → `harbour-town`; never empty. */
export function slugOf(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'map'
}

/** The path a new map takes in the project: `maps/<slug>.map.json`, suffixed until it is not one the project already lists. */
export function mapPathFor(project: ReadonlyProjectDoc, name: string): string {
  const slug = slugOf(name)
  let path = `${MAPS_DIR}/${slug}.map.json`
  for (let n = 2; project.maps.includes(path); n++) path = `${MAPS_DIR}/${slug}-${n}.map.json`
  return path
}

export interface NewProjectOptions {
  name: string
  texelDensity: number
  /** The placeholder terrain set drawn for that density, written into `sheets/` so the folder stands on its own. */
  placeholder: LoadedSet
  /** The first map, written and listed first; an empty 32 × 32 map named for the project when absent. */
  firstMap?: MapDoc
}

/** Create a project folder: the project file, one map, and the placeholder sheet beside its sidecar. Refuses a folder that already holds a project. */
export async function createProjectFolder(fs: ProjectFs, folder: string, options: NewProjectOptions, codec: ImageCodec): Promise<OpenedProject> {
  if (await fs.exists(joinPath(folder, PROJECT_FILE))) throw new Error(`${folder} already holds a project.`)
  await fs.mkdir(folder, { recursive: true })
  await fs.mkdir(joinPath(folder, MAPS_DIR), { recursive: true })
  await fs.mkdir(joinPath(folder, SHEETS_DIR), { recursive: true })
  const project = createProject(options.name, options.texelDensity)
  const sheet = project.sheets[0]
  const placeholder: LoadedSet = { set: { ...options.placeholder.set, sheet: sheetName(sheet.path) }, image: options.placeholder.image }
  await fs.writeFile(joinPath(folder, sheet.path), await codec.encode(placeholder.image))
  if (sheet.terrainSet) await fs.writeFile(joinPath(folder, sheet.terrainSet), serializeTerrainSet(placeholder.set))
  const first = options.firstMap ?? createMap(32, 32, options.name)
  const path = mapPathFor(project, first.name)
  await writeMap(fs, folder, path, first)
  project.maps = [path]
  await writeProject(fs, folder, project)
  return { project, sets: [placeholder], warnings: [] }
}

/** Write a new map into the project and list it last. Returns the project as it now is and where the map went. */
export async function addMap(fs: ProjectFs, folder: string, project: ReadonlyProjectDoc, doc: MapDoc): Promise<{ project: ProjectDoc; path: string }> {
  const path = mapPathFor(project, doc.name)
  await fs.mkdir(joinPath(folder, parentPath(path)), { recursive: true })
  await writeMap(fs, folder, path, doc)
  const next: ProjectDoc = { ...(project as ProjectDoc), maps: [...project.maps, path] }
  await writeProject(fs, folder, next)
  return { project: next, path }
}

export interface NewSheet {
  /** The file name the sheet goes by: `cliffs.png`. */
  name: string
  /** The image as it will be written, already encoded. */
  bytes: Uint8Array
  tile: number
  /** The terrain set tagging it, written as `sheets/<name>.terrain.json`; `null` for an image nothing autotiles from. */
  set: TerrainSet | null
}

/** Copy a sheet into `sheets/` and list it, replacing an entry of the same name. Returns the project as it now is. */
export async function addSheet(fs: ProjectFs, folder: string, project: ReadonlyProjectDoc, sheet: NewSheet): Promise<ProjectDoc> {
  const path = `${SHEETS_DIR}/${sheet.name}`
  const sidecar = sheet.set ? `${SHEETS_DIR}/${sheet.name.replace(/\.[^.]+$/, '')}.terrain.json` : null
  await fs.mkdir(joinPath(folder, SHEETS_DIR), { recursive: true })
  await fs.writeFile(joinPath(folder, path), sheet.bytes)
  if (sheet.set && sidecar) await fs.writeFile(joinPath(folder, sidecar), serializeTerrainSet({ ...sheet.set, sheet: sheet.name }))
  const entry: SheetEntry = { path, tile: sheet.tile, terrainSet: sidecar }
  const sheets = project.sheets.some((s) => sheetName(s.path) === sheet.name) ? project.sheets.map((s) => (sheetName(s.path) === sheet.name ? entry : { ...s })) : [...project.sheets.map((s) => ({ ...s })), entry]
  const next: ProjectDoc = { ...(project as ProjectDoc), sheets }
  await writeProject(fs, folder, next)
  return next
}
