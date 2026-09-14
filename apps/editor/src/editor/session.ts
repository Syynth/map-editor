/**
 * The project session: where the open project lives and how it gets there.
 *
 * The host holds the project's contents and its location; the files are this
 * module's business. It reads and writes them through `@papercut/project`
 * over one of two filesystems — the desktop shell's, granted folder by
 * folder through its dialogs, or a folder tree in memory for the browser
 * build, which keeps it in `localStorage` and seeds it with the sample
 * project on first run so the Pages deploy and the dev server open on
 * something. The seam is the same either way, so opening a project is one
 * code path with two ways of choosing a folder.
 *
 * Every function here is a SEQUENCE of dispatches around the file work: read
 * the project file, `project.load`; read the first map, `document.load`;
 * hand the viewport the sheets. Nothing in an actor touches a file.
 */

import { SHEETS_DIR, createMap, serialize, serializeProject, sheetName, type RgbaImage } from '@papercut/document'
import type { Host } from '@papercut/editor-host'
import { createSampleMap, generatePlaceholderTerrainSet } from '@papercut/fixtures'
import { parseTerrainSet, serializeTerrainSet, type LoadedSet, type TerrainSet } from '@papercut/geometry'
import { MemoryFs, addMap, addSheet, createProjectFolder, forget, joinPath, openProject, parseRecents, readMap, remember, writeMap, writeProject, type ImageCodec, type NewSheet, type OpenedProject, type ProjectFs, type RecentProject } from '@papercut/project'
import { exportGltf } from '@papercut/runtime/export'
import { desktopShell, type MenuCommand, type ShellDialogs, type ShellMenu } from '@papercut/shell-api'

import { artFor, drawableTerrain } from './art'
import { refusal, run } from './commands'
import { encodePngWithCanvas } from './rgba'

const RECENTS_KEY = 'papercut:recents'
const REOPEN_KEY = 'papercut:reopen-last'
const MEMORY_FS_KEY = 'papercut:memory-fs'
/** The folder open when the page last ran, so a reload comes back to it. Cleared on close. */
const OPEN_FOLDER_KEY = 'papercut:open-folder'
/** Per folder, the map that was open there last, so opening a project comes back to it. */
const LAST_MAP_PREFIX = 'papercut:last-map:'
/** How long the browser's memory tree waits for writes to stop before it snapshots itself to localStorage. */
const SNAPSHOT_DELAY_MS = 300
/** Where the browser build keeps its projects: a folder tree that exists only in `localStorage`. */
export const MEMORY_PROJECTS_DIR = '/projects'
const SAMPLE_FOLDER = `${MEMORY_PROJECTS_DIR}/sample-valley`

export interface Session {
  readonly fs: ProjectFs
  readonly codec: ImageCodec
  /** The shell's native dialogs, or `null` in a browser, where a folder is chosen another way. */
  readonly dialogs: ShellDialogs | null
  /** The shell's native menu, or `null` in a browser. */
  readonly menu: ShellMenu | null
  /** When this session last wrote into the project folder, so a watch can tell its own writes from someone else's. */
  lastWriteAt: number
  /** What the last persistence failure said — the browser's storage refusing the memory tree — or `null`; read and cleared by whoever reports it. */
  persistFailure: string | null
}

/** The browser's PNG codec: the canvas encodes, an `Image` decodes. */
const canvasCodec: ImageCodec = {
  encode: encodePngWithCanvas,
  async decode(bytes) {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }))
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image()
        element.onload = () => resolve(element)
        element.onerror = () => reject(new Error('Could not decode the image.'))
        element.src = url
      })
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('2D canvas unavailable')
      ctx.drawImage(image, 0, 0)
      const data: RgbaImage['data'] = ctx.getImageData(0, 0, image.width, image.height).data
      return { width: image.width, height: image.height, data }
    } finally {
      URL.revokeObjectURL(url)
    }
  },
}

function storage(): Storage | null {
  try {
    return localStorage
  } catch {
    return null
  }
}

/** The in-memory folder tree, restored from `localStorage` and persisted once writes settle; a failure is kept for the session to report. */
function memoryFs(onFailure: (message: string) => void): MemoryFs {
  const store = storage()
  let fs: MemoryFs
  try {
    const saved = store?.getItem(MEMORY_FS_KEY)
    fs = saved ? MemoryFs.restore(saved) : new MemoryFs()
  } catch {
    fs = new MemoryFs()
  }
  let pending: ReturnType<typeof setTimeout> | undefined
  const persist = (): void => {
    pending = undefined
    try {
      store?.setItem(MEMORY_FS_KEY, fs.snapshot())
    } catch (error) {
      // Quota or a private window: the tree lives on in memory for the session, and the editor says so.
      onFailure(`This browser cannot keep the project: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  fs.onChange = () => {
    clearTimeout(pending)
    pending = setTimeout(persist, SNAPSHOT_DELAY_MS)
  }
  window.addEventListener('pagehide', () => {
    if (pending !== undefined) {
      clearTimeout(pending)
      persist()
    }
  })
  return fs
}

/** The session for this build: the shell's filesystem and dialogs when there is a shell, the memory tree otherwise. */
export async function createSession(): Promise<Session> {
  const shell = desktopShell()
  if (shell) return { fs: shell.fs, codec: canvasCodec, dialogs: shell.dialogs, menu: shell.menu ?? null, lastWriteAt: 0, persistFailure: null }
  const session: Session = { fs: new MemoryFs(), codec: canvasCodec, dialogs: null, menu: null, lastWriteAt: 0, persistFailure: null }
  const fs = memoryFs((message) => {
    session.persistFailure = message
  })
  ;(session as { fs: ProjectFs }).fs = fs
  // First run in a browser: the sample project, so there is something to open.
  if (!(await fs.exists(`${SAMPLE_FOLDER}/papercut.json`))) {
    const placeholder = generatePlaceholderTerrainSet(16)
    await createProjectFolder(fs, SAMPLE_FOLDER, { name: 'Sample Valley', texelDensity: 16, placeholder, firstMap: createSampleMap() }, canvasCodec)
  }
  return session
}

// --- recents ---------------------------------------------------------------

export function recents(): RecentProject[] {
  return parseRecents(storage()?.getItem(RECENTS_KEY) ?? null)
}

function saveRecents(list: readonly RecentProject[]): void {
  storage()?.setItem(RECENTS_KEY, JSON.stringify(list))
  void desktopShell()?.menu?.setRecents(list.map((r) => ({ name: r.name, folder: r.folder }))).catch(() => undefined)
}

export function reopenLast(): boolean {
  return storage()?.getItem(REOPEN_KEY) === '1'
}

export function setReopenLast(on: boolean): void {
  storage()?.setItem(REOPEN_KEY, on ? '1' : '0')
}

/** The folder that was open when the page last ran, or `null`: what a reload comes back to. */
export function openFolder(): string | null {
  return storage()?.getItem(OPEN_FOLDER_KEY) ?? null
}

function rememberOpen(folder: string | null): void {
  if (folder === null) storage()?.removeItem(OPEN_FOLDER_KEY)
  else storage()?.setItem(OPEN_FOLDER_KEY, folder)
}

function lastMapIn(folder: string): string | null {
  return storage()?.getItem(LAST_MAP_PREFIX + folder) ?? null
}

/** A write per path at a time: the autosave and an explicit save landing together cannot interleave on one file. */
const inFlight = new Map<string, Promise<unknown>>()
function queued<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(path) ?? Promise.resolve()
  const next = previous.then(work, work)
  inFlight.set(path, next.catch(() => undefined))
  return next
}

// --- opening ---------------------------------------------------------------

const notify = (host: Host, notice: string | null): void => void host.dispatch('view.set', { notice })

/**
 * Put an opened project and its sheets in front of the editor: the map first — the one open there last, else the
 * first listed map that is in the folder — read and checked BEFORE the project is switched, so a project whose maps
 * cannot be read is refused whole rather than opened onto a placeholder that nothing would ever write.
 */
async function install(host: Host, session: Session, folder: string, opened: OpenedProject): Promise<void> {
  let project = opened.project
  const candidates = [lastMapIn(folder), ...project.maps].filter((p): p is string => p !== null && project.maps.includes(p))
  let path: string | null = null
  for (const candidate of candidates) {
    if (await session.fs.exists(joinPath(folder, candidate))) {
      path = candidate
      break
    }
  }
  let doc
  if (path === null) {
    // A project with no readable map is not one the editor made, but it is not refused: it gets a first map.
    doc = createMap(32, 32, project.name)
    const added = await addMap(session.fs, folder, project, doc)
    path = added.path
    project = added.project
  } else {
    try {
      doc = await readMap(session.fs, folder, path)
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }
  const json = serialize(doc)
  const loaded = refusal(host.dispatch('project.load', { folder, json: serializeProject(project) }))
  if (loaded !== null) throw new Error(loaded)
  const why = refusal(host.dispatch('document.load', { json }))
  if (why !== null) {
    host.dispatch('project.close')
    throw new Error(`${path}: ${why}`)
  }
  host.dispatch('project.current', { map: path })
  rememberOpen(folder)
  host.children.viewport.send({ type: 'terrain', sets: opened.sets, warning: opened.warnings.length ? opened.warnings.join('\n') : null })
  saveRecents(remember(recents(), { name: project.name, folder, openedAt: Date.now() }))
}

/** Whether an error says the thing is simply not there, as opposed to unreadable. */
function isMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\[ENOENT\]/.test(message)
}

/** Open the project in `folder`, saving the one that is open first. Throws with a message the startup screen shows; a folder that is not there is dropped from recents. */
export async function openProjectAt(host: Host, session: Session, folder: string): Promise<void> {
  let opened
  try {
    opened = await openProject(session.fs, folder, session.codec)
  } catch (error) {
    if (isMissing(error)) saveRecents(forget(recents(), folder))
    throw new Error(`Could not open ${folder}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (host.children.project.getSnapshot().context.folder !== null) await saveNow(host, session)
  await install(host, session, folder, opened)
}

export interface NewProjectSpec {
  folder: string
  name: string
  texelDensity: number
}

/** Create a project folder and open it. */
export async function createProjectAt(host: Host, session: Session, spec: NewProjectSpec): Promise<void> {
  const placeholder = generatePlaceholderTerrainSet(spec.texelDensity)
  const created = await createProjectFolder(session.fs, spec.folder, { name: spec.name, texelDensity: spec.texelDensity, placeholder }, session.codec)
  if (host.children.project.getSnapshot().context.folder !== null) await saveNow(host, session)
  await install(host, session, spec.folder, created)
}

function location(host: Host): { folder: string; map: string | null } {
  const { folder, map } = host.children.project.getSnapshot().context
  if (folder === null) throw new Error('No project is open.')
  return { folder, map }
}

/** Open one of the project's maps as the document, saving the one that was open first. */
export async function openMapAt(host: Host, session: Session, path: string): Promise<void> {
  const { folder, map } = location(host)
  // The open map is open: nothing to reload, and reloading it would drop the undo history.
  if (map === path) return
  if (map !== null) await saveNow(host, session)
  const doc = await readMap(session.fs, folder, path)
  const why = refusal(host.dispatch('document.load', { json: serialize(doc) }))
  if (why !== null) throw new Error(why)
  host.dispatch('project.current', { map: path })
  storage()?.setItem(LAST_MAP_PREFIX + folder, path)
}

/** A new, empty map in the project, listed last and opened. */
export async function newMapIn(host: Host, session: Session, name: string, width = 32, height = 32): Promise<void> {
  const { folder } = location(host)
  const project = host.children.project.getSnapshot().context.project
  const added = await addMap(session.fs, folder, project, createMap(width, height, name))
  host.dispatch('project.maps.set', { maps: added.project.maps })
  await openMapAt(host, session, added.path)
}

/** Write the document to its map file, and the project to its file. What the Save button and the autosave do. */
export async function saveNow(host: Host, session: Session): Promise<string> {
  const { folder, map } = location(host)
  session.lastWriteAt = Date.now()
  // Both writes start at once, the map's first: on `pagehide` the page may not live to see a second one begin.
  const project = host.children.project.getSnapshot().context.project
  const doc = host.reader.doc
  await Promise.all([
    map === null ? Promise.resolve() : queued(joinPath(folder, map), () => writeMap(session.fs, folder, map, doc)),
    queued(joinPath(folder, 'papercut.json'), () => writeProject(session.fs, folder, project)),
  ])
  return map ?? 'papercut.json'
}

/** Copy a sheet into the project's `sheets/` and list it; reloads the sheets the viewport draws with. */
export async function addSheetTo(host: Host, session: Session, sheet: NewSheet): Promise<void> {
  const { folder } = location(host)
  const project = host.children.project.getSnapshot().context.project
  session.lastWriteAt = Date.now()
  const next = await addSheet(session.fs, folder, project, sheet)
  host.dispatch('project.sheets.set', { sheets: next.sheets })
  const reopened = await openProject(session.fs, folder, session.codec)
  host.children.viewport.send({ type: 'terrain', sets: reopened.sets, warning: reopened.warnings.length ? reopened.warnings.join('\n') : null })
}

/** Reload the project's sheets from its folder into the viewport, after something in `sheets/` changed. */
async function reloadSheets(host: Host, session: Session, folder: string): Promise<void> {
  const reopened = await openProject(session.fs, folder, session.codec)
  host.children.viewport.send({ type: 'terrain', sets: reopened.sets, warning: reopened.warnings.length ? reopened.warnings.join('\n') : null })
}

/** Write a sheet's terrain set to its sidecar — creating and listing the sidecar for a sheet that had none — and reload. */
export async function updateTerrainSet(host: Host, session: Session, sheet: string, set: TerrainSet): Promise<void> {
  const { folder } = location(host)
  const project = host.children.project.getSnapshot().context.project
  const entry = project.sheets.find((s) => sheetName(s.path) === sheet)
  if (!entry) throw new Error(`${sheet} is not a sheet of this project.`)
  const sidecar = entry.terrainSet ?? `${SHEETS_DIR}/${sheet.replace(/\.[^.]+$/, '')}.terrain.json`
  session.lastWriteAt = Date.now()
  await session.fs.writeFile(joinPath(folder, sidecar), serializeTerrainSet({ ...set, sheet }))
  if (entry.terrainSet !== sidecar) {
    const sheets = project.sheets.map((s) => (s === entry ? { ...s, terrainSet: sidecar } : { ...s }))
    host.dispatch('project.sheets.set', { sheets })
    await writeProject(session.fs, folder, host.children.project.getSnapshot().context.project)
  }
  // The one set, swapped in over its image: no other sheet is re-read for a rename.
  const { loadedTerrain, terrainWarning } = host.children.viewport.getSnapshot().context
  const swapped = loadedTerrain.some((s) => s.set.sheet === sheet)
  if (swapped) host.children.viewport.send({ type: 'terrain', sets: loadedTerrain.map((s) => (s.set.sheet === sheet ? { set: { ...set, sheet }, image: s.image } : s)), warning: terrainWarning })
  else await reloadSheets(host, session, folder)
}

/** Take a sheet off the project's list. The files stay in the folder; the materials that pointed into it draw from the placeholder or as colour. */
export async function unlistSheet(host: Host, session: Session, sheet: string): Promise<void> {
  const { folder } = location(host)
  const project = host.children.project.getSnapshot().context.project
  host.dispatch('project.sheets.set', { sheets: project.sheets.filter((s) => sheetName(s.path) !== sheet).map((s) => ({ ...s })) })
  await writeProject(session.fs, folder, host.children.project.getSnapshot().context.project)
  await reloadSheets(host, session, folder)
}

/** Change what the project says about a sheet: its tile size. Reloads, since the check against the sidecar depends on it. */
export async function setSheetTile(host: Host, session: Session, sheet: string, tile: number): Promise<void> {
  const { folder } = location(host)
  const project = host.children.project.getSnapshot().context.project
  host.dispatch('project.sheets.set', { sheets: project.sheets.map((s) => (sheetName(s.path) === sheet ? { ...s, tile } : { ...s })) })
  await writeProject(session.fs, folder, host.children.project.getSnapshot().context.project)
  await reloadSheets(host, session, folder)
}

/**
 * Files picked for the project: an image, and its sidecar if it was picked with it. An image alone is listed at the
 * project's tile size with no terrain set — a sprite sheet, say — and gets one the moment a terrain is added to it.
 */
export async function addImagesTo(host: Host, session: Session, files: readonly File[]): Promise<string> {
  const image = files.find((f) => !f.name.endsWith('.json'))
  const sidecar = files.find((f) => f.name.endsWith('.json'))
  if (!image) throw new Error('Pick an image (and its .terrain.json, if it has one).')
  const project = host.children.project.getSnapshot().context.project
  const bytes = new Uint8Array(await image.arrayBuffer())
  let set: TerrainSet | null = null
  if (sidecar) {
    set = parseTerrainSet(JSON.parse(await sidecar.text()))
  } else {
    // A sheet with no sidecar still has to be an image this codec can read: found out now, not at the next open.
    await session.codec.decode(bytes)
  }
  const tile = set?.tile ?? project.resolution.texelDensity
  await addSheetTo(host, session, { name: image.name, bytes, tile, set })
  return tile === project.resolution.texelDensity ? image.name : `${image.name} — ${tile} px tiles, but the project is ${project.resolution.texelDensity} px; it is listed and not drawn`
}

/** Save, then close: back to the startup screen. A save that fails keeps the project open, and says so. */
export async function closeProject(host: Host, session: Session): Promise<void> {
  try {
    await saveNow(host, session)
  } catch (error) {
    throw new Error(`Not closed — the project could not be saved: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  host.dispatch('project.close')
  // The document too: a closed project's map must not linger to be written into the next one.
  host.dispatch('document.new', { width: 2, height: 2, name: 'No map' })
  rememberOpen(null)
  host.children.viewport.send({ type: 'terrain', sets: [], warning: null })
  notify(host, null)
}

/** The open map as a `.glb`, handed to the browser to save: the top bar's Export and the shell's File › Export. */
export async function exportCurrentMap(host: Host): Promise<string> {
  const doc = host.reader.doc
  const project = host.children.project.getSnapshot().context.project
  // The same sets the stage draws with — the project's sheets, the generated placeholder standing in — so what is exported is what was seen.
  const art = artFor(project)
  const terrain = drawableTerrain(art.generatedTerrain, host.children.viewport.getSnapshot().context.loadedTerrain as readonly LoadedSet[], project.resolution.texelDensity)
  const bytes = await exportGltf(doc, { merge: false, textures: art.textures, terrain, materials: project.materials, resolution: project.resolution, sprites: art.sprites, encodePng: encodePngWithCanvas })
  const blob = new Blob([bytes], { type: 'model/gltf-binary' })
  const file = `${doc.name.replace(/\s+/g, '-').toLowerCase()}.glb`
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = file
  link.click()
  URL.revokeObjectURL(url)
  return `Exported ${file} (${(blob.size / 1024).toFixed(0)} KB)`
}

/**
 * The shell's native menu, wired: its commands become the same session calls the page's own controls make, and it is
 * told whether a project is open. Recents reach it through `saveRecents`. No-op in a browser.
 */
export function installShellMenu(host: Host, session: Session): () => void {
  const { menu } = session
  if (!menu) return () => undefined
  const notify = (notice: string): void => run(host, 'view.set', { notice })
  const attempt = (work: Promise<unknown>): void => void work.catch((error: unknown) => notify(error instanceof Error ? error.message : String(error)))
  const onCommand = (command: MenuCommand): void => {
    const open = host.children.project.getSnapshot().context.folder !== null
    if (!open && (command.id === 'map.new' || command.id === 'file.save' || command.id === 'file.export' || command.id === 'project.settings' || command.id === 'project.close')) return
    switch (command.id) {
      case 'project.new':
        run(host, 'view.set', { dialog: 'new-project' })
        return
      case 'project.open':
        attempt(session.dialogs?.openFolder({ title: 'Open a project folder' }).then((folder) => (folder ? openProjectAt(host, session, folder) : undefined)) ?? Promise.resolve())
        return
      case 'project.openRecent':
        attempt(openProjectAt(host, session, command.folder))
        return
      case 'project.close':
        attempt(closeProject(host, session))
        return
      case 'map.new':
        run(host, 'view.set', { dialog: 'new-map' })
        return
      case 'file.save':
        attempt(saveNow(host, session).then(() => notify('Saved')))
        return
      case 'file.export':
        attempt(exportCurrentMap(host).then(notify))
        return
      case 'project.settings':
        run(host, 'view.set', { settings: 'general' })
        return
    }
  }
  const stopCommands = menu.onCommand(onCommand)
  void menu.setRecents(recents().map((r) => ({ name: r.name, folder: r.folder }))).catch(() => undefined)
  let open: boolean | null = null
  const state = host.children.project.subscribe((snapshot) => {
    const now = snapshot.context.folder !== null
    if (now === open) return
    open = now
    void menu.setState({ projectOpen: now }).catch(() => undefined)
  })
  void menu.setState({ projectOpen: host.children.project.getSnapshot().context.folder !== null }).catch(() => undefined)
  return () => {
    stopCommands()
    state.unsubscribe()
  }
}

/** Ignore a watch event this soon after the session's own write into the folder. */
const OWN_WRITE_WINDOW_MS = 1500
const WATCH_SETTLE_MS = 400

/**
 * Watch the open project's `sheets/` for an artist saving a sheet or its sidecar from outside, and reload them when
 * it settles. Only where the filesystem can watch (the shell's); the memory tree has nothing outside it.
 */
export function watchProjectSheets(host: Host, session: Session): () => void {
  const watch = session.fs.watch?.bind(session.fs)
  if (!watch) return () => undefined
  let stop: (() => void) | null = null
  let watching: string | null = null
  let generation = 0
  let settle: ReturnType<typeof setTimeout> | undefined
  const start = (folder: string): void => {
    watching = folder
    const mine = ++generation
    watch(joinPath(folder, SHEETS_DIR), () => {
      if (Date.now() - session.lastWriteAt < OWN_WRITE_WINDOW_MS) return
      clearTimeout(settle)
      settle = setTimeout(() => void reloadSheets(host, session, folder).catch(() => undefined), WATCH_SETTLE_MS)
    })
      .then((end) => {
        if (generation === mine) stop = end
        else end()
      })
      .catch(() => undefined)
  }
  const end = (): void => {
    clearTimeout(settle)
    generation += 1
    stop?.()
    stop = null
    watching = null
  }
  const subscription = host.children.project.subscribe((snapshot) => {
    const { folder } = snapshot.context
    if (folder === watching) return
    end()
    if (folder !== null) start(folder)
  })
  const initial = host.children.project.getSnapshot().context.folder
  if (initial !== null) start(initial)
  return () => {
    subscription.unsubscribe()
    end()
  }
}

/** Every folder under the browser's projects directory that holds a project: what "Open…" offers when there is no shell dialog. */
export async function memoryProjects(session: Session): Promise<Array<{ folder: string; name: string }>> {
  if (!(await session.fs.exists(MEMORY_PROJECTS_DIR))) return []
  const found: Array<{ folder: string; name: string }> = []
  for (const entry of await session.fs.readDir(MEMORY_PROJECTS_DIR)) {
    if (entry.kind !== 'directory') continue
    const folder = `${MEMORY_PROJECTS_DIR}/${entry.name}`
    try {
      const { name } = JSON.parse(await session.fs.readTextFile(`${folder}/papercut.json`)) as { name?: string }
      found.push({ folder, name: typeof name === 'string' ? name : entry.name })
    } catch {
      // Not a project; not offered.
    }
  }
  return found
}
