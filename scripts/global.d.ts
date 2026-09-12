// Ambient shape of the debug globals `apps/editor/src/editor/App.tsx` puts on
// `window` for exactly this purpose ("scripts/tour.mjs and scripts/probe.mjs
// drive the real editor in a headless browser"). App.tsx itself widens them
// through `Record<string, unknown>` rather than augmenting `Window` — adding
// a global augmentation there would leak into every file that ever sees
// `window` app-wide, for a surface only these drivers use — so the real
// types live here instead, imported from the packages that own them, and
// this file's job is only to say WHERE each hook attaches, matching
// App.tsx's assignments field for field.
//
// Declared non-optional: every script below only touches `window.__viewport`
// etc. after `page.goto` plus a settle sleep, on the premise that by then
// `App` has mounted and run the effect that sets them (`__bake` is the one
// exception — bake.html's generator is genuinely async, so
// scripts/bake-fixtures.mjs waits for it with `waitForFunction` and that call
// site carries its own narrowing). A wrong premise here fails the same way
// it already does at runtime — `undefined is not a function` from Playwright
// — so marking these optional would only trade that crash for a `!` at every
// call site without catching anything for real.
import type { EditorStore, MapObject, flatten, raise, removeObject, updateObject } from '@map-editor/document'
import type { Viewport } from '@map-editor/viewport'

export {}

declare global {
  interface Window {
    __viewport: Viewport
    __store: EditorStore
    __ops: {
      flatten: typeof flatten
      raise: typeof raise
      removeObject: typeof removeObject
      updateObject: typeof updateObject
    }
    __selectObject: (id: MapObject['id'] | null) => void
    // Set once, after `apps/editor/src/bake/main.ts`'s generator finishes —
    // see that file's own `BakeResult` for the manifest's real shape.
    // `unknown` here is enough: every reader either JSON.stringifies it
    // whole or never looks past `files`.
    __bake?: {
      manifest: unknown
      files: Record<string, string>
    }
  }
}
