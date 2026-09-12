/**
 * Where `packages/fixtures/baked/` actually is, for a consumer with no canvas
 * to regenerate its contents (#47, #48) — `apps/export-cli` is the first.
 *
 * `import.meta.resolve` of a BARE specifier, not `import.meta.url` of this
 * file: `apps/export-cli` bundles this module into `dist/cli.js` (its own
 * `vite.config.ts` explains why), and a bundler's `import.meta.url` for the
 * code it moves points at the OUTPUT file's location, not this source file's
 * — verified against the built CLI, which resolved `../baked/` from
 * `apps/export-cli/dist/` and failed with `ENOENT` looking for
 * `apps/export-cli/baked/manifest.json`. `import.meta.resolve` instead asks
 * Node's own resolver to find `@map-editor/fixtures/package.json` from
 * wherever this code is actually running, which walks real `node_modules`
 * directories on disk and lands on the package's real location however it
 * got here — a workspace symlink today. `./package.json` is on the `exports`
 * map for exactly this: it is the one path guaranteed to sit next to `baked/`
 * no matter how the rest of the package is laid out.
 */
export function bakedDir(): string {
  const packageJsonUrl = import.meta.resolve('@map-editor/fixtures/package.json')
  return new URL('baked/', packageJsonUrl).pathname
}
