import { BUNDLE_HOST, BUNDLE_SCHEME } from './bundle-protocol'

/**
 * Whether `url` belongs to the app: the bundle origin, or — from a checkout
 * only — the Vite dev server `PAPERCUT_RENDERER_URL` names. The window may
 * only navigate within it, and only a frame on it may call the shell's IPC.
 *
 * Compared by protocol and host, never by `URL.origin`: to the WHATWG parser
 * `app:` is not a special scheme, so `new URL('app://bundle/').origin` is the
 * string `"null"` — an origin comparison would refuse the app's own pages.
 */
export function isAppUrl(url: string, devRendererUrl: string | undefined): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === `${BUNDLE_SCHEME}:` && parsed.host === BUNDLE_HOST) return true
  if (devRendererUrl === undefined) return false
  const dev = new URL(devRendererUrl)
  return parsed.protocol === dev.protocol && parsed.host === dev.host
}
