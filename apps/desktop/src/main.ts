import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, app, net, protocol, session, shell } from 'electron'
import { BUNDLE_ORIGIN, BUNDLE_SCHEME, bundleFileFor } from './bundle-protocol'

/**
 * The Electron shell: one window, serving the editor's web bundle.
 *
 * The shell is kept small on purpose (docs/decision-log.md, "Web UI updates
 * ship separately from the Electron shell, without code signing"). Everything
 * the editor does lives in the bundle, which updates without a reinstall; this
 * file only decides where the bundle comes from and what the page may do.
 */

/**
 * Where the bundle lives. Packaged, the installer ships one under
 * `resources/bundle`; from a checkout, it is `apps/editor`'s own build output.
 * Downloaded bundle versions will take precedence over both once the updater
 * exists.
 */
function bundleRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, 'bundle') : join(import.meta.dirname, '../../editor/dist')
}

/**
 * From a checkout only, `PAPERCUT_RENDERER_URL` points the window at a running
 * Vite dev server instead (`pnpm dev`), so the shell can be worked on with
 * HMR. A packaged app ignores it: an environment variable must never be able
 * to swap in a page that the bundle signature check never saw.
 */
const devRendererUrl = app.isPackaged ? undefined : process.env.PAPERCUT_RENDERER_URL

/**
 * `unsafe-inline` for styles only: Mantine writes its CSS variables into a
 * `<style>` tag at runtime. Scripts get no such allowance — nothing in the
 * built bundle is inline — so a script injected into the page cannot run.
 * `blob:` and `data:` images cover the sprite sheets the editor loads from
 * picked files (`URL.createObjectURL`) and the inline favicon.
 *
 * Google Fonts is the one remote origin, because `packages/ui/src/tokens.ts`
 * loads IBM Plex from it. Offline the editor falls back to its system font
 * stack; bundling the font files would remove this exception.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' blob: data:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join('; ')

// Must run before `ready`: privileges are fixed once the app has started.
// `standard` gives the scheme real origin semantics, `secure` makes the page a
// secure context, `supportFetchAPI` lets it `fetch` its own files.
protocol.registerSchemesAsPrivileged([
  { scheme: BUNDLE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
])

// Every renderer sandboxed, including any the page might try to create.
app.enableSandbox()

function serveBundle(): void {
  const root = bundleRoot()
  protocol.handle(BUNDLE_SCHEME, async (request) => {
    const file = bundleFileFor(root, request.url)
    if (!file) return new Response('Not found', { status: 404 })
    let response: Response
    try {
      response = await net.fetch(pathToFileURL(file).toString())
    } catch {
      return new Response('Not found', { status: 404 })
    }
    const headers = new Headers(response.headers)
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    return new Response(response.body, { status: response.status, headers })
  })
}

/** The one origin the window may show. Anything else opens in the OS browser, or not at all. */
function isAppUrl(url: string): boolean {
  const origin = new URL(url).origin
  return origin === BUNDLE_ORIGIN || (devRendererUrl !== undefined && origin === new URL(devRendererUrl).origin)
}

function openExternally(url: string): void {
  // Only web links leave the app. A `file:`, custom-scheme or `javascript:`
  // URL from the page is dropped rather than handed to the OS to interpret.
  const { protocol: scheme } = new URL(url)
  if (scheme === 'https:' || scheme === 'http:') void shell.openExternal(url)
}

function lockDown(): void {
  // The editor asks for no permissions (no camera, notifications, pointer
  // lock, clipboard reads…), so the answer is always no. A future feature that
  // needs one is allowed here by name.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openExternally(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (isAppUrl(url)) return
      event.preventDefault()
      openExternally(url)
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Papercut',
    // `tokens.colors.bg` in packages/ui: the window is painted this until the
    // page draws, so opening does not flash white.
    backgroundColor: '#15171c',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  window.once('ready-to-show', () => window.show())
  void window.loadURL(devRendererUrl ?? `${BUNDLE_ORIGIN}/`)
}

void app.whenReady().then(() => {
  lockDown()
  serveBundle()
  createWindow()

  // macOS keeps the app alive with no windows; clicking the dock icon reopens one.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
