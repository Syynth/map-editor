import { defineConfig } from 'vite'

/**
 * A Node bundle, not a web build.
 *
 * WHY there is a build step at all, for an app that is plain TypeScript run by
 * a runtime that can strip types: the packages it imports use extensionless
 * relative specifiers (`./billboard`), which Node's ESM resolver does not
 * resolve. Bundling is the boring fix. It is `vite` rather than a new
 * bundler because `apps/editor` already builds with this exact version, so
 * the repo gains a config file and not a tool.
 *
 * Nothing is external any more (#48): the native canvas that forced an
 * `external` entry the first time this app existed is gone along with the
 * whole 2D-canvas texture path (#47) — `fast-png`, like everything else this
 * app imports, is pure JS and bundles in clean.
 */
export default defineConfig({
  build: {
    ssr: 'src/cli.ts',
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node26',
    rollupOptions: {
      output: {
        entryFileNames: 'cli.js',
        banner: '#!/usr/bin/env node',
      },
    },
  },
  ssr: {
    noExternal: true,
  },
})
