import { installBundle, type ActiveBundle, type BundleStore, type InstallOutcome } from './bundle-store'
import { openManifest, type BundleFile } from './manifest'

/**
 * One bundle update check: fetch the signed manifest from the feed, verify it,
 * and install what it describes.
 *
 * The feed is the Pages site itself. The manifest sits at `desktop/manifest.json`
 * beside the editor build, and every file it lists is fetched from the site at
 * its own path — the deploy already serves each one, so nothing is published
 * twice (docs/decision-log.md, "Web bundles are delivered as a signed per-file
 * manifest, not a zip").
 */

export interface BundleFeed {
  /** The site root, with a trailing slash: `https://syynth.github.io/papercut/`. */
  readonly baseUrl: string
  /** Public keys (PEM) a manifest may be signed by. */
  readonly trustedKeys: readonly string[]
}

export const MANIFEST_PATH = 'desktop/manifest.json'

export async function checkForBundleUpdate(
  feed: BundleFeed,
  store: BundleStore,
  serving: ActiveBundle,
  fetch: typeof globalThis.fetch,
): Promise<InstallOutcome> {
  // The query defeats the CDN in front of Pages, which otherwise serves a
  // manifest up to ten minutes stale.
  const response = await fetch(`${new URL(MANIFEST_PATH, feed.baseUrl).href}?t=${Date.now()}`)
  // No manifest is not an error: a site deployed before signing existed has none.
  if (response.status === 404) return { kind: 'up-to-date' }
  if (!response.ok) throw new Error(`manifest request failed: HTTP ${response.status}`)
  const manifest = openManifest(await response.json(), feed.trustedKeys)

  return installBundle(
    store,
    manifest,
    async (file: BundleFile) => {
      // `?v=` keys the CDN cache to this manifest, so a file cached from an
      // older deploy is not served in its place. A deploy landing mid-download
      // can still mismatch; the install then fails whole and the next check
      // retries against the newer manifest.
      const url = `${new URL(file.path.split('/').map(encodeURIComponent).join('/'), feed.baseUrl).href}?v=${manifest.sequence}`
      const fileResponse = await fetch(url)
      if (!fileResponse.ok) throw new Error(`${file.path}: HTTP ${fileResponse.status}`)
      return new Uint8Array(await fileResponse.arrayBuffer())
    },
    serving,
  )
}
