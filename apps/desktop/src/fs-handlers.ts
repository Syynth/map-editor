import { watch as watchPath, type FSWatcher } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import { join } from 'node:path'
import type { DirEntry, EntryKind, FileStat, WatchEvent } from '@papercut/shell-api'
import { BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { Grants, isWithin } from './grants'
import { CHANNEL, WATCH_EVENT } from './ipc'

/**
 * The main-process half of `ShellFs`, `ShellDialogs` and `ShellGrants`
 * (`@papercut/shell-api`). The preload is a thin forwarder; every check lives
 * here, where the page cannot reach it.
 *
 * Two checks gate every call: the SENDER must be the app's own top frame
 * (`isAppFrame`), and every PATH must resolve inside a grant (`Grants.resolve`).
 * Arguments arrive from the page, so each is type-checked before use rather
 * than trusted to match the TypeScript signature.
 */

interface Watch {
  readonly watcher: FSWatcher
  readonly contents: WebContents
  readonly realPath: string
}

export function registerShellHandlers(
  grants: Grants,
  isAppFrame: (event: IpcMainInvokeEvent) => boolean,
): { endWatchesFor(contents: WebContents): void } {
  const watches = new Map<number, Watch>()
  let nextWatchId = 1

  function handle<Args extends unknown[], Result>(channel: string, run: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isAppFrame(event)) throw new Error('[NOT_ALLOWED] caller is not the app')
      try {
        return await run(event, ...(args as Args))
      } catch (error) {
        // Only `message` survives the trip to the page; the code rides in it
        // for `shellErrorCode` to read back out.
        const code = (error as { code?: unknown }).code
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(typeof code === 'string' ? `[${code}] ${message}` : message, { cause: error })
      }
    })
  }

  handle(CHANNEL.readFile, async (_event, path: unknown) => new Uint8Array(await readFile(await grants.resolve(asString(path)))))
  handle(CHANNEL.readTextFile, async (_event, path: unknown) => readFile(await grants.resolve(asString(path)), 'utf8'))
  handle(CHANNEL.writeFile, async (_event, path: unknown, data: unknown) => {
    if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw invalid('data must be a string or Uint8Array')
    // Whole-file and atomic: written beside the target, then renamed over it, so a crash mid-write leaves the file
    // that was there rather than a truncated one — the map is the only copy.
    const target = await grants.resolve(asString(path))
    const temp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`)
    await writeFile(temp, data)
    await rename(temp, target)
  })
  handle(CHANNEL.readDir, async (_event, path: unknown): Promise<DirEntry[]> => {
    const entries = await readdir(await grants.resolve(asString(path)), { withFileTypes: true })
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'other',
    }))
  })
  handle(CHANNEL.stat, async (_event, path: unknown): Promise<FileStat> => {
    const stats = await stat(await grants.resolve(asString(path)))
    const kind: EntryKind = stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other'
    return { kind, size: stats.size, modifiedMs: stats.mtimeMs, createdMs: stats.birthtimeMs }
  })
  handle(CHANNEL.exists, async (_event, path: unknown) => {
    const real = await grants.resolve(asString(path))
    return stat(real).then(
      () => true,
      () => false,
    )
  })
  handle(CHANNEL.mkdir, async (_event, path: unknown, options: unknown) => {
    await mkdir(await grants.resolve(asString(path)), { recursive: recursiveFlag(options) })
  })
  handle(CHANNEL.rename, async (_event, from: unknown, to: unknown) => {
    await rename(await grants.resolve(asString(from)), await grants.resolve(asString(to)))
  })
  handle(CHANNEL.remove, async (_event, path: unknown, options: unknown) => {
    // `force: false`: removing something already gone is an error the caller should see.
    await rm(await grants.resolve(asString(path)), { recursive: recursiveFlag(options), force: false })
  })
  handle(CHANNEL.trash, async (_event, path: unknown) => {
    await shell.trashItem(await grants.resolve(asString(path)))
  })

  handle(CHANNEL.watch, async (event, path: unknown, options: unknown) => {
    const requested = asString(path)
    const realPath = await grants.resolve(requested)
    const id = nextWatchId++
    const contents = event.sender
    const watcher = watchPath(realPath, { recursive: recursiveFlag(options) }, (kind, filename) => {
      if (contents.isDestroyed()) return
      const change: WatchEvent = { kind: kind === 'change' ? 'change' : 'rename', path: filename ? join(requested, filename.toString()) : null }
      contents.send(WATCH_EVENT, id, change)
    })
    watcher.on('error', () => stopWatch(id))
    watches.set(id, { watcher, contents, realPath })
    return id
  })
  handle(CHANNEL.unwatch, (event, id: unknown) => {
    // Only the page that started a watch may stop it.
    if (typeof id === 'number' && watches.get(id)?.contents === event.sender) stopWatch(id)
  })

  // Only a granted path is shown: revealing is reading a location, and the grants say which locations the page may know.
  handle(CHANNEL.reveal, async (_event, path: unknown) => {
    shell.showItemInFolder(await grants.resolve(asString(path)))
  })

  handle(CHANNEL.openFolder, async (event, options: unknown) => {
    const { title, defaultPath } = dialogOptions(options)
    const result = await dialog.showOpenDialog(windowOf(event), {
      properties: ['openDirectory', 'createDirectory'],
      ...(title !== undefined && { title }),
      ...(defaultPath !== undefined && { defaultPath }),
    })
    return result.canceled || result.filePaths.length === 0 ? null : grants.add(result.filePaths[0])
  })
  handle(CHANNEL.openFiles, async (event, options: unknown) => {
    const { title, defaultPath, filters, multiple } = dialogOptions(options)
    const result = await dialog.showOpenDialog(windowOf(event), {
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      ...(title !== undefined && { title }),
      ...(defaultPath !== undefined && { defaultPath }),
      ...(filters !== undefined && { filters }),
    })
    if (result.canceled) return []
    const granted: string[] = []
    for (const path of result.filePaths) granted.push(await grants.add(path))
    return granted
  })
  handle(CHANNEL.saveFile, async (event, options: unknown) => {
    const { title, defaultPath, filters } = dialogOptions(options)
    const result = await dialog.showSaveDialog(windowOf(event), {
      properties: ['createDirectory', 'showOverwriteConfirmation'],
      ...(title !== undefined && { title }),
      ...(defaultPath !== undefined && { defaultPath }),
      ...(filters !== undefined && { filters }),
    })
    return result.canceled || result.filePath === undefined ? null : grants.add(result.filePath)
  })

  handle(CHANNEL.listGrants, () => grants.list())
  handle(CHANNEL.revokeGrant, async (_event, path: unknown) => {
    const revoked = await grants.revoke(asString(path))
    if (revoked === null) return
    for (const [id, watch] of watches) if (isWithin(revoked, watch.realPath)) stopWatch(id)
  })

  function stopWatch(id: number): void {
    watches.get(id)?.watcher.close()
    watches.delete(id)
  }

  return {
    /** Ends a page's watches. Called when it reloads or its window closes — the listeners they fed are gone. */
    endWatchesFor(contents: WebContents): void {
      for (const [id, watch] of watches) if (watch.contents === contents) stopWatch(id)
    },
  }
}

function windowOf(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) throw new Error('[NOT_ALLOWED] caller has no window')
  return window
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw invalid('path must be a string')
  return value
}

function recursiveFlag(options: unknown): boolean {
  return typeof options === 'object' && options !== null && (options as { recursive?: unknown }).recursive === true
}

/** Electron's own filter shape: the contract's `FileFilter` with a mutable extension list. */
type DialogFilter = { name: string; extensions: string[] }

function dialogOptions(options: unknown): { title?: string; defaultPath?: string; filters?: DialogFilter[]; multiple: boolean } {
  const raw = typeof options === 'object' && options !== null ? (options as Record<string, unknown>) : {}
  const filters = Array.isArray(raw.filters)
    ? raw.filters.flatMap((filter: unknown): DialogFilter[] => {
        const { name, extensions } = (filter ?? {}) as { name?: unknown; extensions?: unknown }
        return typeof name === 'string' && Array.isArray(extensions) && extensions.every((ext) => typeof ext === 'string')
          ? [{ name, extensions }]
          : []
      })
    : undefined
  return {
    ...(typeof raw.title === 'string' && { title: raw.title }),
    ...(typeof raw.defaultPath === 'string' && { defaultPath: raw.defaultPath }),
    ...(filters !== undefined && { filters }),
    multiple: raw.multiple === true,
  }
}

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' })
}
