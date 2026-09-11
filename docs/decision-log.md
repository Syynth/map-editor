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

## Editor architecture decisions move onto wayfinder maps
- **WHEN:** 2026-09-11
- **PROJECT:** map-editor
- **SYSTEM:** cross-system
- **SCOPE:** moderate
- **WHAT:** The architecture decisions taken while charting the editor refactor are recorded on the wayfinder map [Map: the editor's behavior on actors and commands](https://github.com/Syynth/map-editor/issues/2) and its child tickets, rather than being restated as entries here. This log links to the map instead. Decisions taken outside a charted effort continue to be captured here in full.
- **WHY:** A wayfinder ticket holds the question, the alternatives that were weighed, and the reasoning that produced the answer. Transcribing that into a two-line WHY written after the fact is lossy duplication of the better record. Settled while charting: `Command` names the intent layer and the existing undo entry is renamed `Edit`; commands ride with the actors that handle them across several packages, dispatched through a single root-actor entry point; package boundaries from `monorepo-migration.md` are re-opened because the command layer, the UI package and extensibility all bear on them; UI primitives live in `packages/ui`, the only package depending on Mantine, with a lint rule forbidding CSS and inline styles elsewhere; extensibility is a standing constraint on every boundary decision rather than a deliverable of this effort.

## Prototype decisions taken up front
- **WHEN:** 2026-09-10 *(migrated from `PLAN.md` on 2026-09-11 when that file was retired)*
- **PROJECT:** map-editor
- **SYSTEM:** cross-system
- **SCOPE:** architectural
- **WHAT:** The expensive-to-reverse choices were made before the prototype started, and everything else was deliberately left open.

  | Decision | Choice | Where |
  |---|---|---|
  | Document model | Normalised, serializable, mutated in place behind a revision counter | `core/document.ts`, `core/store.ts` |
  | Undo | Patches with an automatically derived inverse; tools never write `undo()` | `core/edits.ts` |
  | Paint addressing | Stable grid coordinates; cliff faces keyed by **absolute half-tile level** | `core/paint.ts` |
  | Height units | Integer half-tiles (`height: 3` is 1.5 tiles) | `core/document.ts` |
  | World scale | One tile is one world unit, always; texel density is texture detail only | `core/document.ts` |
  | File format | Versioned JSON, single file, migrations from v0 | `core/io.ts` |

- **WHY:** These are the decisions that are cheap now and expensive later, so they were worth making blind rather than discovering. Two have since proved themselves in measurement rather than argument. Mutation-plus-revision exists because a brush stroke writes cells sixty times a second and deep-cloning parallel arrays of tens of thousands of entries per tick is the wrong cost to pay for reference equality. Keying cliff paint by absolute half-tile level — rather than by a row counted from the top, or a row of a swept profile — is the entire mechanism behind "paint survives sculpt", which needed no cleanup code at all, and it is also what makes the brief's section 5 profile strip a cheap change rather than a data migration.

## Decisions deliberately deferred during the prototype
- **WHEN:** 2026-09-10 *(migrated from `PLAN.md` on 2026-09-11 when that file was retired)*
- **PROJECT:** map-editor
- **SYSTEM:** cross-system
- **SCOPE:** moderate
- **WHAT:** Four choices were consciously left open rather than guessed at. **Electron vs Tauri** — the prototype stayed a plain Vite web app, which keeps HMR and defers the choice until there is a heavy scene to smoke-test both with. **Meshing in a worker** — not done; benchmarked instead. **WebGL2 vs WebGPU** — WebGL2, since nothing in the slice needs compute. **Terrain as a voxel view** (brief §7) — closed as "no, not now"; terrain stays a heightfield. Relatedly, the tool layer was left as a switch statement over three tools rather than a plugin API.
- **WHY:** Each deferral was cheap to hold open and expensive to get wrong. The mesher is a pure function with no three.js import, so moving it into a worker stays a wiring change rather than a rewrite — and the benchmark said it is not needed: a brush tick costs about 1 ms once neighbour dirtying is restricted to cells actually on a chunk border, against 6.9 ms for the naive 3x3 neighbourhood. Coupling the heightfield to a voxel grid without evidence is an expensive decision made blind, and blocks are not in the slice. The tool layer stayed concrete for the same reason the rest did: brief section 4's generality waits until a second template kind exists to generalise from, because a plugin API invented before its second consumer is an API designed against one example.

## Build on the XState v6 alpha, pinned
- **WHEN:** 2026-09-11
- **PROJECT:** map-editor
- **SYSTEM:** cross-system (actor layer)
- **SCOPE:** architectural
- **WHAT:** Adopt `xstate@6.0.0-alpha.53` pinned exactly (no caret), with `@xstate/react@7.0.0-alpha.2`, rather than v5.32.6. Prove it on the [#8](https://github.com/Syynth/map-editor/issues/8) dispatch prototype first. Fall back to v5.32.6 with an `enqueueActions`-only dialect if that slice cannot be implemented satisfactorily, or if it is an obvious downgrade against a v5 implementation of the same slice.
- **WHY:** v5's action-creator model is deleted in v6, not deprecated — `assign` / `sendTo` / `spawnChild` / `stopChild` / `enqueueActions` / `emit` / `raise` do not exist anywhere in the v6 declarations; transitions take an `enq` object and return a context patch. So v5 code is written in a dialect upstream has already removed. v6 also solves this map's central routing problem structurally: measured on alpha.53, routing to a stopped child leaves the router `active`, commits the transition, and emits `@xstate.deadletter` with `reason: 'stopped'` — where v5 flips the *sending* actor to `status: 'error'` and silently ignores every later event. An exact pin makes alpha churn opt-in rather than daily. The missing v6 inspector does not bind, because the Stately inspector is not used here.

## Rules that matter are machine-checked, not documented
- **WHEN:** 2026-09-11
- **PROJECT:** map-editor
- **SYSTEM:** cross-system (process)
- **SCOPE:** architectural
- **WHAT:** A constraint that matters gets a mechanical check. Prose-only constraints are advisory and should be marked as such. Lands as a standing constraint on map [#2](https://github.com/Syynth/map-editor/issues/2), plus its own ticket for the checking infrastructure — extending `scripts/check-boundaries.mjs` versus standing up ESLint versus typed rules is that ticket's call, not this one's.
- **WHY:** Agents write most of the code and drift off prose constraints. Part of getting the codebase to where it can be safely developed. The map already carries prose constraints an agent can silently violate — "address child actors by `ActorRef`, never by string id" and "command arguments are plain serialisable data" — and [#12](https://github.com/Syynth/map-editor/issues/12) already carries a lint rule without anything stating why that is the default.

## Prototypes are judged by comparison and taste, not a pass/fail rubric
- **WHEN:** 2026-09-11
- **PROJECT:** map-editor
- **SYSTEM:** cross-system (process)
- **SCOPE:** moderate
- **WHAT:** When a prototype exists to choose between two options, build the slice and compare implementations. Accept or reject on whether the result is satisfactory and whether the alternative is an obvious downgrade — not against falsifiable criteria fixed before either implementation exists.
- **WHY:** A rubric fixed in advance measures proxies, and a prototype can pass every proxy while the resulting code reads badly. What is actually being judged is the ergonomics of the implementation, which only becomes visible once there is one to look at.
