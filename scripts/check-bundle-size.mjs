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
 * Pure so the failure path is testable without a real build: takes sizes
 * already read from disk rather than reading them itself.
 */
export function oversizedChunks(sizes, limit = DEFAULT_LIMIT_BYTES) {
  return sizes.filter(({ bytes }) => bytes > limit)
}

function jsChunkSizes(distDir) {
  const assetsDir = join(distDir, 'assets')
  return readdirSync(assetsDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ file: name, bytes: statSync(join(assetsDir, name)).size }))
}

function main() {
  const distDir = process.argv[2] ?? join('apps', 'editor', 'dist')
  const limit = process.argv[3] ? Number(process.argv[3]) : DEFAULT_LIMIT_BYTES
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
