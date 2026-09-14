import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activeBundle, installBundle, sha256, type BundleStore, type FetchBundleFile } from './bundle-store'
import { MANIFEST_FORMAT, type BundleFile, type BundleManifest } from './manifest'

let base: string
let store: BundleStore

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'papercut-bundles-'))
  const builtInRoot = join(base, 'built-in')
  mkdirSync(builtInRoot)
  writeFileSync(join(builtInRoot, 'index.html'), 'built-in')
  store = { dir: join(base, 'bundles'), builtInRoot, shellApi: 1 }
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

/** A manifest over `contents`, plus a fetcher that serves them and counts what it served. */
function bundle(sequence: number, contents: Record<string, string>, minShellApi = 1) {
  const files: BundleFile[] = Object.entries(contents).map(([path, text]) => ({
    path,
    size: Buffer.byteLength(text),
    sha256: sha256(Buffer.from(text)),
  }))
  const manifest: BundleManifest = { format: MANIFEST_FORMAT, sequence, commit: `c${sequence}`, minShellApi, files }
  const fetched: string[] = []
  const fetchFile: FetchBundleFile = async (file) => {
    fetched.push(file.path)
    return Buffer.from(contents[file.path])
  }
  return { manifest, fetchFile, fetched }
}

const builtIn = () => activeBundle(store)

describe('the bundle store', () => {
  it('serves the built-in bundle when nothing is installed', () => {
    expect(activeBundle(store)).toEqual({ root: store.builtInRoot, sequence: 0, commit: null })
  })

  it('installs a newer bundle and makes it active', async () => {
    const { manifest, fetchFile } = bundle(3, { 'index.html': 'three', 'assets/a.js': 'a' })
    const outcome = await installBundle(store, manifest, fetchFile, builtIn())
    expect(outcome.kind).toBe('installed')
    const active = activeBundle(store)
    expect(active.sequence).toBe(3)
    expect(readFileSync(join(active.root, 'assets', 'a.js'), 'utf8')).toBe('a')
  })

  it('ignores a bundle that is not newer — a replayed old manifest cannot roll back', async () => {
    const serving = builtIn()
    await installBundle(store, bundle(5, { 'index.html': 'five' }).manifest, bundle(5, { 'index.html': 'five' }).fetchFile, serving)
    const old = bundle(4, { 'index.html': 'four' })
    expect((await installBundle(store, old.manifest, old.fetchFile, serving)).kind).toBe('up-to-date')
    expect(old.fetched).toEqual([])
    expect(activeBundle(store).sequence).toBe(5)
  })

  it('reports a bundle needing a newer shell instead of installing it', async () => {
    const future = bundle(9, { 'index.html': 'nine' }, 2)
    const outcome = await installBundle(store, future.manifest, future.fetchFile, builtIn())
    expect(outcome.kind).toBe('needs-app-update')
    expect(future.fetched).toEqual([])
    expect(activeBundle(store).sequence).toBe(0)
  })

  it('leaves the active bundle alone when a file does not match its hash', async () => {
    const good = bundle(2, { 'index.html': 'two' })
    await installBundle(store, good.manifest, good.fetchFile, builtIn())
    const bad = bundle(3, { 'index.html': 'three', 'assets/a.js': 'a' })
    const corrupt: FetchBundleFile = async (file) => Buffer.from(file.path === 'assets/a.js' ? 'b' : 'three')
    await expect(installBundle(store, bad.manifest, corrupt, activeBundle(store))).rejects.toThrow(/does not match/)
    expect(activeBundle(store).sequence).toBe(2)
    expect(readdirSync(store.dir).filter((entry) => entry.startsWith('.staging-'))).toEqual([])
  })

  it('copies unchanged files from the active bundle instead of fetching them', async () => {
    const first = bundle(1, { 'index.html': 'v1', 'assets/vendor.js': 'same' })
    await installBundle(store, first.manifest, first.fetchFile, builtIn())
    const second = bundle(2, { 'index.html': 'v2', 'assets/vendor.js': 'same' })
    await installBundle(store, second.manifest, second.fetchFile, activeBundle(store))
    expect(second.fetched).toEqual(['index.html'])
    expect(readFileSync(join(activeBundle(store).root, 'assets', 'vendor.js'), 'utf8')).toBe('same')
  })

  it('fetches instead of copying when the local copy has been damaged', async () => {
    const first = bundle(1, { 'index.html': 'v1', 'lib.js': 'same' })
    await installBundle(store, first.manifest, first.fetchFile, builtIn())
    writeFileSync(join(activeBundle(store).root, 'lib.js'), 'damaged')
    const second = bundle(2, { 'index.html': 'v2', 'lib.js': 'same' })
    await installBundle(store, second.manifest, second.fetchFile, activeBundle(store))
    expect(second.fetched.sort()).toEqual(['index.html', 'lib.js'])
  })

  it('keeps the bundle the running page is served from, and prunes the rest', async () => {
    const one = bundle(1, { 'index.html': '1' })
    await installBundle(store, one.manifest, one.fetchFile, builtIn())
    const serving = activeBundle(store)
    const two = bundle(2, { 'index.html': '2' })
    await installBundle(store, two.manifest, two.fetchFile, serving)
    const three = bundle(3, { 'index.html': '3' })
    await installBundle(store, three.manifest, three.fetchFile, serving)
    expect(existsSync(join(store.dir, '1'))).toBe(true)
    expect(existsSync(join(store.dir, '2'))).toBe(false)
    expect(existsSync(join(store.dir, '3'))).toBe(true)
  })

  it('falls back to the built-in bundle when the active one needs a newer shell', async () => {
    const one = bundle(1, { 'index.html': '1' })
    await installBundle(store, one.manifest, one.fetchFile, builtIn())
    // An older shell reinstalled over the same data folder.
    expect(activeBundle({ ...store, shellApi: 0 }).sequence).toBe(0)
  })

  it('falls back to the built-in bundle when the active one is incomplete', async () => {
    const one = bundle(1, { 'index.html': '1' })
    await installBundle(store, one.manifest, one.fetchFile, builtIn())
    rmSync(join(store.dir, '1', 'index.html'))
    expect(activeBundle(store).sequence).toBe(0)
  })
})
