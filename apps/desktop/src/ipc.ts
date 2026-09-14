/**
 * IPC channel names, shared by the main process (`fs-handlers.ts`) and the
 * preload so the two cannot drift. Every channel is `invoke`/`handle` except
 * `WATCH_EVENT`, which the main process pushes to the page.
 */
export const CHANNEL = {
  readFile: 'shell:fs:readFile',
  readTextFile: 'shell:fs:readTextFile',
  writeFile: 'shell:fs:writeFile',
  readDir: 'shell:fs:readDir',
  stat: 'shell:fs:stat',
  exists: 'shell:fs:exists',
  mkdir: 'shell:fs:mkdir',
  rename: 'shell:fs:rename',
  remove: 'shell:fs:remove',
  trash: 'shell:fs:trash',
  watch: 'shell:fs:watch',
  unwatch: 'shell:fs:unwatch',
  openFolder: 'shell:dialogs:openFolder',
  openFiles: 'shell:dialogs:openFiles',
  saveFile: 'shell:dialogs:saveFile',
  listGrants: 'shell:grants:list',
  revokeGrant: 'shell:grants:revoke',
  setRecents: 'shell:menu:setRecents',
  setMenuState: 'shell:menu:setState',
} as const

export const WATCH_EVENT = 'shell:fs:watch-event'
/** Pushed to the page when a native menu item is chosen. */
export const MENU_COMMAND = 'shell:menu:command'
