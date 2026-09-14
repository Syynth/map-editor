/**
 * The filesystem seam the project is read and written through.
 *
 * The desktop shell's `ShellFs` (`@papercut/shell-api`) satisfies it as it
 * is — the names and shapes are its — so the editor hands the shell's `fs`
 * straight in. The browser build and the tests use `MemoryFs`, which keeps
 * a folder tree in memory and can be snapshotted to a string, so the Pages
 * deploy keeps a project across reloads in `localStorage` and a test builds
 * a project without touching a disk.
 *
 * Paths are absolute and joined with `/`; Node accepts that on every
 * platform the shell runs on, and the project file itself only ever holds
 * paths relative to its folder.
 */

export type EntryKind = 'file' | 'directory' | 'symlink' | 'other'

export interface DirEntry {
  readonly name: string
  readonly kind: EntryKind
}

export interface ProjectFs {
  readTextFile(path: string): Promise<string>
  readFile(path: string): Promise<Uint8Array>
  /** Creates or replaces the file. Parent directories must exist. */
  writeFile(path: string, data: Uint8Array | string): Promise<void>
  readDir(path: string): Promise<DirEntry[]>
  exists(path: string): Promise<boolean>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
}

/** Join path segments with `/`, collapsing doubled and trailing slashes; a segment is never `..`-resolved here. */
export function joinPath(...parts: string[]): string {
  const joined = parts.filter((p) => p.length > 0).join('/')
  const collapsed = joined.replace(/\/{2,}/g, '/')
  return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed
}

/** The folder a path sits in: `/a/b/c.png` → `/a/b`; a bare name has none. */
export function parentPath(path: string): string {
  const at = path.lastIndexOf('/')
  return at <= 0 ? (at === 0 ? '/' : '') : path.slice(0, at)
}

export class FsError extends Error {
  constructor(
    readonly code: 'ENOENT' | 'EEXIST' | 'ENOTDIR' | 'EISDIR',
    message: string,
  ) {
    super(`[${code}] ${message}`)
  }
}

interface MemorySnapshot {
  readonly dirs: readonly string[]
  /** Path → base64 of the bytes. */
  readonly files: Readonly<Record<string, string>>
}

// UTF-8 through the runtime's own coders, reached the way `btoa` is below: this package compiles without `DOM` in `lib`.
interface Utf8 {
  TextEncoder: new () => { encode(input: string): Uint8Array }
  TextDecoder: new () => { decode(input: Uint8Array): string }
}
const encoder = new (globalThis as unknown as Utf8).TextEncoder()
const decoder = new (globalThis as unknown as Utf8).TextDecoder()

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  // `btoa` is in every runtime this package runs in — browsers and Node 16+ — without `DOM` in `lib`.
  return (globalThis as unknown as { btoa: (s: string) => string }).btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = (globalThis as unknown as { atob: (s: string) => string }).atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** A folder tree in memory. `/` always exists. */
export class MemoryFs implements ProjectFs {
  private readonly dirs = new Set<string>(['/'])
  private readonly files = new Map<string, Uint8Array>()
  /** Called after every write, for a host that persists the tree. */
  onChange: (() => void) | null = null

  static restore(text: string): MemoryFs {
    const snapshot = JSON.parse(text) as MemorySnapshot
    const fs = new MemoryFs()
    for (const dir of snapshot.dirs) fs.dirs.add(dir)
    for (const [path, data] of Object.entries(snapshot.files)) fs.files.set(path, fromBase64(data))
    return fs
  }

  snapshot(): string {
    const files: Record<string, string> = {}
    for (const [path, bytes] of this.files) files[path] = toBase64(bytes)
    return JSON.stringify({ dirs: [...this.dirs], files } satisfies MemorySnapshot)
  }

  readFile(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path)
    if (!bytes) return Promise.reject(new FsError(this.dirs.has(path) ? 'EISDIR' : 'ENOENT', `${path}: no such file`))
    return Promise.resolve(bytes.slice())
  }

  async readTextFile(path: string): Promise<string> {
    return decoder.decode(await this.readFile(path))
  }

  writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const parent = parentPath(path)
    if (!this.dirs.has(parent)) return Promise.reject(new FsError('ENOENT', `${parent}: no such directory`))
    if (this.dirs.has(path)) return Promise.reject(new FsError('EISDIR', `${path}: is a directory`))
    this.files.set(path, typeof data === 'string' ? encoder.encode(data) : data.slice())
    this.onChange?.()
    return Promise.resolve()
  }

  readDir(path: string): Promise<DirEntry[]> {
    if (!this.dirs.has(path)) return Promise.reject(new FsError(this.files.has(path) ? 'ENOTDIR' : 'ENOENT', `${path}: no such directory`))
    const prefix = path === '/' ? '/' : `${path}/`
    const entries: DirEntry[] = []
    for (const dir of this.dirs) if (dir !== path && dir.startsWith(prefix) && !dir.slice(prefix.length).includes('/')) entries.push({ name: dir.slice(prefix.length), kind: 'directory' })
    for (const file of this.files.keys()) if (file.startsWith(prefix) && !file.slice(prefix.length).includes('/')) entries.push({ name: file.slice(prefix.length), kind: 'file' })
    // Folders first, then by name: the order a listing reads in.
    return Promise.resolve(entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1)))
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.dirs.has(path) || this.files.has(path))
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (this.dirs.has(path)) {
      if (options?.recursive) return
      throw new FsError('EEXIST', `${path}: already exists`)
    }
    if (this.files.has(path)) throw new FsError('EEXIST', `${path}: is a file`)
    const parent = parentPath(path)
    if (!this.dirs.has(parent)) {
      if (!options?.recursive) throw new FsError('ENOENT', `${parent}: no such directory`)
      await this.mkdir(parent, options)
    }
    this.dirs.add(path)
    this.onChange?.()
  }
}
