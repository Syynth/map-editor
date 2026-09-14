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
| Language / build | TypeScript, Vite, pnpm + Turborepo; `tsup` for package JS emit, `tsc` for `.d.ts` (#46) |
| Rendering | three.js, WebGL2 |
| UI framework | React |
| Components | Mantine |
| Forms | `@mantine/form` |
| Control flow | XState — actors all the way up |
| Document state | Bespoke mutable store with a revision counter (**not** a library) |
| Desktop shell | Electron; the web UI bundle updates separately from the signed shell |

## Three kinds of state, deliberately kept separate

This is the part most likely to be broken by a well-meaning refactor, so it is
written down explicitly.

**1. The document — `packages/document` (formerly `core/store.ts`). One write path, one read path, both
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
- [x] Start with `Viewport.dragging` — the `'none' | 'stroke' | 'orbit' | 'pan'
      | 'pending'` union and its transitions across three pointer handlers. It
      is the clearest existing machine and the one that has already produced a
      bug. Done in #66 step 4, as a SPLIT rather than a move: arbitration (which
      button with which modifier, the threshold, the alt press replayed as a
      click) is `editor-host`'s gesture actor; the per-frame yaw, pitch and pan
      deltas stayed in `viewport.ts`, which now asks the actor what gesture is
      in progress and applies deltas against the answer. The bug went with it —
      the replayed click picks at the press, not at the release.
- [ ] Tool modes as hierarchical states: terrain(sculpt/paint) × verbs, objects,
      camera.
- [x] Edit versus play as a top-level state: the host actor's `edit`/`play`
      (#66 step 3). Since step 4 it is the only copy: `App.tsx` derives
      `playing` from the host's mode, and the gesture actor reads it per press
      to decide whether a left press starts a stroke — middle, right and
      alt+drag still orbit and pan in play mode, as they always did. Step 7
      added the SESSION beneath it: `mode.play` spawns a play actor whose
      lifetime is the session and which reads where the character stands up
      from the document once, at spawn; `mode.edit` stops it. The per-frame
      character simulation stays in the viewport, where the clock is.
- [ ] Async work as actors: worker meshing, file load/save, glTF export,
      autosave — with cancellation, progress and failure handling.
- [x] Move the 18-field `EditorState` out of the single `useState` in `App.tsx`.
      Done in #66 step 4, because the stroke actor reads the tool parameters
      and the eyedropper writes them back, and two copies of those would have
      drifted within one drag: the sixteen fields now belong to the `tools`
      actor (eleven), the `view` actor (four) and the host's own mode
      (`playing`), and `App` assembles the object the panels take from their
      snapshots. `set` routes each group to `tools.set`, `view.set`,
      `selection.set` or `mode.play`/`mode.edit`.
- [x] Finish the App rewire (#66 step 7). Step 4 took the state ownership half
      early — it had to, since the stroke actor reads the tool parameters and
      the eyedropper writes them back — and step 7 took the rest:
      - `apps/editor/src/editor/state.ts` is deleted. `App` reads the tool
        parameters, the view toggles, the selection and the mode from their
        actors, and every setter is a `dispatch`.
      - `exhaustive-deps` is on, repo-wide, with no suppressions (there could
        not be one: `noInlineConfig`). The viewport effect now depends on
        `[host]` and constructs from a ref of the current art, so the WebGL
        context survives a material edit; the two memos keyed on a revision
        counter are `useDocument` selectors, which memoise on the revision
        inside the hook.
      - Every direct store call in `App.tsx` has a command: `objects.update`,
        `camera.set`, `atmosphere.set`, `document.load` and `document.new`
        join `undo`/`redo`/`objects.delete` on the document actor, and the
        inspector's Delete button dispatches the `selection.delete` composite
        the keymap already bound.
      - `EditorStore` is out of `packages/document`'s barrel and out of
        `main.tsx`: an app calls `createDocument(doc)` and holds a `reader`
        plus the actor logic. There is no second write path left to document.
      - The left column renders the terrain feature's DECLARED panels, chosen
        by the active tool's declaring owner, rather than the app's own copy
        of the same controls.
      - `window.__store` became `window.__host`, and `__ops` and
        `__selectObject` went away with it: the tour reads through
        `reader` and writes through `dispatch`, so a tour step exercises the
        command path the editor itself uses (`scripts/global.ts` types both,
        and is typechecked).
- [ ] Establish the machine/store boundary in code review terms, so the document
      never drifts into machine context.

### Close the document's write and read paths
- [x] `createDocumentStore()` returns `{ reader, writer }`; only the machine is
      constructed with `writer`. Neither `createDocumentStore` nor the writer
      type is in `packages/document`'s barrel; the package exposes the
      pre-wired `createDocument(doc)` instead — `{ reader, logic }`, the two
      faces an app may hold (#13, #66 steps 2 and 7). `EditorStore` left the
      barrel with step 7, when the last direct `store.apply` in `App.tsx`
      became a command: the second write path is closed by the type graph
      rather than by a rule.
- [x] Type the public document as `ReadonlyMapDoc` (a deep-readonly mapped
      type). Verified to reject indexed assignment, record assignment, array
      mutation and property replacement, while leaving reads untouched — the
      arrays are plain `number[]`, so no branding tricks are needed. Held by a
      typecheck-time test in `packages/document/src/actor.test.ts`.
- [x] A single `useDocument(selector)` hook that subscribes to the revision.
      Closes both read hazards at once: memoising on `doc` never recomputes
      (it never changes identity), and reading without subscribing silently
      fails to re-render. In `editor-host` (#66 step 3); `App.tsx` moves onto
      it in step 7.
- [x] Route the existing `store.doc` reads — 59, not 44: `runtime/scene.ts`
      adds 15 — through `reader`. `EditorStore.doc` is private now; every
      read-only function down the ladder (`ops`, `io.serialize`, `geometry`,
      `runtime`, `viewport`, the app's tools and panels) takes `ReadonlyMapDoc`
      or a `DeepReadonly<…>` slice of it. The React reads move onto the hook
      when it exists; `viewport.ts` and `scene.ts` keep the reader directly.
- [x] Keep the store reference out of machine `context`; XState's inspector
      would try to serialise the whole map every transition. Use a machine
      factory closure — **not** `input`, which rides on the `xstate.init` event
      and reaches the inspector even when kept out of context. Measured on
      xstate 5.32.6: a 50k-entry store passed as `input` puts 100,089 bytes on
      the init event; the same store captured in a factory closure puts 22.
      The inspector's `filter` and `sanitizeContext` do not help, because the
      snapshot is stringified before either runs. `documentLogic(writer)` is
      that closure.

### Compact stroke patches
Measured on the real store: a 3-second drag with a size-5 round brush over 180
ticks produced **3,780 patches and 3,780 inverses across 260 unique addresses —
14.5x redundancy**. Dragging back over an already-raised cell emits a fresh
patch every tick, and `pruneNoops` does not catch it because 0 -> 1 -> 2 -> 3 is
three legitimate non-noop writes.

- [x] Compact per address within a stroke: keep the **last** forward value and
      the **first** inverse value. Lossless, because intermediate states inside
      one stroke are never observable — the whole drag is a single undo entry.
      An address whose last value equals its first is dropped entirely: a cell
      put back where it started is not part of the edit.
- [x] Natural home is the stroke actor's context, as a
      `Map<addressKey, { first, last }>` flushed on `endStroke` (#66 step 4).
      The store stopped accumulating rather than learning to compact: a tick
      arrives as `applyStrokeTick`, which APPLIES but does not RECORD, and the
      entry the store pushes is the record the actor hands it, so there is
      exactly one owner of the stroke's history. `patchAddress` and
      `inversePatch` moved into `packages/document`'s barrel for it — the actor
      has to key a patch and read its before-value while holding only `reader`.
- [x] A stroke tick has its OWN VERB, so `apply` still always records. The
      first cut made "inside a stroke" a property of `apply`, and an ordinary
      edit that landed mid-drag — the Delete keybinding fires from a `window`
      keydown listener, which pointer capture does not stop — was applied and
      recorded by neither the history nor the stroke's map. Worse than a lost
      entry: `removeObject` patches `objects[id]` and `objectOrder`, so undoing
      the stroke afterwards could restore the object without its order entry.
      Pinned at both levels — `document.test.ts` through the store, and
      `host.test.ts` through `createHost` + `host.input`.
- [x] The own-verb fix stops the write being lost; it does not by itself make
      two entries over ONE address unwind correctly. A mid-drag `Delete object`
      of the very object being dragged (the object tool drags the selection,
      and Delete deletes the selection) records two independent entries whose
      stack order disagrees with the order they were written, and the first
      undo resurrects the object into `objects` while `objectOrder` — owned
      only by the other entry — stays without it. The same orphan, one step
      further along. So `apply` REFUSES a concurrent write, whole, at an
      address the open stroke has already written, and the Delete keybinding
      is gated on `host.stroking` so it does not clear the selection for a
      delete that will not land — `App`'s `store.inStroke` check, moved into a
      predicate that can also say why (#66 step 6). Only that direction needs the
      rule: a stroke that later crosses an address an ordinary edit already
      wrote records its before-value lazily, at the tick that first touches
      it, so those two entries already unwind newest-first in write order.
- [x] The other half of the stroke contract: `undo` and `redo` are REFUSED
      while a stroke is open, and `canUndo`/`canRedo` report false, because the
      entry the drag will produce does not exist yet. This replaced a
      close-the-stroke-and-undo, which left the rest of the drag with no record
      at all. The editor's footer reads `canUndo()` before it names the entry,
      so it does not advertise an undo the disabled button will not perform.
- [x] Patches must still **apply immediately** so terrain deforms mid-drag. Only
      the undo record is compacted; this is not buffer-then-apply. Pinned by a
      test that asserts the height moved and `canUndo()` is still false on
      every tick.
- [x] Add a regression test asserting committed patch count equals unique
      addresses touched — `packages/editor-host/src/stroke.test.ts`.

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
- [x] **A keymap registry** (#14, #66 step 6). Bindings are declarations —
      `(chord, command id, args, when)` — in one ordered list, scanned in
      reverse with `core` < `tool` < `feature` < `user` as the whole ordering
      mechanism. A binding whose condition is false FALLS THROUGH rather than
      swallowing the key, and the condition is the binding's `when` ANDed with
      the command's own, so a toggle is two bindings on one chord rather than a
      handler that reads the current value. `unbind` deletes a rule so what sat
      under it becomes reachable; `command: null` shadows, consuming the key.
      Conflict detection runs at declare time for identical `(chord, when)`
      only — possible at all because `disjoint(a, b)` can decide two predicates,
      which is the thing Blender's `poll()` forecloses. The two `window`
      listeners are one: `apps/editor/src/editor/keys.ts`, which forwards every
      key to the gesture actor for the held set and resolves the chord half
      only outside a text field. Still open: user rebinding and where it
      persists (the preferences store below), and a palette or keybinding
      editor over `keymap.bindingFor`.

### Platform
- [ ] A file I/O abstraction. The browser File API is used today and Electron
      reaches the disk through its preload script — an interface keeps the web
      build and the desktop shell on one code path.
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
