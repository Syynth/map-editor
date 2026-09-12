import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

/**
 * The one emitter config, shared by every package (#46, implementing #33's
 * ruling that packages are built as if publishable).
 *
 * WHY one root file rather than a `tsup.config.ts` per package: the only thing
 * that varies between packages is the entry list, and that list is already
 * written down — it is the package's own `exports` map. Deriving it here means
 * adding a subpath export cannot forget to add the entry, and a per-package
 * config cannot drift into a different `format` or `target` than its
 * neighbours. Each package's `build` script points at this file with
 * `--config ../../tsup.config.ts`; pnpm runs a package script with the package
 * directory as `cwd`, which is what `entriesFromExports` reads.
 *
 * WHY tsup emits only JS and never `.d.ts` (`dts: false`): declarations come
 * from `tsc` itself, because `composite: true` — the setting that makes
 * `references` legal at all — already forces `declaration` emit. Letting tsup
 * bundle a second, independently-derived set of declarations next to tsc's
 * would be two sources of truth for the same file. The division is exact:
 * `tsc -p tsconfig.json` writes `dist/*.d.ts`, tsup writes `dist/*.js`.
 *
 * WHY a bundler is needed for the JS half at all, when tsc could emit it: this
 * repo's source uses extensionless relative specifiers (`./billboard`), which
 * Node's ESM resolver does not resolve — the same fact that forced
 * `apps/export-cli` to bundle in the first place (see its `vite.config.ts`).
 * tsc's emit preserves the specifier verbatim, so a tsc-emitted `dist/index.js`
 * would be unloadable by the very consumer "as if publishable" is about.
 *
 * WHY tsup rather than unbuild: with declarations already owned by tsc, the
 * job left is "transpile and bundle ESM, externalising declared dependencies",
 * and tsup is a thin wrapper over esbuild that does exactly that in one line.
 * unbuild's distinguishing features are mkdist and its own rollup-plugin-dts
 * declaration pipeline — the second of which is precisely the duplicated
 * source of truth this split exists to avoid.
 */

/** Exports-map values are nested one condition object deep; flatten them. */
function exportTargets(exports: unknown): string[] {
  if (typeof exports === 'string') return [exports]
  if (typeof exports !== 'object' || exports === null) return []
  return Object.values(exports as Record<string, unknown>).flatMap(exportTargets)
}

/**
 * Every TypeScript source file the package's `exports` map names — i.e. the
 * `development` condition of each entry point.
 *
 * The pattern is anchored at `./src/` and rejects `.d.ts` deliberately: the
 * same map also names `./dist/index.d.ts` (the `types` condition) and
 * `./dist/index.js` (the `default` one), and a bare `/\.tsx?$/` matches
 * `index.d.ts` too. tsup treats entries as globs and silently drops ones that
 * do not exist yet, so that mistake does not fail on a clean `dist/` — it
 * fails only on a rebuild over an existing one, which is exactly the kind of
 * bug that reaches CI. (Observed: `Could not resolve "dist/index.d.ts"`.)
 */
function entriesFromExports(): string[] {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { exports?: unknown; name?: unknown }
  const sources = exportTargets(pkg.exports).filter((target) => /^\.\/src\/.+(?<!\.d)\.tsx?$/.test(target))
  const entries = [...new Set(sources)]
  if (entries.length === 0) throw new Error(`${String(pkg.name)}: no TypeScript entry point in its exports map`)
  return entries
}

export default defineConfig({
  entry: entriesFromExports(),
  outDir: 'dist',
  format: ['esm'],
  // See the header: tsc owns declaration emit, because `composite` forces it.
  dts: false,
  // Runs before tsc in each package's `build` script, so this wipes stale
  // output (including tsc's `.tsbuildinfo`) rather than tsc's fresh emit.
  clean: true,
  sourcemap: true,
  target: 'es2022',
  // Matches every package's own `target`/`module`; the per-package
  // `tsconfig.json` still supplies `jsx` for the three packages with `.tsx`.
  tsconfig: 'tsconfig.json',
})
