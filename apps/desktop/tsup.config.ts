import { defineConfig } from 'tsup'

/**
 * Two outputs with two module formats, which is why this app does not use the
 * shared root `tsup.config.ts` (that one derives entries from an `exports`
 * map and emits ESM only).
 *
 * The main process is ESM, which Electron loads natively. The preload has to
 * be CommonJS: a preload in a sandboxed renderer (`sandbox: true`, see
 * `src/main.ts`) runs through Electron's own restricted `require` and cannot
 * be an ES module. In a `"type": "module"` package tsup names that output
 * `preload.cjs`, which is the name `src/main.ts` points at.
 *
 * `electron` stays external — it is the runtime, not a dependency to bundle.
 * `@papercut/shell-api` is bundled in: tsup only externalises `dependencies`,
 * and the shell declares it as a devDependency so electron-builder packs no
 * `node_modules` at all — the asar holds `dist/` and nothing else.
 */
export default defineConfig([
  {
    entry: { main: 'src/main.ts' },
    outDir: 'dist',
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    external: ['electron'],
    // Scoped, not `true`: the two builds run concurrently into the same
    // `dist/`, and a whole-directory clean from this one can land after the
    // preload build has written, deleting `preload.cjs`.
    clean: ['main.*'],
    sourcemap: true,
    dts: false,
  },
  {
    entry: { preload: 'src/preload.ts' },
    outDir: 'dist',
    format: ['cjs'],
    platform: 'node',
    target: 'node22',
    external: ['electron'],
    clean: ['preload.*'],
    sourcemap: true,
    dts: false,
  },
])
