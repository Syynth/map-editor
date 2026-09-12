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
- **STATUS:** layout superseded 2026-09-11 by [#3](https://github.com/Syynth/map-editor/issues/3) — `packages/core` and `packages/exporter` were both dropped; the shipped layout is `document`, `geometry`, `runtime`, `fixtures`, `ui`, `viewport`, `eslint-rules` and `apps/editor`. Toolchain and publishing posture stand.

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

## Tests and scripts are exempt from the custom lint rules
- **WHEN:** 2026-09-11
- **PROJECT:** map-editor
- **SYSTEM:** cross-system
- **SCOPE:** moderate
- **WHAT:** Test files and `scripts/` are exempt from every custom lint rule, scoped out by flat-config `files:` globs. `packages/fixtures` is **not** exempt. This amends [#20](https://github.com/Syynth/map-editor/issues/20), which had decided no escape hatches beyond `packages/ui`. `noInlineConfig` is unchanged: there are still no inline suppressions anywhere, and an exemption remains a path glob in a config file rather than a comment in source. Detail and consequences on that ticket.
- **WHY:** Because #20 removed inline suppressions, code that must violate a rule has no recourse at all — it cannot be written. That bites first in the least avoidable place: the test asserting a rule actually fires needs a violating fixture by construction. A blanket exemption was chosen over a per-rule judgement so the boundary is a path, not an argument to be relitigated in every rule's ticket. `packages/fixtures` was initially included and then pulled back out: it is described as dev-only, but the sample map and procedural textures it generates are loaded by the real editor, so its output has to satisfy the same invariants as anything else. The line that survives is that tests and scripts describe or drive the system from outside it, while fixtures produces data that flows into it.

## The brief's "hardcode first" guidance is superseded: the prototype is done and this is the foundation
- **WHEN:** 2026-09-11
- **PROJECT:** map-editor
- **SYSTEM:** cross-system
- **SCOPE:** architectural
- **WHAT:** The brief's "Read this first" guidance — don't build plugin APIs, generic tool frameworks, or extensible registries until two or three concrete cases need them; hardcode first, extract later — is retired for this project. Abstractions that make agent-written code reliable and checkable are justified before a second human consumer exists, including extension surfaces. The map's direction stands: actors all the way up, an enumerable command layer, enforced package boundaries, and the feature-module registry as a deliverable ([#9](https://github.com/Syynth/map-editor/issues/9), [#21](https://github.com/Syynth/map-editor/issues/21)). The brief's principle that the artist is the primary user and "friendly wins" is **not** retired; only its guidance on when to abstract is. Recorded in response to [`docs/audit-2026-09-11.md`](audit-2026-09-11.md) §1.
- **WHY:** The brief was written for the exploratory prototype — its own status line says so — and "hardcode first" was the right rule for that phase: build the smallest thing that teaches something, then stop and show it. The prototype is done and has answered what it was built to answer (`FINDINGS.md`). What is being built now is the real foundation for the actual work, and the rule for a foundation is not the rule for a probe. Alongside that: most of this codebase will be written by coding agents, and agents operate reliably against explicit statecharts, declared seams and mechanically enforced boundaries, and unreliably against ad-hoc state and prose rules — so the abstractions the brief deferred are what makes agent output trustworthy at all, and deferring them costs more in review and rework than building them costs up front. The brief's warning was about human cognitive cost, and that does not carry over. It is also the author's established default across projects.

## No native binary dependencies for tooling; the export CLI is cut rather than carry one
- **WHEN:** 2026-09-11
- **PROJECT:** map-editor
- **SYSTEM:** cross-system
- **SCOPE:** moderate
- **WHAT:** `@napi-rs/canvas` is removed and `apps/export-cli` with it. The headless glTF exporter needed a 2D canvas — both the procedural texture generator and three's `GLTFExporter` draw through one — and no canvas-free path exists yet. The runtime's `./export` subpath stays; it works in the editor, which has a real canvas. The CLI returns once export has a canvas-free texture path (raw RGBA crossing the boundary, the reshape #3 costed out), which is now the prerequisite for both the CLI and for moving `textures.ts` into `packages/fixtures`.
- **WHY:** The owner's words: *"definitely get rid of it, if there's not a good replacement, the cli can just be cut for now."* A native binary in a dev CLI is not worth its install and CI cost while the CLI is not load-bearing, and shimming a DOM into node so browser code can run is the wrong direction — the right fix is a texture path that never needed a canvas, and that is a design decision, not a dependency swap.

## Four rulings on the restructure's follow-up decisions (#33, #37, #38, #39)
- **WHEN:** 2026-09-11
- **PROJECT:** map-editor
- **SYSTEM:** cross-system
- **SCOPE:** moderate
- **WHAT:** Recorded on the wayfinder map's tickets, which hold the reasoning: [#38](https://github.com/Syynth/map-editor/issues/38) tests are exempt from all lint; [#39](https://github.com/Syynth/map-editor/issues/39) `minimumReleaseAgeStrict` on and CI never caches lockfile verification; [#37](https://github.com/Syynth/map-editor/issues/37) `rules-of-hooks` now, `exhaustive-deps` with the actor migration; [#33](https://github.com/Syynth/map-editor/issues/33) emit `.d.ts` and use project references.
- **WHY:** Three followed the recommendation. #33 went against it — no emit was recommended because nothing consumes built output — on the strength of the standing "private for now, built as if publishable" posture: a package that only resolves as bundler-read source is not built as if publishable, and retrofitting emit later across seven packages is the drift the restructure exists to prevent.

## Four architectural rulings: feature placement, the texture boundary, package surfaces, sheet.ts (#35, #32, #34, #36)
- **WHEN:** 2026-09-11
- **PROJECT:** map-editor
- **SYSTEM:** cross-system
- **SCOPE:** architectural
- **WHAT:** Recorded on the map's tickets, which hold the alternatives and reasoning. [#35](https://github.com/Syynth/map-editor/issues/35): features sit beside the host, both on the registry, only apps import features, and the registry holds the tool/stroke contract types. [#32](https://github.com/Syynth/map-editor/issues/32): raw RGBA is the texture crossing type, `runtime` never touches a canvas, and export takes an injected PNG encoder — no native code. [#34](https://github.com/Syynth/map-editor/issues/34): a barrel exports what has an outside consumer plus the types to name it; `runtime` narrows now, `document` with the document actor. [#36](https://github.com/Syynth/map-editor/issues/36): `sheet.ts` stays in `apps/editor` as the file-I/O edge until the file-I/O abstraction owns it.
- **WHY:** All three followed the recommendation. #35 is the VS Code shape — extensions and workbench never import each other — and is what makes "replaceable from outside the tree" true by construction. #32 is what lets `fixtures` complete, gives "no canvas in runtime" a compiler check, and revives the headless exporter without the native dependency that got it cut. #34 keeps the write machinery from becoming a permanent public surface by accident of a move.

## No pixel baselines yet: CI asserts structural signals and keeps screenshots as artifacts (#60)
- **WHEN:** 2026-09-11
- **PROJECT:** map-editor
- **SYSTEM:** ci
- **SCOPE:** moderate
- **WHAT:** Recorded on [#60](https://github.com/Syynth/map-editor/issues/60). The tour runs in CI and fails on what a machine judges reliably — console errors, a frame below a luminance floor, status-bar values, mesh and triangle counts — and uploads its screenshots as workflow artifacts for the human gate. No checked-in pixel baselines and no orphan baselines branch. Revisit pixel diffing when a stable GPU runner exists.
- **WHY:** Both rendering bugs this project has had were caught by a human looking at screenshots, not by a pixel diff, and CI renders through SwiftShader, where GL output is not stable enough across runs for a diff without perpetual tolerance-tuning. A luminance floor catches the one class a machine can name — the black frame — without pretending to judge the rest.

## Four map tickets closed with tentative defaults so building can start (#10, #14, #22, #23)
- **WHEN:** 2026-09-11
- **PROJECT:** map-editor
- **SYSTEM:** cross-system
- **SCOPE:** architectural
- **STATUS:** tentative
- **WHAT:** The last four open decision tickets on the map — verification strategy (#10), the keymap registry (#14), the `enq`-purity rule (#22), and the command argument schema (#23) — are closed with the dispatcher's recommended answers recorded as defaults. Each ticket holds its default and the reasoning. The map's route is clear and the actor migration is filed as the build handoff.
- **WHY:** The owner's words: *"this is all dumb, i just want to switch to building the app."* After eight rulings in one sitting, a further six-question round on #10 was the wrong ratio of deciding to building. Recording explicit defaults is strictly better than building against implicit ones: every default is visible, attributed to the agent rather than the owner, and reversible by reopening the ticket. The defaults are not guesses — each follows from research already on the map (#4, #5, the Standard Schema and v6 measurements) and from rulings already made (#13, #35).

## Wayfinding is retired; finish the refactor on the pump, then build features together
- **WHEN:** 2026-09-11
- **PROJECT:** map-editor
- **SYSTEM:** cross-system
- **SCOPE:** architectural
- **WHAT:** No more wayfinder maps or decision tickets. The refactor — the actor migration (#66), emit and references (#46), and the tail (#48, #56) — is finished on the autonomous pump with adversarial review and the protected `main`. After that, feature work is the owner and the assistant building directly, in conversation, with no orchestration ceremony. The decision log stays.
- **WHY:** The owner's words: *"i tried the wayfinding thing, i have decided i hate it, and i just want to finish the refactor so we can make the editor good"* and *"once the refactor is done, i want to switch to just you and i building features together."* The map did its job — the architecture is decided and recorded — and the cost of continuing to run every question through it exceeded its value once the decisions were made. The refactor still benefits from the pump's review loop because it is large, mechanical, and dangerous to get wrong; feature work does not.

## Pump agents run on Opus, not Fable, unless the work is genuinely critical
- **WHEN:** 2026-09-12
- **PROJECT:** map-editor
- **SYSTEM:** cross-system
- **SCOPE:** minor/local
- **WHAT:** Adversarial review and known-hard builds run on Opus; ordinary builds, the merge train, fixes, lessons and retro on Sonnet; the light lane on Haiku. Fable is reserved for work the owner judges critical — the actor migration was; nothing after it is by default.
- **WHY:** The owner's words: *"maybe stick to opus instead of fable unless it's really critical."* Credit control: the review tier is the quality bar and needs a strong model, but the top tier on every review across every wave is spend the outcome does not need.


## App frame: rail of subjects, Select first, per-tool context bar
- **WHEN:** 2026-09-12
- **PROJECT:** map-editor
- **SYSTEM:** editor-ui
- **SCOPE:** architectural
- **WHAT:** The frame is: a left rail of *subject* tools (Select, Terrain, Objects, Buildings, Fences; Level settings behind a gear at the bottom); a context bar showing the active tool's mode switch first, then its verbs with keys, then parameters, with each tool remembering its own settings; a stacked collapsible inspector; a status bar of hints. Select is the first tool and Esc returns to it; it is one polymorphic tool over voxel regions and objects (shape: marquee/lasso/brush; combine: replace/add/subtract; region verbs: move, expand, contract, invert). Camera is gestures in every tool, not a rail item. New terrain types, object kinds and styles are entries in the level's library, added from each subject's inspector section, not verbs. A slicer-style layer-view range (upper and lower bound) sits on the right edge of the viewport. Keys are a default preset in the keymap; other conventions are alternate binding lists.
- **WHY:** Voxel regions are an underlying concept, so selection must be a region editor (expand, contract, move), not a click-an-object affordance. Subject tools match the brief's firm requirement for curated, named tools and the conventions of every reference art app the artist already knows; mode-first context bars keep each subject's verbs discoverable. Art apps differ in shortcuts, so the layout is a preset and the door stays open for Blender-like/Aseprite-like sets. The layer view lets the artist dial in on a single height the way slicers do. Mockup: `docs/design/select-first.html`.

## Tool and verb buttons are icon-only; label and key live in the tooltip
- **WHEN:** 2026-09-12
- **PROJECT:** map-editor
- **SYSTEM:** editor-ui
- **SCOPE:** moderate
- **WHAT:** Every button in the rail and the bars is icon-only by default — tools, verbs, top-bar actions, mode switches, shape and combine rules, and library chips (materials, catalog entries, styles). The label and the keyboard shortcut are shown in a tooltip on hover or focus, never inline. Only readouts (a size) and menus that display a chosen value (a keymap preset) keep words. A preference ("Icons only" / "Icons + labels") turns inline labels on for those who want them; the default stays icon-only. (Amended the same day: the first draft exempted modes and chips; the owner's instruction was all of them.)
- **WHY:** Icon-only bars keep the context bar dense enough that a tool's whole verb set fits without scrolling, matching the convention of the art apps the artist already uses; the tooltip carries the discoverability (name + key) without spending bar width on it.

## UI overhaul first; selection and viewport plumbing follow it
- **WHEN:** 2026-09-12
- **PROJECT:** map-editor
- **SYSTEM:** editor-ui
- **SCOPE:** moderate
- **WHAT:** Build the new frame (rail, context bar, stacked inspector, status hints, layer-view slider) first, on top of PR #96 and against the host as it stands: Select drives the existing object tool, region verbs are greyed by `when` predicates, the layer slider ships as UI. Typed region selection on the view actor and the viewport's height clipping come after the frame is up. Buildings and Fences are dotted rail items without bars until their features exist.
- **WHY:** The frame needs almost nothing the host lacks — it is layout over existing tool and view state — so building it first gives visible progress and makes the plumbing gaps concrete before they are designed.

## The map needs real voxel data, not only a heightmap
- **WHEN:** 2026-09-12
- **PROJECT:** map-editor
- **SYSTEM:** document
- **SCOPE:** architectural (future)
- **WHAT:** The terrain today is a heightmap of columns (`TerrainData.height` in half-tiles, one value per cell). The document must eventually hold actual voxel data — occupancy per cell per layer — so that overhangs, caves, the brief's Blocks fallback and true 3D region selection are representable. Not scheduled; recorded so the frame and selection work do not bake the heightmap assumption in deeper than necessary.
- **WHY:** Voxel regions are an underlying concept of the editor and a heightmap cannot represent them; the layer view and region selection are designed against voxels, and the document should catch up rather than the UI regress to columns.

## The visual tour runs by hand, not on every PR
- **WHEN:** 2026-09-12
- **PROJECT:** map-editor
- **SYSTEM:** ci
- **SCOPE:** moderate
- **WHAT:** The `visual` job (Chromium install + `pnpm tour`, screenshots as an artifact) leaves `gate.yml` for its own `visual.yml` on `workflow_dispatch` only — `gh workflow run visual.yml --ref <branch>` when a rendering change warrants it. The per-PR path is the `gate` job alone (build, bundle-size, test, typecheck, lint; ~1 minute). `gate` stays the one required check; `strict` (branch must be up to date) stays on for now.
- **WHY:** The tour took ~4 minutes to the gate's ~1 and was never a required check, so it only ever added wall-clock to every PR without gating anything; right now that wait is an impediment to iterating on the UI, and a human looking at the running editor catches what the tour was for.

## Select tool: snapping, modifiers, nudge, framing, context menu
- **WHEN:** 2026-09-12
- **PROJECT:** map-editor
- **SYSTEM:** editor-ui
- **SCOPE:** moderate
- **WHAT:** Dragging an object snaps by default (grid; half/free as the Objects bar offers), with a modifier key temporarily disabling snapping. Modifier keys constrain a drag (e.g. to one axis). With an object selected, the arrow keys nudge it one grid cell. Dropping an object into water is allowed for now (a setting may prevent it later). Framing an object is a viewport operation, not tied to double-click (binding undecided). Selection gets a context menu; cut/copy/paste work on it.
- **WHY:** Continuous placement without snapping does not fit a grid-based level; the modifier conventions (constrain, snap-off, nudge) are what every reference art app trains, so they cost nothing to learn.

## Water is a heightmap bound to the terrain; terrain sculpted to the water's height clears it
- **WHEN:** 2026-09-12
- **PROJECT:** map-editor
- **SYSTEM:** document
- **SCOPE:** architectural
- **WHAT:** Water cannot exist at the same height as the terrain under it. Raising or flattening a cell to or above its water level clears the water in the same edit; setting water at or below terrain height does nothing. Unlike the terrain, which is to become voxel data (#100), water stays a per-cell height.
- **WHY:** Water is a surface, not volume: it is exactly what a heightmap represents, and a cell that is both land and water at one height is not a state the renderer or the game can mean anything by.

## Sculpt strokes apply on a cell boundary crossing with hysteresis
- **WHEN:** 2026-09-12
- **PROJECT:** map-editor
- **SYSTEM:** feature-terrain
- **SCOPE:** minor/local
- **STATUS:** tentative
- **WHAT:** A sculpt stroke applies once per cell, when the pointer has fully passed from one cell into the next, decided from the pointer's position on the press plane rather than from the picked surface, with a dead zone past the boundary. The dead zone's size is dialed in by feel on a prototype and then fixed.
- **WHY:** Applying on every change of the picked surface re-triggers off the geometry the stroke just raised and chatters along edges; the artist wants a stroke that lands where the brush clearly is.
