/**
 * The native application menu.
 *
 * The menu is the OS's, so it is built here; what its items DO is the page's,
 * so each one sends a `MenuCommand` (`@papercut/shell-api`) to the window
 * and nothing else. The page keeps the menu current the other way: the
 * recent projects it lists, and whether a project is open, which is what
 * enables the items that need one. The template is a pure function of that
 * state, so it can be checked without Electron.
 */

import type { MenuCommand, MenuState, RecentEntry } from '@papercut/shell-api'
import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

const RECENTS_SHOWN = 10

export interface MenuInputs {
  readonly platform: NodeJS.Platform
  readonly state: MenuState
  readonly recents: readonly RecentEntry[]
  readonly send: (command: MenuCommand) => void
  readonly openReleases: () => void
}

export function menuTemplate({ platform, state, recents, send, openReleases }: MenuInputs): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin'
  const open = state.projectOpen
  const recentItems: MenuItemConstructorOptions[] =
    recents.length === 0
      ? [{ label: 'No Recent Projects', enabled: false }]
      : recents.slice(0, RECENTS_SHOWN).map((r) => ({ label: r.name, sublabel: r.folder, click: () => send({ id: 'project.openRecent', folder: r.folder }) }))
  const file: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { label: 'New Project…', accelerator: 'CmdOrCtrl+Shift+N', click: () => send({ id: 'project.new' }) },
      { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => send({ id: 'project.open' }) },
      { label: 'Open Recent', submenu: recentItems },
      { type: 'separator' },
      { label: 'New Map…', accelerator: 'CmdOrCtrl+N', enabled: open, click: () => send({ id: 'map.new' }) },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', enabled: open, click: () => send({ id: 'file.save' }) },
      { label: 'Export glTF…', accelerator: 'CmdOrCtrl+E', enabled: open, click: () => send({ id: 'file.export' }) },
      { type: 'separator' },
      { label: 'Project Settings…', accelerator: 'CmdOrCtrl+,', enabled: open, click: () => send({ id: 'project.settings' }) },
      { label: 'Close Project', accelerator: 'CmdOrCtrl+Shift+W', enabled: open, click: () => send({ id: 'project.close' }) },
      ...(mac ? [] : [{ type: 'separator' } as const, { role: 'quit' } as const]),
    ],
  }
  const edit: MenuItemConstructorOptions = {
    label: 'Edit',
    // Undo and redo are the page's (its keymap binds them); the roles here serve text fields.
    submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
  }
  const view: MenuItemConstructorOptions = { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'toggleDevTools' }] }
  const window: MenuItemConstructorOptions = { role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(mac ? [{ type: 'separator' } as const, { role: 'front' } as const] : [{ role: 'close' } as const])] }
  const help: MenuItemConstructorOptions = { role: 'help', submenu: [{ label: 'Papercut Releases', click: openReleases }] }
  return [...(mac ? [{ role: 'appMenu' } as const] : []), file, edit, view, window, help]
}

/** Install the menu and keep it current: the page's `setRecents` and `setState` rebuild it. */
export function installMenu(platform: NodeJS.Platform, target: () => BrowserWindow | null, openReleases: () => void): { setRecents(recents: readonly RecentEntry[]): void; setState(state: MenuState): void } {
  let state: MenuState = { projectOpen: false }
  let recents: readonly RecentEntry[] = []
  const send = (command: MenuCommand): void => {
    const window = target()
    if (window && !window.isDestroyed()) window.webContents.send(MENU_COMMAND_CHANNEL, command)
  }
  const rebuild = (): void => Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate({ platform, state, recents, send, openReleases })))
  rebuild()
  return {
    setRecents(next) {
      recents = next
      rebuild()
    },
    setState(next) {
      if (next.projectOpen === state.projectOpen) return
      state = next
      rebuild()
    },
  }
}

// Named here rather than imported from `ipc.ts` so the template's test needs no Electron: the test imports the constant, not the installer.
import { MENU_COMMAND as MENU_COMMAND_CHANNEL } from './ipc'
