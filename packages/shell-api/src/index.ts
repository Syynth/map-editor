/**
 * The contract between the desktop shell and the web bundle it hosts.
 *
 * `apps/desktop` implements it in its preload; the editor reads it through
 * `desktopShell()`, which is `undefined` in a browser (the Pages build), so
 * every use is naturally feature-detected.
 *
 * Changing this surface is changing the shell, and the shell only changes by a
 * full app update. Adding to it bumps `SHELL_API_VERSION`; a bundle that uses
 * the addition declares that version as its `minShellApi`, so a shell that
 * lacks it asks for an app update instead of loading a bundle that would call
 * into nothing (docs/decision-log.md, "Every bundle declares the shell API it
 * needs, and a mismatch asks for a full app update"). It is deliberately
 * generic — the filesystem half especially — so that what the app does with
 * files can change in bundles alone (docs/decision-log.md, "The first shell
 * ships a generic, folder-scoped filesystem API as a Developer ID app").
 */

export const SHELL_API_VERSION = 1

export type EntryKind = 'file' | 'directory' | 'symlink' | 'other'

export interface DirEntry {
  readonly name: string
  readonly kind: EntryKind
}

export interface FileStat {
  readonly kind: EntryKind
  readonly size: number
  readonly modifiedMs: number
  readonly createdMs: number
}

export interface FileFilter {
  readonly name: string
  /** Without the dot: `['json']`. */
  readonly extensions: readonly string[]
}

export interface WatchEvent {
  /** `rename` covers create and delete as well; the OS does not tell them apart. */
  readonly kind: 'rename' | 'change'
  /** Absolute path of what changed, when the OS reports one. */
  readonly path: string | null
}

/**
 * Every path is absolute, and must lie inside a granted folder or be a granted
 * file (see `ShellDialogs`). Symlinks are resolved before that check, so a link
 * inside a granted folder cannot reach outside it. A refused path rejects with
 * code `NOT_GRANTED`; filesystem failures carry Node's code (`ENOENT`,
 * `EEXIST`, …) — read either with `shellErrorCode`.
 */
export interface ShellFs {
  readFile(path: string): Promise<Uint8Array>
  readTextFile(path: string): Promise<string>
  /** Creates or replaces the file. Parent directories must exist. */
  writeFile(path: string, data: Uint8Array | string): Promise<void>
  readDir(path: string): Promise<DirEntry[]>
  stat(path: string): Promise<FileStat>
  /** False for a missing path; still rejects `NOT_GRANTED` outside the grants. */
  exists(path: string): Promise<boolean>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  /** Both ends must be granted. */
  rename(from: string, to: string): Promise<void>
  /** Permanent. Prefer `trash` for anything the user made. */
  remove(path: string, options?: { recursive?: boolean }): Promise<void>
  /** Moves to the OS trash, recoverable. */
  trash(path: string): Promise<void>
  /** Resolves once watching has started; call the returned function to stop. */
  watch(path: string, listener: (event: WatchEvent) => void, options?: { recursive?: boolean }): Promise<() => void>
}

/**
 * Native dialogs, and the only way anything becomes granted: whatever the user
 * picks is added to the grants and stays granted across launches until revoked.
 */
export interface ShellDialogs {
  /** Grants the chosen folder and everything under it. Null when cancelled. */
  openFolder(options?: { title?: string; defaultPath?: string }): Promise<string | null>
  /** Grants each chosen file. Empty when cancelled. */
  openFiles(options?: {
    title?: string
    defaultPath?: string
    filters?: readonly FileFilter[]
    multiple?: boolean
  }): Promise<string[]>
  /** Grants the chosen path, which need not exist yet. Null when cancelled. */
  saveFile(options?: { title?: string; defaultPath?: string; filters?: readonly FileFilter[] }): Promise<string | null>
}

export interface ShellGrants {
  /** Absolute paths, folders and files, as granted. */
  list(): Promise<string[]>
  /** Stops watches under it too. A path that was not granted is a no-op. */
  revoke(path: string): Promise<void>
}

export interface ShellApi {
  readonly apiVersion: number
  readonly platform: 'darwin' | 'win32' | 'linux'
  readonly fs: ShellFs
  readonly dialogs: ShellDialogs
  readonly grants: ShellGrants
}

/** The name the preload exposes the API under. */
export const SHELL_GLOBAL = 'papercutShell'

/** The desktop shell's API, or `undefined` when the bundle is running in a browser. */
export function desktopShell(): ShellApi | undefined {
  return (globalThis as { [SHELL_GLOBAL]?: ShellApi })[SHELL_GLOBAL]
}

/**
 * The code a shell call rejected with — `NOT_GRANTED`, or a Node code like
 * `ENOENT` — or `undefined` for an error that did not come from the shell.
 *
 * Carried in the message (`[ENOENT] …`) because only an error's message
 * survives the trip from the main process across `contextBridge`.
 */
export function shellErrorCode(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /\[([A-Z][A-Z0-9_]*)\]/.exec(message)?.[1]
}
