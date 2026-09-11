# Decision log

Decisions made during development, captured as they happen so the reasoning
behind them is not lost. This is a data-capture mechanism, not a findings file:
entries record what was decided and why, at the moment it was decided.

Each entry:

```
## <short description>
- **WHEN:** <date, YYYY-MM-DD>
- **PROJECT:** <project/repo name>
- **SYSTEM:** <short tag — e.g., "editor-ui", "sidecar", "asset-pipeline", "cross-system", or a spec name>
- **SCOPE:** <interpreted scope — e.g., "minor/local", "moderate", "architectural">
- **WHAT:** <what was decided>
- **WHY:** <the rationale — this is the most important field>
```

`- **STATUS:** tentative` after SCOPE marks a decision the author expects may change.

---

## Camera orbit follows DCC modifier conventions
- **WHEN:** 2026-09-10
- **PROJECT:** map-editor
- **SYSTEM:** editor-ui
- **SCOPE:** minor/local
- **WHAT:** Option/Alt+drag orbits the viewport camera, matching Maya/Unity. Eyedropper stays on Option+click, disambiguated from orbit by a small drag threshold. Right-drag pans, scroll/pinch zooms. Middle-drag orbit is kept as a secondary binding.
- **WHY:** The editor is developed on a MacBook trackpad, which has no middle button, so middle-drag orbit is unreachable in normal use. The previous trackpad fallback (Option+Shift+drag) was undiscoverable and contradicted its own code comment. Aligning with Maya/Unity means anyone arriving from a 3D tool already knows the gesture, so the binding does not have to be taught.

## Monorepo layout, toolchain, and publishing posture
- **WHEN:** 2026-09-11
- **PROJECT:** map-editor
- **SYSTEM:** cross-system
- **SCOPE:** architectural
- **WHAT:** The prototype is promoted to a pnpm + Turborepo monorepo: `packages/core`, `packages/runtime`, `packages/exporter`, `apps/editor`, with `apps/desktop` reserved for the undecided Electron/Tauri shell. The extras spec and its JSON Schema stay inside `core` until a third party implements it standalone. `packages/runtime` is built as a properly consumable package but stays private; publishing machinery waits for an outside consumer.
- **WHY:** Three independent consumers now justify real packages rather than the advisory `check-boundaries.mjs` script — a runtime game devs install, a headless exporter CLI needing core without a browser, and a desktop shell that is a separate build target. pnpm's strict `node_modules` makes the `core <- runtime <- editor` layering structural: core cannot import three.js if it is not a declared dependency, replacing a custom script with resolution failure. Turborepo is adopted up front rather than deferred so orchestration is configured once against the final shape instead of retrofitted. Keeping runtime private avoids committing to semver before anyone outside the repo depends on it, while still building it as if it will be published.

## Restructure into packages before adding CI and lint tooling
- **WHEN:** 2026-09-11
- **PROJECT:** map-editor
- **SYSTEM:** cross-system
- **SCOPE:** moderate
- **WHAT:** The monorepo split happens first; CI, linting, formatting, and git hooks are configured afterwards, against the final package layout.
- **WHY:** The codebase is small enough (~8.4k lines across three already-separated layers) to hold in one head, so the move is cheapest now and only gets harder as the code grows. Configuring lint, CI, and hooks against the current single-package layout would mean configuring all of it twice. The safety net during the move is the existing 53 tests and typecheck run locally — the gate exists, it is simply not yet automated.

## Mantine as the UI component library
- **WHEN:** 2026-09-11
- **PROJECT:** map-editor
- **SYSTEM:** editor-ui
- **SCOPE:** moderate
- **WHAT:** Mantine is adopted as the editor's component library, replacing the eight hand-rolled primitives in `src/editor/ui.tsx`. The CSS custom properties in `styles.css` are mapped onto a Mantine theme rather than kept as a parallel token system. `@mantine/form` is the form layer for engine-defined custom types.
- **WHY:** Mantine ships near-exact equivalents of the primitives already hand-rolled for the dense inspector — `NumberInput`, `Slider`, `ColorInput`, `Select` — plus the accessibility-heavy overlay components (menus, dialogs, tooltips, popovers) the editor does not have yet and would otherwise have to build itself. It also supplies a real form layer, which matters because brief §13 makes forms generated from engine-defined JSON Schema a firm requirement rather than a nice-to-have. Writing and owning less of this code is worth more than full control over the look.

## XState actors as the editor's control-flow model
- **WHEN:** 2026-09-11
- **PROJECT:** map-editor
- **SYSTEM:** cross-system
- **SCOPE:** architectural
- **WHAT:** Editor state, tool state, panel state and async work are all modelled as communicating XState actors. The document store (`core/store.ts`) is the one deliberate exception and keeps its mutable-plus-revision model: machines own control flow and tell the store to apply commands, but never hold the map in machine context. Per-frame viewport telemetry also stays out of machines.
- **WHY:** Several forces point the same way. The editor is already full of implicit state machines written as unions plus scattered conditionals — `Viewport.dragging` is the clearest case, and extending it by hand produced a play-mode inconsistency on the first attempt. Statecharts make those transitions declarative and testable without a browser. As the brief's remaining tools arrive (buildings, blocks, prefabs, fences, engine-defined types), every tool having the same actor shape means the shared framework emerges uniformly rather than being refactored into existence later. Async work — worker meshing, file I/O, export, autosave — needs cancellation, progress and failure handling, which is what the actor model is built for and which is painful to bolt on afterwards. Beyond those, this is the author's default from experience, and coding agents operate more reliably against explicit statecharts than against ad-hoc state scattered through handlers.

## The document has one write path and one read path, both mechanically enforced
- **WHEN:** 2026-09-11
- **PROJECT:** map-editor
- **SYSTEM:** cross-system
- **SCOPE:** architectural
- **WHAT:** All document mutation goes through the XState actor, which is the sole holder of a write handle. `createDocumentStore()` returns a reader and a writer; only the machine receives the writer, and once `core` is its own package the writer is not part of its public exports. Consumers see the document as a deep-readonly type, so any direct write is a compile error. Reads go through a single `useDocument(selector)` hook that subscribes to the revision counter internally. The document itself stays mutable behind the store and never enters machine context.
- **WHY:** Consistency has to be enforced by the toolchain rather than by convention, because coding agents do not reliably follow prose rules but do respond immediately to a failing typecheck. The current design is honoured only by discipline: `store.doc` is public and mutable and is read 44 times across the editor, so nothing prevents the next read becoming a write. A deep-readonly view was verified to reject every write shape (indexed assignment, record assignment, array mutation, property replacement) while leaving reads untouched. A single read hook closes the matching hazard on the read side: derived state keyed on `doc` never recomputes because `doc` never changes identity, which already shipped one bug in the coverage readout, and reading the document without subscribing to the revision silently fails to re-render.
