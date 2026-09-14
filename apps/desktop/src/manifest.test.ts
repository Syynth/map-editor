import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MANIFEST_FORMAT, isSafeBundlePath, openManifest, signManifest, type BundleManifest } from './manifest'

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

const manifest: BundleManifest = {
  format: MANIFEST_FORMAT,
  sequence: 7,
  commit: 'abc1234',
  minShellApi: 1,
  files: [
    { path: 'index.html', size: 3, sha256: 'a'.repeat(64) },
    { path: 'assets/index-x.js', size: 5, sha256: 'b'.repeat(64) },
  ],
}

describe('signed manifests', () => {
  const trusted = keyPair()

  it('round-trips through sign and open', () => {
    expect(openManifest(signManifest(manifest, trusted.privatePem), [trusted.publicPem])).toEqual(manifest)
  })

  it('accepts any of several trusted keys, for rotation', () => {
    const other = keyPair()
    expect(openManifest(signManifest(manifest, trusted.privatePem), [other.publicPem, trusted.publicPem]).sequence).toBe(7)
  })

  it('refuses a manifest signed by an untrusted key', () => {
    const stranger = keyPair()
    expect(() => openManifest(signManifest(manifest, stranger.privatePem), [trusted.publicPem])).toThrow(/trusted key/)
  })

  it('refuses a payload altered after signing', () => {
    const envelope = signManifest(manifest, trusted.privatePem)
    const tampered = Buffer.from(JSON.stringify({ ...manifest, minShellApi: 0 })).toString('base64')
    expect(() => openManifest({ ...envelope, payload: tampered }, [trusted.publicPem])).toThrow(/trusted key/)
  })

  it('refuses a malformed envelope', () => {
    expect(() => openManifest(null, [trusted.publicPem])).toThrow(/malformed/)
    expect(() => openManifest({ payload: 1, signature: '' }, [trusted.publicPem])).toThrow(/malformed/)
  })

  it('refuses everything when no key is trusted', () => {
    expect(() => openManifest(signManifest(manifest, trusted.privatePem), [])).toThrow(/trusted key/)
  })

  it('refuses a validly signed manifest that is malformed', () => {
    const open = (value: object) => () => openManifest(signManifest(value as BundleManifest, trusted.privatePem), [trusted.publicPem])
    expect(open({ ...manifest, format: 2 })).toThrow(/format/)
    expect(open({ ...manifest, sequence: 0 })).toThrow(/sequence/)
    expect(open({ ...manifest, files: [{ path: '../evil', size: 1, sha256: 'a'.repeat(64) }] })).toThrow(/unsafe/)
    expect(open({ ...manifest, files: [manifest.files[1]] })).toThrow(/index.html/)
    expect(open({ ...manifest, files: [manifest.files[0], manifest.files[0]] })).toThrow(/twice/)
    expect(open({ ...manifest, files: [{ path: 'index.html', size: 1, sha256: 'nope' }] })).toThrow(/hash/)
  })
})

describe('isSafeBundlePath', () => {
  it('accepts plain relative paths', () => {
    expect(isSafeBundlePath('index.html')).toBe(true)
    expect(isSafeBundlePath('assets/vendor-three-1.js')).toBe(true)
    expect(isSafeBundlePath('..hidden')).toBe(true)
  })

  it('refuses anything that could leave the bundle directory', () => {
    for (const path of ['', '/etc/passwd', 'a/../../b', '..', './a', 'a//b', 'a\\b', 'C:/x', 'a\0b', 'a/'])
      expect(isSafeBundlePath(path), path).toBe(false)
  })
})
