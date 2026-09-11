# Stack

What the editor is built from, and why. Decisions and their rationale live in
[`decision-log.md`](decision-log.md); this file is the working picture of the
stack plus the work still needed to get there.

Companion to [`monorepo-migration.md`](monorepo-migration.md), which covers
repository structure rather than technology choice.

---

## Settled

| Concern | Choice |
|---|---|
| Language / build | TypeScript, Vite, pnpm + Turborepo |
| Rendering | three.js, WebGL2 |
| UI framework | React |
| Components | Mantine |
| Forms | `@mantine/form` |
| Control flow | XState — actors all the way up |
| Document state | Bespoke mutable store with a revision counter (**not** a library) |
| Desktop shell | Electron or Tauri — still open, decided by a heavy-scene smoke test |

## Three kinds of state, deliberately kept separate

This is the part most likely to be broken by a well-meaning refactor, so it is
written down explicitly.

**1. The document — `core/store.ts`. One write path, one read path, both
enforced by the compiler. Do not move this into a library or into machine
context.** Mutation goes through the actor, which alone holds the write handle;
everyone else sees a deep-readonly view, so a direct write is a compile error.
Reads go through `useDocument(selector)`, which subscribes to the revision
internally. The map is held mutably and edits bump a revision counter;
React subscribes through `useSyncExternalStore`. A brush stroke writes cells
sixty times a second, and deep-cloning parallel arrays of tens of thousands of
entries per tick is exactly the cost this design exists to avoid. That rules out
Redux Toolkit, immer, and XState's `assign` **for the document specifically**.

**2. Control flow and pending changes — XState actors.** Tool modes, gesture and
stroke lifecycles, edit versus play, panels, and async work. Machines decide
*what should happen* and tell the store to apply a command; they never hold the
map.

They *do* hold the pending change set, which is small. A stroke actor's context
is a compaction map keyed by patch address — bounded by cells touched rather
than by ticks — so cloning it per transition is free. See "Compact stroke
patches" below.

**3. Per-frame viewport telemetry — plain callbacks, already correct.** `onStats`
is throttled to 0.5s and `onCameraChange` fires every frame but is
epsilon-guarded in `App.tsx` so React bails out when nothing moved. Leave it
alone; do not route it through a machine.

## Not needed

- **No data-fetching layer** (TanStack Query, SWR). This is a local-first
  desktop app with no server.
- **No router**, unless a genuine multi-window or multi-document need appears.
- **No CSS-in-JS runtime.** Mantine's theme plus CSS modules covers it.

---

## Work to do

### Migrate to Mantine
- [ ] Map the CSS custom properties in `styles.css` (`--bg`, `--panel`,
      `--accent`, …) onto a Mantine theme, so there is one token system rather
      than two drifting in parallel.
- [ ] Replace the eight primitives in `ui.tsx` with Mantine equivalents:
      `Field`, `Segmented`, `Slider`, `NumberInput`, `Select`, `ColorInput`,
      `Panel`, `Note`.
- [ ] Adopt the overlay components the editor does not have yet and will need:
      context menus, dropdowns, dialogs, tooltips, popovers.

### Adopt XState
- [ ] Start with `Viewport.dragging` — the `'none' | 'stroke' | 'orbit' | 'pan'
      | 'pending'` union and its transitions across three pointer handlers. It
      is the clearest existing machine and the one that has already produced a
      bug.
- [ ] Tool modes as hierarchical states: terrain(sculpt/paint) × verbs, objects,
      camera.
- [ ] Edit versus play as a top-level state that changes input interpretation.
- [ ] Async work as actors: worker meshing, file load/save, glTF export,
      autosave — with cancellation, progress and failure handling.
- [ ] Move the 18-field `EditorState` out of the single `useState` in `App.tsx`,
      so changing brush size stops re-rendering every panel.
- [ ] Establish the machine/store boundary in code review terms, so the document
      never drifts into machine context.

### Close the document's write and read paths
- [ ] `createDocumentStore()` returns `{ reader, writer }`; only the machine is
      constructed with `writer`. Keep `writer` out of `core`'s public exports
      once it is its own package.
- [ ] Type the public document as `ReadonlyMapDoc` (a deep-readonly mapped
      type). Verified to reject indexed assignment, record assignment, array
      mutation and property replacement, while leaving reads untouched — the
      arrays are plain `number[]`, so no branding tricks are needed.
- [ ] A single `useDocument(selector)` hook that subscribes to the revision.
      Closes both read hazards at once: memoising on `doc` never recomputes
      (it never changes identity), and reading without subscribing silently
      fails to re-render.
- [ ] Audit the 44 existing `store.doc` reads — `viewport.ts` (20), `App.tsx`
      (19), `tools.ts` (5) — onto the hook.
- [ ] Keep the store reference out of machine `context`; XState's inspector
      would try to serialise the whole map every transition. Use a machine
      factory closure or `input`.

### Compact stroke patches
Measured on the real store: a 3-second drag with a size-5 round brush over 180
ticks produced **3,780 patches and 3,780 inverses across 260 unique addresses —
14.5x redundancy**. Dragging back over an already-raised cell emits a fresh
patch every tick, and `pruneNoops` does not catch it because 0 -> 1 -> 2 -> 3 is
three legitimate non-noop writes.

- [ ] Compact per address within a stroke: keep the **last** forward value and
      the **first** inverse value. Lossless, because intermediate states inside
      one stroke are never observable — the whole drag is a single undo entry.
- [ ] Natural home is the stroke actor's context, as a
      `Map<addressKey, { first, last }>` flushed as one command on `endStroke`.
- [ ] Patches must still **apply immediately** so terrain deforms mid-drag. Only
      the undo record is compacted; this is not buffer-then-apply.
- [ ] Add a regression test asserting committed patch count equals unique
      addresses touched.

### Schema and validation
Brief §13 makes generated forms from engine-defined types a **firm requirement**,
and §14 makes the extras spec a public contract other engines implement.

- [ ] **Ajv** for real JSON Schema: engine-defined custom types and the versioned
      extras spec.
- [ ] **Zod** for internal TS-first validation, replacing the hand-rolled checks
      in `core/io.ts` (123 lines).
- [ ] A JSON Schema → Mantine form renderer. Likely bespoke; this is the piece
      most easily underestimated.

### Input
- [ ] **A keymap registry.** Shortcuts are currently raw `keydown` on `window`
      into a `Set<string>`. Needs declared bindings, conflict detection and user
      rebinding. The Option+drag orbit binding was unreachable on a MacBook
      trackpad precisely because bindings are scattered and undeclared; this
      gets worse, not better, with more tools.

### Platform
- [ ] A file I/O abstraction. The browser File API is used today and Electron
      and Tauri differ here — an interface now keeps the deferred shell decision
      cheap.
- [ ] Autosave and crash recovery.
- [ ] A preferences store: keybindings, theme, recent files.

### Later, but decide now
- [ ] **Virtualization** (TanStack Virtual) — the outliner and tile palette both
      become long lists.
- [ ] **Worker RPC** (Comlink) for when the mesher moves off the main thread.
      Benchmarks say it is not needed yet.
- [ ] **Icons** — Lucide.
- [ ] **A docs site for the extras spec**, since "engine-agnostic" means other
      people implement it.
- [ ] **i18n** — decide yes or no now. Cheap to stub, painful to retrofit.
- [ ] Error reporting for the desktop build. Deferred.
