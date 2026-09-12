/**
 * Build the workspace packages a production `vite build` of the editor needs.
 *
 * #46 gave every `packages/*` package a `dist/`, and a production `vite build`
 * resolves each one through the `default` condition of its `exports` map — the
 * built `dist/*.js` — where only vite's dev server and vitest take the
 * `development` condition that reads `src/`. So the editor's bundle can no
 * longer be assembled from a checkout that has never been built: with the
 * packages' `dist/` absent, rolldown fails outright to resolve
 * `@map-editor/geometry`.
 *
 * Every script that runs `vite build` against `apps/editor` — `pnpm shoot`,
 * `pnpm tour`, `pnpm probe` — therefore has to materialise that closure first.
 * Doing it here, rather than as a step in whatever workflow happens to invoke
 * them, keeps each one self-contained: README.md documents all three as
 * contributor entry points to be run directly, and CI's `visual` job has no
 * build step of its own. Turbo caches the result, so a repeat run after a real
 * build costs nothing.
 *
 * `pnpm bake` deliberately does not call this: it drives the vite *dev* server,
 * which takes the `development` condition and reads `src/` straight through.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Build `apps/editor`'s workspace dependency closure, exiting the process if
 * the build fails. Safe to call only before any child server is spawned —
 * which is where all three callers sit.
 */
export function buildWorkspacePackages() {
  console.log('Building workspace packages...')
  const deps = spawnSync('npx', ['turbo', 'run', 'build', '--filter=@map-editor/editor^...'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  if (deps.status !== 0) process.exit(deps.status ?? 1)
}
