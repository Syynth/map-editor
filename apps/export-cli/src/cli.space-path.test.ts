/**
 * Regression test for a review finding on #83: `bakedDir()`
 * (`@map-editor/fixtures`) used to return `new URL(...).pathname`, and a
 * `URL`'s `.pathname` is percent-encoded — a space becomes `%20`, `#` becomes
 * `%23`, and so on. `loadBakedAssets` then fed that encoded string straight
 * into `node:path`'s `join` and `fs.readFile` as if it were a real filesystem
 * path, so any checkout with a space (or `%`, `#`, non-ASCII byte) anywhere
 * in its path broke with `ENOENT ... manifest.json` — reproduced against a
 * real clone into a directory named `pr 83 space test` before this fix
 * landed. `packages/fixtures/src/baked-dir.ts` now returns the `URL` itself,
 * and `loadBakedAssets` resolves every file with `new URL(file, dir)` passed
 * straight to `readFile`, which decodes correctly.
 *
 * This can't just clone the repo into a space-containing directory in CI —
 * the checkout path is not this test's to choose. Instead it reproduces the
 * exact shape of the bug: build the real CLI bundle (same as
 * `cli.build.test.ts`), but point its `@map-editor/fixtures` resolution at a
 * copy of the real `baked/` directory sitting under a directory name that
 * contains a space, wired up as a real `node_modules` entry so the built
 * `cli.js`'s own `import.meta.resolve('@map-editor/fixtures/package.json')`
 * — unchanged, still the real production code — finds it there. Revert
 * `baked-dir.ts`'s fix and this fails the same way the real clone did.
 */
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'vite'
import { describe, expect, it } from 'vitest'

import { serialize } from '@map-editor/document'
import { createSampleMap } from '@map-editor/fixtures'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES_ROOT = fileURLToPath(new URL('../../../packages/fixtures/', import.meta.url))

describe('the built CLI, resolving its bake from a directory with a space in its path', () => {
  it('still finds and decodes the bake', async () => {
    // A space in the directory name is the exact character the original bug
    // report reproduced with; `%` and `#` are the other two `URL` escapes
    // `.pathname` would have mangled the same way.
    const spaceRoot = await mkdtemp(join(tmpdir(), 'map editor space % # -'))

    try {
      // A real `node_modules` entry, not a symlink to the actual (space-free)
      // `packages/fixtures`: a symlink's target resolves through its real,
      // symlink-free path, which would quietly dodge the very path this test
      // exists to put a space in. Copying `package.json` and `baked/` is
      // enough — `bakedDir()` only resolves `./package.json` from the
      // `exports` map and reads `baked/` next to it.
      const fixturesCopy = join(spaceRoot, 'node_modules', '@map-editor', 'fixtures')
      await mkdir(fixturesCopy, { recursive: true })
      await cp(join(FIXTURES_ROOT, 'package.json'), join(fixturesCopy, 'package.json'))
      await cp(join(FIXTURES_ROOT, 'baked'), join(fixturesCopy, 'baked'), { recursive: true })

      // `dist` sits directly under `spaceRoot`, so walking up from
      // `dist/cli.js` looking for a `node_modules` directory (Node's own
      // bare-specifier resolution algorithm) reaches `spaceRoot/node_modules`
      // — the one just populated above — on the very first step.
      const distDir = join(spaceRoot, 'dist')
      await build({
        root: PACKAGE_ROOT,
        configFile: join(PACKAGE_ROOT, 'vite.config.ts'),
        logLevel: 'silent',
        build: { outDir: distDir },
      })

      const inputPath = join(spaceRoot, 'sample.json')
      const outputPath = join(spaceRoot, 'sample.glb')
      await writeFile(inputPath, serialize(createSampleMap()))

      execFileSync(process.execPath, [join(distDir, 'cli.js'), inputPath, outputPath], { stdio: 'pipe' })

      const glb = await readFile(outputPath)
      expect(glb.subarray(0, 4).toString('latin1')).toBe('glTF')
    } finally {
      await rm(spaceRoot, { recursive: true, force: true })
    }
  })
})
