import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * The web bundle is served from `app://bundle/`, not from `file://`.
 *
 * A registered standard scheme gives the page a real origin: relative and
 * root-absolute asset URLs both resolve the way they do on a web server,
 * `fetch` works, and the page is a secure context. `file://` has none of that.
 *
 * The host is a constant, NOT the bundle's version. `localStorage` — where the
 * editor keeps its autosave slot (`apps/editor/src/editor/autosave.ts`) — is
 * keyed by origin, so a per-version host would strand the autosave behind
 * every bundle update. Which version is served is decided by the directory
 * this origin maps to, never by the origin itself.
 */
export const BUNDLE_SCHEME = 'app'
export const BUNDLE_HOST = 'bundle'
export const BUNDLE_ORIGIN = `${BUNDLE_SCHEME}://${BUNDLE_HOST}`

/**
 * The file on disk a request to the bundle origin names, or null when it names
 * nothing inside `root`.
 *
 * This is the only thing standing between a page and the rest of the disk, so
 * it refuses rather than normalises: a foreign scheme or host, an undecodable
 * path, a NUL byte, and anything that resolves outside `root` (`..` segments,
 * including percent-encoded ones, which `URL` leaves encoded and this decodes
 * before resolving) all return null.
 */
export function bundleFileFor(root: string, requestUrl: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${BUNDLE_SCHEME}:` || url.host !== BUNDLE_HOST) return null

  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  // A backslash is a separator on Windows and an ordinary filename character
  // elsewhere, so the same URL would resolve differently per platform. No
  // built bundle names a file with one; refusing it keeps the check portable.
  if (pathname.includes('\0') || pathname.includes('\\')) return null
  if (pathname.endsWith('/')) pathname += 'index.html'

  const file = resolve(root, `.${pathname}`)
  const inside = relative(resolve(root), file)
  // `..` exactly or as a leading segment — not any name that merely starts
  // with two dots, which is a legal file inside the root.
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null
  return file
}
