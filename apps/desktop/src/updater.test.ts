import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activeBundle, sha256, type BundleStore } from './bundle-store'
import { MANIFEST_FORMAT, signManifest } from './manifest'
import { checkForBundleUpdate, MANIFEST_PATH } from './updater'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const baseUrl = 'https://example.test/papercut/'

let base: string
let store: BundleStore

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'papercut-updater-'))
  mkdirSync(join(base, 'built-in'))
  writeFileSync(join(base, 'built-in', 'index.html'), 'built-in')
  store = { dir: join(base, 'bundles'), builtInRoot: join(base, 'built-in'), shellApi: 1 }
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

/** A fake site: the files by URL path, plus the requests it saw. */
function site(routes: Record<string, string | object>) {
  const requested: string[] = []
  const fetch = (async (input: string) => {
    const url = new URL(input)
    requested.push(url.pathname + url.search.replace(/t=\d+/, 't=*'))
    const body = routes[url.pathname]
    if (body === undefined) return new Response('missing', { status: 404 })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body))
  }) as typeof globalThis.fetch
  return { fetch, requested }
}

describe('checkForBundleUpdate', () => {
  it('treats a site with no manifest as up to date', async () => {
    const { fetch } = site({})
    expect(await checkForBundleUpdate({ baseUrl, trustedKeys: [publicPem] }, store, activeBundle(store), fetch)).toEqual({ kind: 'up-to-date' })
  })

  it('installs files fetched from beside the manifest, keyed to its sequence', async () => {
    const files = { 'index.html': '<html>', 'assets/a b.js': 'js' }
    const manifest = signManifest(
      {
        format: MANIFEST_FORMAT,
        sequence: 12,
        commit: 'abc',
        minShellApi: 1,
        files: Object.entries(files).map(([path, text]) => ({ path, size: text.length, sha256: sha256(Buffer.from(text)) })),
      },
      privatePem,
    )
    const { fetch, requested } = site({
      [`/papercut/${MANIFEST_PATH}`]: manifest,
      '/papercut/index.html': files['index.html'],
      '/papercut/assets/a%20b.js': files['assets/a b.js'],
    })
    const outcome = await checkForBundleUpdate({ baseUrl, trustedKeys: [publicPem] }, store, activeBundle(store), fetch)
    expect(outcome.kind).toBe('installed')
    // The manifest first; the files after it download in parallel, in no fixed order.
    expect(requested[0]).toBe(`/papercut/${MANIFEST_PATH}?t=*`)
    expect(requested.slice(1).sort()).toEqual(['/papercut/assets/a%20b.js?v=12', '/papercut/index.html?v=12'])
    expect(activeBundle(store).sequence).toBe(12)
  })

  it('installs nothing from a manifest it cannot verify', async () => {
    const { privateKey: otherKey } = generateKeyPairSync('ed25519')
    const forged = signManifest(
      { format: MANIFEST_FORMAT, sequence: 99, commit: 'x', minShellApi: 1, files: [{ path: 'index.html', size: 1, sha256: sha256(Buffer.from('x')) }] },
      otherKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    )
    const { fetch, requested } = site({ [`/papercut/${MANIFEST_PATH}`]: forged, '/papercut/index.html': 'x' })
    await expect(checkForBundleUpdate({ baseUrl, trustedKeys: [publicPem] }, store, activeBundle(store), fetch)).rejects.toThrow(/trusted key/)
    expect(requested).toHaveLength(1)
    expect(activeBundle(store).sequence).toBe(0)
  })
})
