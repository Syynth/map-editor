// `.ts`, not `.d.ts`, despite this file being nothing but ambient
// declarations: `scripts/tsconfig.json` keeps `skipLibCheck: true` (its own
// comment says why), which skips `.d.ts` files entirely — a `.ts` module is
// checked like any other source file, so a broken import below still fails
// loudly at the `import` line instead of silently widening every consumer
// to `any`.
//
// Ambient shape of the debug globals `apps/editor/src/editor/App.tsx` puts on
// `window` for exactly this purpose ("scripts/tour.mjs and scripts/probe.mjs
// drive the real editor in a headless browser"). `__store` was one of them
// until #66 step 7 removed the store from the app entirely; `__host` replaced
// it, and it is a better hook rather than a renamed one — a driver reads
// through `reader` and WRITES THROUGH `dispatch`, which is the same door a
// keybinding and a panel use, so a tour step exercises the real command path
// instead of a private method. `__ops` and `__selectObject` went with it:
// both existed to reach a write path that no longer exists. App.tsx itself widens them
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
import type { Host } from '@papercut/editor-host'
import type { Viewport } from '@papercut/viewport'

export {}

declare global {
  interface Window {
    __viewport: Viewport
    __host: Host
    // Installed by scripts/perf.mjs's init script before the app loads: the
    // frame intervals it records into a preallocated array (so recording
    // allocates nothing) and the long tasks the page reports while recording.
    __perf?: {
      intervals: Float64Array
      count: number
      last: number
      recording: boolean
      longTasks: number[]
    }
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
