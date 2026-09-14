import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SHELL_API_VERSION } from '@papercut/shell-api'
import { BrowserWindow, app, dialog, net, protocol, session, shell, type IpcMainInvokeEvent } from 'electron'
import { TRUSTED_BUNDLE_KEYS } from './bundle-keys'
import { BUNDLE_ORIGIN, BUNDLE_SCHEME, bundleFileFor } from './bundle-protocol'
import { activeBundle, type ActiveBundle, type BundleStore } from './bundle-store'
import { registerShellHandlers } from './fs-handlers'
import { Grants } from './grants'
import { isAppUrl } from './origin'
import { checkForBundleUpdate, type BundleFeed } from './updater'

/**
 * The Electron shell: one window, serving the editor's web bundle.
 *
 * The shell is kept small on purpose (docs/decision-log.md, "Web UI updates
 * ship separately from the Electron shell, without code signing"). Everything
 * the editor does lives in the bundle, which updates without a reinstall; this
 * file decides which bundle to serve, keeps it current, and bounds what the
 * page may do.
 */

/**
 * From a checkout only, `PAPERCUT_RENDERER_URL` points the window at a running
 * Vite dev server instead (`pnpm dev`), so the shell can be worked on with
 * HMR. A packaged app ignores it, like every other override below: an
 * environment variable must never be able to swap in a page, a feed or a key
 * that the signature check never saw.
 */
const devRendererUrl = app.isPackaged ? undefined : process.env.PAPERCUT_RENDERER_URL

const RELEASES_URL = 'https://github.com/Syynth/papercut/releases'

/**
 * Where bundle updates come from. Packaged, the Pages site and the compiled-in
 * keys. From a checkout, only when `PAPERCUT_BUNDLE_FEED` and
 * `PAPERCUT_BUNDLE_TRUST` (a PEM public key) are both set — to exercise the
 * updater against a local feed. With no trusted key there is no feed at all.
 */
function bundleFeed(): BundleFeed | null {
  if (devRendererUrl !== undefined) return null
  if (app.isPackaged) {
    return TRUSTED_BUNDLE_KEYS.length > 0 ? { baseUrl: 'https://syynth.github.io/papercut/', trustedKeys: TRUSTED_BUNDLE_KEYS } : null
  }
  const { PAPERCUT_BUNDLE_FEED: baseUrl, PAPERCUT_BUNDLE_TRUST: key } = process.env
  return baseUrl && key ? { baseUrl, trustedKeys: [key] } : null
}

const FIRST_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 15 * 60_000

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

void app.whenReady().then(() => {
  const store: BundleStore = {
    dir: join(app.getPath('userData'), 'bundles'),
    // Packaged, the installer's bundle under `resources/bundle`; from a
    // checkout, `apps/editor`'s own build output.
    builtInRoot: app.isPackaged ? join(process.resourcesPath, 'bundle') : join(import.meta.dirname, '../../editor/dist'),
    shellApi: SHELL_API_VERSION,
  }
  // Swapped only when the user accepts a reload: until then the running page
  // keeps loading its lazy chunks from the bundle it started with.
  let serving = activeBundle(store)

  lockDown()
  protocol.handle(BUNDLE_SCHEME, async (request) => {
    const file = bundleFileFor(serving.root, request.url)
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

  const handlers = registerShellHandlers(new Grants(join(app.getPath('userData'), 'grants.json')), isAppFrame)
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
      if (isMainFrame && !isSameDocument) handlers.endWatchesFor(contents)
    })
    contents.on('destroyed', () => handlers.endWatchesFor(contents))
  })

  let window = createWindow()
  app.on('activate', () => {
    // macOS keeps the app alive with no windows; clicking the dock icon reopens one.
    if (BrowserWindow.getAllWindows().length === 0) window = createWindow()
  })

  const feed = bundleFeed()
  if (feed) {
    let checking = false
    const offered = new Set<number>()
    const check = async () => {
      if (checking) return
      checking = true
      try {
        const outcome = await checkForBundleUpdate(feed, store, serving, (input, init) => net.fetch(input as string, init))
        if (outcome.kind === 'installed' && !offered.has(outcome.bundle.sequence)) {
          offered.add(outcome.bundle.sequence)
          if (await offerReload(window, outcome.bundle)) {
            serving = outcome.bundle
            window.webContents.reloadIgnoringCache()
          }
        } else if (outcome.kind === 'needs-app-update' && !offered.has(outcome.manifest.sequence)) {
          offered.add(outcome.manifest.sequence)
          await offerAppUpdate(window)
        }
      } catch (error) {
        console.warn('[papercut] bundle update check failed:', error)
      } finally {
        checking = false
      }
    }
    setTimeout(() => void check(), FIRST_CHECK_DELAY_MS)
    setInterval(() => void check(), CHECK_INTERVAL_MS)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/** Only the app's own top frame may call the shell — not an iframe, not a page it navigated away to. */
function isAppFrame(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  return frame !== null && frame === event.sender.mainFrame && isAppUrl(frame.url, devRendererUrl)
}

function openExternally(url: string): void {
  // Only web links leave the app. A `file:`, custom-scheme or `javascript:`
  // URL from the page is dropped rather than handed to the OS to interpret.
  const { protocol: scheme } = new URL(url)
  if (scheme === 'https:' || scheme === 'http:') void shell.openExternal(url)
}

function lockDown(): void {
  // No web permission is granted: camera, notifications, pointer lock,
  // clipboard reads, the File System Access API… File access goes through the
  // shell's own folder-scoped API instead. A future feature that needs one is
  // allowed here by name.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openExternally(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (isAppUrl(url, devRendererUrl)) return
      event.preventDefault()
      openExternally(url)
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}

function createWindow(): BrowserWindow {
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
  return window
}

/**
 * The reload prompt (docs/decision-log.md, "Web bundles are signed downloads,
 * applied through a reload prompt"). The page saves its autosave on `pagehide`
 * (apps/editor/src/editor/App.tsx), so a reload keeps the map; declining
 * leaves the update active for the next launch.
 */
async function offerReload(window: BrowserWindow, bundle: ActiveBundle): Promise<boolean> {
  if (window.isDestroyed()) return false
  const { response } = await dialog.showMessageBox(window, {
    type: 'info',
    buttons: ['Reload Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    message: 'An update to Papercut is ready',
    detail: `Reload to start using it${bundle.commit ? ` (${bundle.commit.slice(0, 7)})` : ''}. Your map is saved and reopens after the reload, but undo history does not carry over. Choose Later to get the update the next time Papercut opens.`,
  })
  return response === 0
}

async function offerAppUpdate(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) return
  const { response } = await dialog.showMessageBox(window, {
    type: 'info',
    buttons: ['Open Downloads', 'Later'],
    defaultId: 0,
    cancelId: 1,
    message: 'A new version of the Papercut app is needed',
    detail: 'The latest editor update needs a newer version of the app than this one. Download and install the new app to keep getting updates.',
  })
  if (response === 0) void shell.openExternal(RELEASES_URL)
}
