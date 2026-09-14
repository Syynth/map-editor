import { contextBridge } from 'electron'
import { SHELL_API_VERSION, type ShellApi } from './shell-api'

/**
 * Everything the web bundle can reach of the shell, and deliberately almost
 * nothing yet.
 *
 * The renderer is sandboxed and context-isolated, so this object is the whole
 * boundary: the page gets plain data copied across `contextBridge`, never
 * `ipcRenderer` or any Node module. Every capability added here is one a
 * bundle can use — and because bundles update without a reinstall, one a
 * compromised bundle could use too. That is why bundles are signed, and why
 * this surface should grow one narrow function at a time.
 */
const api: ShellApi = {
  apiVersion: SHELL_API_VERSION,
  platform: process.platform,
}

contextBridge.exposeInMainWorld('papercutShell', api)
