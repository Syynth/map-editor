/**
 * The acceptance test #48 names verbatim: `node apps/export-cli/dist/cli.js
 * sample.json out.glb` under plain node produces a file whose first four
 * bytes are `glTF`.
 *
 * Every other test here (`export-cli.test.ts`) exercises `exportMapFile`
 * straight from `src/`, inside vitest's own process — which is exactly where
 * a real bug in this app hid: `bakedDir()` (`@map-editor/fixtures`) used to
 * resolve `packages/fixtures/baked/` from its OWN `import.meta.url`, correct
 * only because vitest runs source files unbundled. `vite build`'s bundle
 * collapses that same `import.meta.url` to `dist/cli.js`'s own location, and
 * the CLI failed with `ENOENT` looking for `apps/export-cli/baked/manifest.json`
 * the first time this test's build-then-spawn actually ran end to end — see
 * `packages/fixtures/src/baked-dir.ts` for the fix (`import.meta.resolve` of
 * a bare specifier instead). A unit test importing `exportMapFile` can never
 * reproduce that regardless of how thorough it is: only the real bundle, run
 * as its own process, is unaffected by vitest's unbundled module graph
 * papering over the exact seam this app exists to prove is sound.
 *
 * Builds into a scratch directory, not the package's own `dist/`: this test
 * runs inside the root `//#test` task (see `turbo.json`), which has no turbo
 * edge to this package's own `build` task (`test` depends only on `^build` —
 * a package's dependencies, never its own build) — so under `gate:full` this
 * test's `build()` call and turbo's `apps/export-cli#build` can run
 * concurrently, both writing (`emptyOutDir: true`) the same real `dist/`. An
 * inline `outDir` override sidesteps that race, and as a side effect proves
 * the bundle isn't hardcoded to its own `dist/`.
 *
 * The scratch directory lives under this package's OWN `node_modules`
 * (gitignored, and cleaned up below regardless), not under the OS's shared
 * temp dir: the bundled `cli.js` still calls `bakedDir()`'s
 * `import.meta.resolve('@map-editor/fixtures/package.json')` at runtime,
 * which asks Node's resolver to walk up from wherever `cli.js` itself sits
 * looking for a `node_modules` with that package in it — true of anywhere
 * under this package's own tree (`apps/export-cli/node_modules/@map-editor
 * /fixtures` is pnpm's real symlink), false of the OS temp dir, which has no
 * such ancestor and fails with `Cannot find package '@map-editor/fixtures'`
 * (reproduced before settling on this location).
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'vite'
import { describe, expect, it } from 'vitest'

import { serialize } from '@map-editor/document'
import { createSampleMap } from '@map-editor/fixtures'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

describe('the built CLI, run as its own process', () => {
  it('produces a .glb starting with the glTF magic under plain node', async () => {
    const buildDir = await mkdtemp(join(PACKAGE_ROOT, 'node_modules', '.export-cli-build-test-'))

    try {
      // The real build, through vite's own API rather than a hand-rolled
      // bundle step, so this test fails the day `vite.config.ts` stops
      // producing a working `cli.js` for any reason, not only this one. Only
      // `outDir` is overridden — everything else (entry, banner, `noExternal`)
      // still comes from the package's own `vite.config.ts`.
      await build({
        root: PACKAGE_ROOT,
        configFile: join(PACKAGE_ROOT, 'vite.config.ts'),
        logLevel: 'silent',
        build: { outDir: buildDir },
      })

      const dir = await mkdtemp(join(tmpdir(), 'map-editor-export-cli-build-'))
      const inputPath = join(dir, 'sample.json')
      const outputPath = join(dir, 'sample.glb')
      await writeFile(inputPath, serialize(createSampleMap()))

      // A separate process, not an `import()` of the bundle: importing it
      // would run inside vitest's own module graph and its own
      // `import.meta.url` machinery, which is precisely what let the bug
      // above hide. `cwd` deliberately NOT set to `PACKAGE_ROOT` — the whole
      // point is that this has to work no matter where the process is
      // invoked from. `execPath` rather than the bare `'node'` command, so
      // this runs under the same node vitest itself is running under, not
      // whatever `node` PATH happens to resolve to.
      execFileSync(process.execPath, [join(buildDir, 'cli.js'), inputPath, outputPath], { stdio: 'pipe' })

      const glb = await readFile(outputPath)
      expect(glb.subarray(0, 4).toString('latin1')).toBe('glTF')
    } finally {
      // Not relied on for correctness (a fresh `mkdtemp` name every run keeps
      // this test collision-free regardless), only to stop repeated local
      // `pnpm test` runs from piling up scratch builds under `node_modules`.
      await rm(buildDir, { recursive: true, force: true })
    }
  })
})
