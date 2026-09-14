import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BundleFile, BundleManifest } from './manifest'

/**
 * Downloaded web bundles on disk, and which one the shell serves.
 *
 * Layout under `dir` (the app's data folder, `bundles/`):
 *
 *   <sequence>/                 one complete, verified bundle per version
 *   <sequence>.manifest.json    the verified manifest it was installed from
 *   active.json                 { sequence } — what the next launch serves
 *   .staging-<sequence>-*       an install in progress; never served
 *
 * A bundle only becomes a `<sequence>/` directory by a rename after every file
 * in it has matched its signed hash, and only becomes active by a rename of
 * `active.json` after that. A crash at any point leaves the previous bundle
 * serving, never a half-written one.
 */

export interface BundleStore {
  readonly dir: string
  /** The bundle the installer shipped, served when nothing downloaded is usable. */
  readonly builtInRoot: string
  /** This shell's `SHELL_API_VERSION`. */
  readonly shellApi: number
}

export interface ActiveBundle {
  readonly root: string
  /** 0 for the built-in bundle, which has no manifest. */
  readonly sequence: number
  readonly commit: string | null
}

export type InstallOutcome =
  | { readonly kind: 'up-to-date' }
  /** Newer, but needs a newer shell than this one: a full app update is required. */
  | { readonly kind: 'needs-app-update'; readonly manifest: BundleManifest }
  | { readonly kind: 'installed'; readonly bundle: ActiveBundle; readonly manifest: BundleManifest }

/** Fetches one bundle file's bytes by its manifest path. */
export type FetchBundleFile = (file: BundleFile) => Promise<Uint8Array>

const DOWNLOAD_CONCURRENCY = 6

/**
 * A ceiling on what one manifest can make the shell download. The editor
 * bundle is a few megabytes; this only stops a broken or hostile manifest
 * from filling the disk, so it is set far above any real bundle.
 */
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024

/**
 * The bundle to serve: the active downloaded one if it is complete and this
 * shell can run it, otherwise the built-in one. Synchronous, because the
 * protocol handler needs an answer before the first window loads.
 *
 * The API check matters even though an incompatible bundle is never installed:
 * reinstalling an OLDER shell over a data folder leaves a bundle that needed
 * the newer one active.
 */
export function activeBundle(store: BundleStore): ActiveBundle {
  const builtIn: ActiveBundle = { root: store.builtInRoot, sequence: 0, commit: null }
  try {
    const { sequence } = JSON.parse(readFileSync(join(store.dir, 'active.json'), 'utf8')) as { sequence?: unknown }
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) return builtIn
    const manifest = readInstalledManifest(store, sequence)
    const root = join(store.dir, String(sequence))
    if (!manifest || manifest.minShellApi > store.shellApi || !existsSync(join(root, 'index.html'))) return builtIn
    return { root, sequence, commit: manifest.commit }
  } catch {
    return builtIn
  }
}

/**
 * Installs `manifest`'s bundle and makes it active, if it is newer than the
 * active one and this shell can run it. `manifest` must already be verified
 * (`openManifest`); every file is then checked against it here.
 *
 * `serving` is the bundle the running window was loaded from. It is kept on
 * disk even if it is no longer active, because the page may still lazily load
 * chunks from it until it reloads.
 */
export async function installBundle(
  store: BundleStore,
  manifest: BundleManifest,
  fetchFile: FetchBundleFile,
  serving: ActiveBundle,
): Promise<InstallOutcome> {
  const current = activeBundle(store)
  if (manifest.sequence <= current.sequence) return { kind: 'up-to-date' }
  if (manifest.minShellApi > store.shellApi) return { kind: 'needs-app-update', manifest }
  const total = manifest.files.reduce((sum, file) => sum + file.size, 0)
  if (total > MAX_BUNDLE_BYTES) throw new Error(`bundle is ${total} bytes, over the ${MAX_BUNDLE_BYTES} limit`)

  await mkdir(store.dir, { recursive: true })
  const staging = await mkdtemp(join(store.dir, `.staging-${manifest.sequence}-`))
  try {
    const reusable = reusableFiles(store, current)
    await eachLimited(manifest.files, DOWNLOAD_CONCURRENCY, async (file) => {
      const target = join(staging, ...file.path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      const local = reusable.get(file.sha256)
      if (local && (await copyVerified(local, target, file))) return
      const bytes = await fetchFile(file)
      if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256)
        throw new Error(`${file.path} does not match the manifest`)
      await writeFile(target, bytes)
    })

    const root = join(store.dir, String(manifest.sequence))
    await rm(root, { recursive: true, force: true })
    await rename(staging, root)
    await writeAtomically(join(store.dir, `${manifest.sequence}.manifest.json`), JSON.stringify(manifest))
    await writeAtomically(join(store.dir, 'active.json'), JSON.stringify({ sequence: manifest.sequence }))

    await prune(store, new Set([manifest.sequence, serving.sequence]))
    return { kind: 'installed', bundle: { root, sequence: manifest.sequence, commit: manifest.commit }, manifest }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

function readInstalledManifest(store: BundleStore, sequence: number): BundleManifest | null {
  try {
    return JSON.parse(readFileSync(join(store.dir, `${sequence}.manifest.json`), 'utf8')) as BundleManifest
  } catch {
    return null
  }
}

/** Files already on disk in the active bundle, by hash — the ones an update need not download again. */
function reusableFiles(store: BundleStore, current: ActiveBundle): Map<string, string> {
  const byHash = new Map<string, string>()
  const manifest = current.sequence > 0 ? readInstalledManifest(store, current.sequence) : null
  for (const file of manifest?.files ?? []) byHash.set(file.sha256, join(current.root, ...file.path.split('/')))
  return byHash
}

/** Copies a local file into place, but only counts it if the copy really matches — a damaged local file falls back to a download. */
async function copyVerified(source: string, target: string, file: BundleFile): Promise<boolean> {
  try {
    await copyFile(source, target)
    const bytes = await readFile(target)
    return bytes.byteLength === file.size && sha256(bytes) === file.sha256
  } catch {
    return false
  }
}

/** Removes every installed bundle not in `keep`, and any abandoned staging directory. */
async function prune(store: BundleStore, keep: ReadonlySet<number>): Promise<void> {
  for (const entry of await readdir(store.dir)) {
    const bundle = /^(\d+)(\.manifest\.json)?$/.exec(entry)
    const stale = entry.startsWith('.staging-') || (bundle !== null && !keep.has(Number(bundle[1])))
    if (stale) await rm(join(store.dir, entry), { recursive: true, force: true })
  }
}

async function writeAtomically(path: string, text: string): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, text)
  await rename(temporary, path)
}

async function eachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await run(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
