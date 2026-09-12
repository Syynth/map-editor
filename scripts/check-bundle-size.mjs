/**
 * Fails when a built JS chunk exceeds the 500 kB ceiling #29 exists to
 * enforce. Vite/rolldown's own chunk-size message (see
 * apps/editor/vite.config.ts's manual-chunking comment) is only ever a
 * warning — it never fails the process, so the bundle can regrow past 500 kB
 * with an all-green gate. This turns that warning into a real failure by
 * re-measuring the already-built output on disk.
 *
 *   node scripts/check-bundle-size.mjs [dist-dir] [limit-bytes]
 *
 * Must run after `vite build`, not instead of it — it only reads output that
 * already exists; it does not build anything itself.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Matches the warning this replaces: Vite's default `chunkSizeWarningLimit`
// is 500 (kB, decimal — 1000 bytes), the same convention
// apps/editor/vite.config.ts's `maxSize: 350_000` already uses.
export const DEFAULT_LIMIT_BYTES = 500_000

/**
 * @typedef {{ file: string, bytes: number }} ChunkSize
 */

/**
 * Pure so the failure path is testable without a real build: takes sizes
 * already read from disk rather than reading them itself.
 * @param {ChunkSize[]} sizes
 * @param {number} [limit]
 */
export function oversizedChunks(sizes, limit = DEFAULT_LIMIT_BYTES) {
  return sizes.filter(({ bytes }) => bytes > limit)
}

/**
 * A malformed CLI limit (e.g. `500kB` instead of `500000`) must fail loud,
 * not disappear: `Number('500kB')` is `NaN`, and `bytes > NaN` is always
 * false in `oversizedChunks`, so an unchecked `Number(argv[3])` would make
 * this gate script silently exit 0 on every build regardless of chunk size.
 * @param {string | undefined} raw
 * @param {number} [fallback]
 */
export function parseLimit(raw, fallback = DEFAULT_LIMIT_BYTES) {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid limit-bytes argument: ${JSON.stringify(raw)}`)
  }
  return value
}

/** @param {string} distDir */
function jsChunkSizes(distDir) {
  const assetsDir = join(distDir, 'assets')
  return readdirSync(assetsDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ file: name, bytes: statSync(join(assetsDir, name)).size }))
}

function main() {
  const distDir = process.argv[2] ?? join('apps', 'editor', 'dist')
  let limit
  try {
    limit = parseLimit(process.argv[3])
  } catch (error) {
    // `parseLimit` only ever throws `Error`, but the catch binding is
    // `unknown` under `strict` regardless — narrow instead of assuming, so a
    // future throw of something else prints itself rather than crashing this
    // handler on a missing `.message`.
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }
  const offenders = oversizedChunks(jsChunkSizes(distDir), limit)
  if (offenders.length === 0) return
  for (const { file, bytes } of offenders) {
    console.error(`${file}: ${bytes} bytes exceeds the ${limit}-byte chunk ceiling (#29)`)
  }
  process.exitCode = 1
}

// Guarded so the test file can import `oversizedChunks` without also running
// the CLI path against a `dist/` that may not exist in the test run.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
