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
 * Everything is bundled in except `@napi-rs/canvas`, which is a native
 * binding and cannot be. That keeps the app's declared runtime dependency set
 * honest: one entry, for the one thing the bundle has to reach for.
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
    external: ['@napi-rs/canvas'],
  },
})
