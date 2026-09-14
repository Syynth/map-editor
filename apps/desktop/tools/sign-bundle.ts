import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { MANIFEST_FORMAT, isSafeBundlePath, signManifest, type BundleFile } from '../src/manifest.ts'

/**
 * Signs a built editor bundle for the desktop shell's updater: hashes every
 * file under the build directory and writes the signed envelope to
 * `<dir>/desktop/manifest.json`, which the Pages deploy then serves beside the
 * files it describes.
 *
 *   BUNDLE_SIGNING_KEY=<pem> node apps/desktop/tools/sign-bundle.ts apps/editor/dist \
 *     --sequence 42 --commit <sha> --min-shell-api 1
 *
 * Runs under Node's own type stripping — no build — which is why it and
 * `src/manifest.ts` spell relative imports with `.ts`.
 */

const MANIFEST_DIR = 'desktop'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    sequence: { type: 'string' },
    commit: { type: 'string' },
    'min-shell-api': { type: 'string' },
  },
})

const root = positionals[0]
const sequence = Number(values.sequence)
const minShellApi = Number(values['min-shell-api'])
const key = process.env.BUNDLE_SIGNING_KEY
if (!root || !Number.isSafeInteger(sequence) || sequence < 1 || !values.commit || !Number.isSafeInteger(minShellApi) || !key) {
  console.error('usage: BUNDLE_SIGNING_KEY=<pem> sign-bundle.ts <dir> --sequence <n> --commit <sha> --min-shell-api <n>')
  process.exit(1)
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
}

const files: BundleFile[] = []
for (const absolute of (await listFiles(root)).sort()) {
  const path = relative(root, absolute).split(sep).join('/')
  // The manifest is not part of what it describes.
  if (path.startsWith(`${MANIFEST_DIR}/`)) continue
  if (!isSafeBundlePath(path)) throw new Error(`refusing to sign unsafe path ${path}`)
  const bytes = await readFile(absolute)
  files.push({ path, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
}

const envelope = signManifest({ format: MANIFEST_FORMAT, sequence, commit: values.commit, minShellApi, files }, key)
const out = join(root, MANIFEST_DIR, 'manifest.json')
await mkdir(dirname(out), { recursive: true })
await writeFile(out, JSON.stringify(envelope))
console.log(`signed ${files.length} files as bundle ${sequence} (minShellApi ${minShellApi}) -> ${out}`)
