import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

/**
 * The signed manifest a web bundle is delivered with (docs/decision-log.md,
 * "Web bundles are delivered as a signed per-file manifest, not a zip").
 *
 * Shared by both ends: CI signs with `signManifest` (`tools/sign-bundle.ts`),
 * the shell checks with `openManifest`. One module, so the two can never
 * disagree about the format.
 *
 * On the wire it is an envelope — `{ payload, signature }` — where `payload`
 * is the base64 of the manifest's JSON bytes and `signature` is Ed25519 over
 * exactly those bytes. Signing bytes rather than a parsed object means there
 * is no canonical-JSON question to get wrong: what was signed is what is
 * parsed.
 *
 * This file imports nothing relative, so Node can run `tools/sign-bundle.ts`
 * against it directly with type stripping, no build step.
 */

export const MANIFEST_FORMAT = 1

export interface BundleFile {
  /** Relative to the bundle root, `/`-separated. */
  readonly path: string
  readonly size: number
  /** Lowercase hex. */
  readonly sha256: string
}

export interface BundleManifest {
  readonly format: typeof MANIFEST_FORMAT
  /**
   * Strictly increasing across published bundles — the Pages workflow's run
   * number. The shell installs only a sequence greater than the one it runs,
   * so a replayed older manifest (validly signed, but stale) is refused.
   */
  readonly sequence: number
  readonly commit: string
  /** The lowest `SHELL_API_VERSION` this bundle works against (src/shell-api.ts). */
  readonly minShellApi: number
  readonly files: readonly BundleFile[]
}

export interface ManifestEnvelope {
  readonly payload: string
  readonly signature: string
}

export function signManifest(manifest: BundleManifest, privateKeyPem: string): ManifestEnvelope {
  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8')
  const signature = sign(null, bytes, createPrivateKey(privateKeyPem))
  return { payload: bytes.toString('base64'), signature: signature.toString('base64') }
}

/**
 * The manifest inside `envelope`, if one of `trustedKeys` signed it and it is
 * well formed. Throws otherwise, with a reason fit for a log line.
 *
 * More than one key is accepted so the signing key can be rotated: a shell
 * release that trusts both old and new ships first, then CI switches keys.
 */
export function openManifest(envelope: unknown, trustedKeys: readonly string[]): BundleManifest {
  if (!isRecord(envelope) || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string')
    throw new Error('manifest envelope is malformed')

  const bytes = Buffer.from(envelope.payload, 'base64')
  const signature = Buffer.from(envelope.signature, 'base64')
  const trusted = trustedKeys.some((key) => {
    try {
      return verify(null, bytes, createPublicKey(key), signature)
    } catch {
      return false
    }
  })
  if (!trusted) throw new Error('manifest signature does not match a trusted key')

  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('manifest payload is not JSON')
  }
  return checkManifest(parsed)
}

/** Shape-checks a parsed payload. Signed does not mean well formed — a CI bug signs garbage just as validly. */
function checkManifest(value: unknown): BundleManifest {
  if (!isRecord(value)) throw new Error('manifest is not an object')
  if (value.format !== MANIFEST_FORMAT) throw new Error(`manifest format ${String(value.format)} is not supported`)
  if (!isCount(value.sequence) || value.sequence < 1) throw new Error('manifest sequence is invalid')
  if (typeof value.commit !== 'string') throw new Error('manifest commit is invalid')
  if (!isCount(value.minShellApi)) throw new Error('manifest minShellApi is invalid')
  if (!Array.isArray(value.files)) throw new Error('manifest files is not a list')

  const seen = new Set<string>()
  const files = value.files.map((file: unknown): BundleFile => {
    if (!isRecord(file)) throw new Error('manifest file entry is not an object')
    const { path, size, sha256 } = file
    if (typeof path !== 'string' || !isSafeBundlePath(path)) throw new Error(`manifest path ${String(path)} is unsafe`)
    if (seen.has(path)) throw new Error(`manifest lists ${path} twice`)
    seen.add(path)
    if (!isCount(size)) throw new Error(`manifest size for ${path} is invalid`)
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`manifest hash for ${path} is invalid`)
    return { path, size, sha256 }
  })
  if (!seen.has('index.html')) throw new Error('manifest has no index.html')

  return { format: MANIFEST_FORMAT, sequence: value.sequence, commit: value.commit, minShellApi: value.minShellApi, files }
}

/**
 * A path the shell may write under a bundle directory: relative, `/`-separated
 * segments with no `.`, `..`, empty segment, backslash, drive colon or NUL.
 * Checked on the manifest's own strings before any path is joined, so a signed
 * manifest still cannot aim a write outside its directory.
 */
export function isSafeBundlePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false
  if (/[\\:\0]/.test(path)) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
