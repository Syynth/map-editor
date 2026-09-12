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
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
    // The real build, through vite's own API rather than a hand-rolled
    // bundle step, so this test fails the day `vite.config.ts` stops
    // producing a working `dist/cli.js` for any reason, not only this one.
    await build({ root: PACKAGE_ROOT, configFile: join(PACKAGE_ROOT, 'vite.config.ts'), logLevel: 'silent' })

    const dir = await mkdtemp(join(tmpdir(), 'map-editor-export-cli-build-'))
    const inputPath = join(dir, 'sample.json')
    const outputPath = join(dir, 'sample.glb')
    await writeFile(inputPath, serialize(createSampleMap()))

    // A separate `node` process, not an `import()` of the bundle: importing
    // it would run inside vitest's own module graph and its own
    // `import.meta.url` machinery, which is precisely what let the bug
    // above hide. `cwd` deliberately NOT set to `PACKAGE_ROOT` — the whole
    // point is that this has to work no matter where `node` is invoked from.
    execFileSync('node', [join(PACKAGE_ROOT, 'dist/cli.js'), inputPath, outputPath], { stdio: 'pipe' })

    const glb = await readFile(outputPath)
    expect(glb.subarray(0, 4).toString('latin1')).toBe('glTF')
  })
})
