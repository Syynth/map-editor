import { SHELL_API_VERSION, SHELL_GLOBAL, type MenuCommand, type ShellApi, type WatchEvent } from '@papercut/shell-api'
import { contextBridge, ipcRenderer } from 'electron'
import { CHANNEL, MENU_COMMAND, WATCH_EVENT } from './ipc'

/**
 * `ShellApi` (`@papercut/shell-api`), forwarded to the main process.
 *
 * The renderer is sandboxed and context-isolated, so this object is the whole
 * boundary: the page gets these functions through `contextBridge`, never
 * `ipcRenderer` or any Node module. Nothing here checks anything — a page can
 * reach the main process only through these channels, so the checks live on
 * the other side (`fs-handlers.ts`), where a compromised page cannot skip them.
 */

const invoke = <T>(channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>

const watchListeners = new Map<number, (event: WatchEvent) => void>()
ipcRenderer.on(WATCH_EVENT, (_event, id: number, change: WatchEvent) => watchListeners.get(id)?.(change))

const platform = process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux'

const api: ShellApi = {
  apiVersion: SHELL_API_VERSION,
  platform,
  fs: {
    readFile: (path) => invoke(CHANNEL.readFile, path),
    readTextFile: (path) => invoke(CHANNEL.readTextFile, path),
    writeFile: (path, data) => invoke(CHANNEL.writeFile, path, data),
    readDir: (path) => invoke(CHANNEL.readDir, path),
    stat: (path) => invoke(CHANNEL.stat, path),
    exists: (path) => invoke(CHANNEL.exists, path),
    mkdir: (path, options) => invoke(CHANNEL.mkdir, path, options),
    rename: (from, to) => invoke(CHANNEL.rename, from, to),
    remove: (path, options) => invoke(CHANNEL.remove, path, options),
    trash: (path) => invoke(CHANNEL.trash, path),
    watch: async (path, listener, options) => {
      const id = await invoke<number>(CHANNEL.watch, path, options)
      watchListeners.set(id, listener)
      return () => {
        watchListeners.delete(id)
        void invoke(CHANNEL.unwatch, id)
      }
    },
  },
  dialogs: {
    openFolder: (options) => invoke(CHANNEL.openFolder, options),
    openFiles: (options) => invoke(CHANNEL.openFiles, options),
    saveFile: (options) => invoke(CHANNEL.saveFile, options),
  },
  grants: {
    list: () => invoke(CHANNEL.listGrants),
    revoke: (path) => invoke(CHANNEL.revokeGrant, path),
  },
  reveal: {
    reveal: (path) => invoke(CHANNEL.reveal, path),
  },
  menu: {
    onCommand: (listener) => {
      const handler = (_event: unknown, command: MenuCommand) => listener(command)
      ipcRenderer.on(MENU_COMMAND, handler)
      return () => ipcRenderer.off(MENU_COMMAND, handler)
    },
    setRecents: (recents) => invoke(CHANNEL.setRecents, recents),
    setState: (state) => invoke(CHANNEL.setMenuState, state),
  },
}

contextBridge.exposeInMainWorld(SHELL_GLOBAL, api)
