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

import { createMap, serialize, serializeProject, type RgbaImage } from '@papercut/document'
import type { Host } from '@papercut/editor-host'
import { createSampleMap, generatePlaceholderTerrainSet } from '@papercut/fixtures'
import { MemoryFs, addMap, addSheet, createProjectFolder, forget, openProject, parseRecents, readMap, remember, writeMap, writeProject, type ImageCodec, type NewSheet, type OpenedProject, type ProjectFs, type RecentProject } from '@papercut/project'
import { desktopShell, type ShellDialogs } from '@papercut/shell-api'

import { refusal } from './commands'
import { encodePngWithCanvas } from './rgba'

const RECENTS_KEY = 'papercut:recents'
const REOPEN_KEY = 'papercut:reopen-last'
const MEMORY_FS_KEY = 'papercut:memory-fs'
/** Where the browser build keeps its projects: a folder tree that exists only in `localStorage`. */
export const MEMORY_PROJECTS_DIR = '/projects'
const SAMPLE_FOLDER = `${MEMORY_PROJECTS_DIR}/sample-valley`

export interface Session {
  readonly fs: ProjectFs
  readonly codec: ImageCodec
  /** The shell's native dialogs, or `null` in a browser, where a folder is chosen another way. */
  readonly dialogs: ShellDialogs | null
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

/** The in-memory folder tree, restored from `localStorage` and persisted after every write. */
function memoryFs(): MemoryFs {
  const store = storage()
  let fs: MemoryFs
  try {
    const saved = store?.getItem(MEMORY_FS_KEY)
    fs = saved ? MemoryFs.restore(saved) : new MemoryFs()
  } catch {
    fs = new MemoryFs()
  }
  fs.onChange = () => {
    try {
      store?.setItem(MEMORY_FS_KEY, fs.snapshot())
    } catch {
      // Quota or a private window; the tree lives on in memory for the session.
    }
  }
  return fs
}

/** The session for this build: the shell's filesystem and dialogs when there is a shell, the memory tree otherwise. */
export async function createSession(): Promise<Session> {
  const shell = desktopShell()
  if (shell) return { fs: shell.fs, codec: canvasCodec, dialogs: shell.dialogs }
  const fs = memoryFs()
  // First run in a browser: the sample project, so there is something to open.
  if (!(await fs.exists(`${SAMPLE_FOLDER}/papercut.json`))) {
    const placeholder = generatePlaceholderTerrainSet(16)
    await createProjectFolder(fs, SAMPLE_FOLDER, { name: 'Sample Valley', texelDensity: 16, placeholder, firstMap: createSampleMap() }, canvasCodec)
  }
  return { fs, codec: canvasCodec, dialogs: null }
}

// --- recents ---------------------------------------------------------------

export function recents(): RecentProject[] {
  return parseRecents(storage()?.getItem(RECENTS_KEY) ?? null)
}

function saveRecents(list: readonly RecentProject[]): void {
  storage()?.setItem(RECENTS_KEY, JSON.stringify(list))
}

export function reopenLast(): boolean {
  return storage()?.getItem(REOPEN_KEY) === '1'
}

export function setReopenLast(on: boolean): void {
  storage()?.setItem(REOPEN_KEY, on ? '1' : '0')
}

// --- opening ---------------------------------------------------------------

const notify = (host: Host, notice: string | null): void => void host.dispatch('view.set', { notice })

/** Put an opened project and its sheets in front of the editor: the project, then its first map, then the art. */
async function install(host: Host, session: Session, folder: string, opened: OpenedProject): Promise<void> {
  const loaded = refusal(host.dispatch('project.load', { folder, json: serializeProject(opened.project) }))
  if (loaded !== null) throw new Error(loaded)
  let path = opened.project.maps[0] ?? null
  if (path === null) {
    // A project with no map is not one the editor made, but it is not refused: it gets a first map.
    const added = await addMap(session.fs, folder, opened.project, createMap(32, 32, opened.project.name))
    path = added.path
    host.dispatch('project.maps.set', { maps: added.project.maps })
  }
  await openMapAt(host, session, path)
  host.children.viewport.send({ type: 'terrain', sets: opened.sets, warning: opened.warnings.length ? opened.warnings.join('\n') : null })
  saveRecents(remember(recents(), { name: opened.project.name, folder, openedAt: Date.now() }))
}

/** Open the project in `folder`. Throws with a message the startup screen shows; a folder that is not there is dropped from recents. */
export async function openProjectAt(host: Host, session: Session, folder: string): Promise<void> {
  let opened
  try {
    opened = await openProject(session.fs, folder, session.codec)
  } catch (error) {
    saveRecents(forget(recents(), folder))
    throw new Error(`Could not open ${folder}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
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
  if (map !== null && map !== path) await writeMap(session.fs, folder, map, host.reader.doc)
  const doc = await readMap(session.fs, folder, path)
  const why = refusal(host.dispatch('document.load', { json: serialize(doc) }))
  if (why !== null) throw new Error(why)
  host.dispatch('project.current', { map: path })
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
  await writeProject(session.fs, folder, host.children.project.getSnapshot().context.project)
  if (map !== null) await writeMap(session.fs, folder, map, host.reader.doc)
  return map ?? 'papercut.json'
}

/** Copy a sheet into the project's `sheets/` and list it; reloads the sheets the viewport draws with. */
export async function addSheetTo(host: Host, session: Session, sheet: NewSheet): Promise<void> {
  const { folder } = location(host)
  const project = host.children.project.getSnapshot().context.project
  const next = await addSheet(session.fs, folder, project, sheet)
  host.dispatch('project.sheets.set', { sheets: next.sheets })
  const reopened = await openProject(session.fs, folder, session.codec)
  host.children.viewport.send({ type: 'terrain', sets: reopened.sets, warning: reopened.warnings.length ? reopened.warnings.join('\n') : null })
}

/** Save, then close: back to the startup screen. */
export async function closeProject(host: Host, session: Session): Promise<void> {
  await saveNow(host, session)
  host.dispatch('project.close')
  host.children.viewport.send({ type: 'terrain', sets: [], warning: null })
  notify(host, null)
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
