# Monorepo migration

The working checklist for taking the prototype to a maintained multi-package
repository. Decisions behind it are in [`decision-log.md`](decision-log.md);
this file is the task list, not the rationale. Technology choices live in
[`stack.md`](stack.md).

**The decisions behind this file now live on the wayfinder map,
[#2](https://github.com/Syynth/map-editor/issues/2), and its closed tickets. Where this
file and a ticket disagree, the ticket wins.**

Target layout, decided by [#3](https://github.com/Syynth/map-editor/issues/3). This
replaces the original five-package sketch; **`core` no longer exists as a name**, having
held three unrelated things and named none of them.

```
packages/registry          declarations + handlers, predicate DSL, keymap. Zero runtime deps.
packages/document          map data, verbs, patches, Edit/undo, io. Owns the document actor.
packages/geometry          mesher + sheet layout.
packages/runtime           three.js reference runtime; glTF export as a subpath.
packages/ui                the editor's design vocabulary; Mantine is an implementation detail of it.
packages/viewport          editor GL shell: renderer, post-processing, overlays, pointer input, rAF loop.
packages/viewport-contrib  editor GL overlay-contribution surface; rank 3 alongside
                           `runtime` (#49), not a feature-only package — one of six things
                           a feature may import (#35), same as `registry` or `ui`.
packages/editor-host       root actor, dispatch wiring, tool/stroke framework, files, play, feature folders.
packages/feature-terrain   the one extracted feature, proving the import surface is sufficient.
packages/fixtures          procedural texture generation (returns raw RGBA; the sample map's
                           output is also checked in under baked/ as PNG) + the sample map.
                           Dev-only, but NOT lint-exempt.
apps/editor                index.html, Vite config, mount, composition root, features/index.ts.
apps/export-cli            headless glTF exporter. Cut 2026-09-11 for a native canvas
                           dependency, revived by #48 once #47 made the texture path
                           canvas-free and this app supplied a `FileReader` bridge for
                           three's own GLB assembly (see the checklist below).
```

Direction: `registry <- document <- geometry <- runtime <- viewport <- editor-host`, with
`ui` hanging off the side and `viewport-contrib` a real rung — rank 3, alongside `runtime`,
not off to the side (#49) — and feature packages (`feature-terrain`) sitting beside
`editor-host` rather than on the ladder itself (#49). A feature may depend
only on `registry`, `document`, `geometry`, `runtime`, `ui`, or `viewport-contrib`; the host
and a feature never import each other, and only an app composes them together. `ui` has a
restricted `visibleTo` set: it is visible only to apps (currently `editor`), the
`editor-host` package, and feature packages, and it may depend only on `registry` — the
React+Mantine package is the editor's design vocabulary, not the runtime's. This constraint
is asserted by the dependency direction test.

The rule that produced it: **a package exists when there is a consumer that must not be
able to reach past it — not when there is a topic.** `exporter` and `schema` were both
candidates and both failed that test.

Note [#20](https://github.com/Syynth/map-editor/issues/20)'s correction: pnpm's strict
`node_modules` blocks *undeclared* imports but does **not** enforce direction, so the
dependency direction needs a test as well as the workspace structure.

---

## Phase 0 — Land the prototype

- [x] Merge `prototype` into `main`. Tag the merge `prototype-v0` so the
      pre-restructure state stays referenceable.
- [x] Convert the open items in `FINDINGS.md` into issues. It is a prototype
      log, not a living document.
- [x] Migrate the "decisions taken up front" table from `PLAN.md` into
      `decision-log.md`, then retire `PLAN.md`.

## Phase 1 — Workspace skeleton

Blocked on [#24](https://github.com/Syynth/map-editor/issues/24), which brings the
toolchain to the baseline this phase installs against — React 19, Vite 8, Vitest 5,
TypeScript 6.0.3, plus ESLint, XState and Mantine. React 18 → 19 across 2,640 untested
lines of `src/editor` is the real risk there, not the version numbers.

- [x] Switch to pnpm: delete `package-lock.json`, add `pnpm-workspace.yaml`,
      set the `packageManager` field.
- [x] Add `.nvmrc` — development is on Node 26, CI will default to something else.
- [x] Add Turborepo with a `turbo.json` pipeline covering `build`, `test`,
      `typecheck`, `lint`.
- [x] **Install ESLint 10 + typescript-eslint 8 here, not in Phase 3.**
      [#20](https://github.com/Syynth/map-editor/issues/20) decided this deliberately, so
      the checks land *with* the code rather than being retrofitted onto it. Flat config,
      type-aware, custom rules in their own workspace package, `noInlineConfig: true`.
      Test files and `scripts/` are scoped out by `files:` globs; `packages/fixtures` is
      not.
- [x] Confirm `pnpm test` still passes before moving a single file.

## Phase 2 — Extract packages, leaves first

Extract bottom-up and run the suite after each step, so a break is attributable to one
move rather than to the whole restructure. Order follows the dependency direction above:
`registry` and `document` first, `apps/*` last.

- [x] Every package needs a real `index.ts`. There are no barrel files anywhere today and
      every import reaches into a file path.
- [x] Replace the `@core` / `@runtime` / `@editor` path aliases with workspace package
      names. They are declared twice — in `tsconfig.json` and `vite.config.ts` — and drift
      silently.
- [x] ~~Per-package `tsconfig.json` with project references; the root config currently
      covers everything with `noEmit: true`.~~ — [#46](https://github.com/Syynth/map-editor/issues/46),
      implementing [#33](https://github.com/Syynth/map-editor/issues/33). Every `packages/*`
      config is `composite` and emits; each carries `references` to its workspace
      dependencies; the root `tsconfig.json` is a solution file referencing all ten, so
      `tsc -b` builds the graph in one command. See "How a package is built" below.
- [x] ~~Build emit (tsup or unbuild) where a package needs to be consumable.~~ —
      [#46](https://github.com/Syynth/map-editor/issues/46): **tsup**, applied uniformly.

### How a package is built (#46)

Two commands per package, one for each half of `dist/`:

```
tsup --config ../../tsup.config.ts   # dist/*.js  (ESM, sourcemapped)
tsc  -p tsconfig.json                # dist/*.d.ts (+ .d.ts.map, .tsbuildinfo)
```

**Why tsc owns the declarations.** `composite: true` is what makes `references` legal at
all, and `composite` forces `declaration` emit. Letting the bundler generate a second,
independently-derived set of `.d.ts` next to tsc's would be two sources of truth for the
same file, so tsup runs with `dts: false` and tsc with `emitDeclarationOnly`.

**Why a bundler owns the JS.** This repo's source uses extensionless relative specifiers
(`./billboard`), which Node's ESM resolver does not resolve — the same fact that already
forces `apps/export-cli` to bundle (see its `vite.config.ts`). tsc's emit preserves the
specifier verbatim, so a tsc-emitted `dist/index.js` would be unloadable by the very
consumer "built as if publishable" is about.

**Why tsup and not unbuild.** With declarations already owned by tsc, the job left is
"transpile and bundle ESM, externalising declared dependencies". tsup is a thin wrapper
over esbuild that does exactly that. unbuild's distinguishing features are mkdist and its
own `rollup-plugin-dts` declaration pipeline — the second being precisely the duplicated
source of truth this split exists to avoid. Cost paid: tsup brings `esbuild`, whose
`postinstall` is declined explicitly in `pnpm-workspace.yaml` (`allowBuilds`), because the
platform binary arrives as a real optional dependency and the script has nothing to do.

**One config, not ten.** `tsup.config.ts` lives at the repo root and derives each
package's entry list from that package's own `exports` map, so a new subpath export cannot
forget to add an entry and no package can drift to a different `format` or `target`. It is
listed in `turbo.json`'s `globalDependencies` for the same reason
`scripts/check-bundle-size.mjs` is: it is an input to ten `build` tasks and lives in none
of their packages. Verified — with the entry removed, editing the file still replays a
cache hit on all twelve tasks; with it listed, the same edit misses on all twelve.

**Two tsconfigs per package.** `tsconfig.json` is the BUILD config: `composite`, emitting,
`references` to its dependencies, and excluding `*.test.ts` — a test is not part of the
published surface, and `fixtures`' own test reaches `../baked/manifest.json`, outside
`rootDir`. `tsconfig.typecheck.json` is the CHECKING config: `noEmit`, tests included, and
deliberately **no** `references`, so it resolves `@map-editor/*` through the `exports`
map's `types` condition and reads the declarations that were really emitted.

### What consumers resolve (#46)

`exports` points at built output, with a `development` condition for source:

```json
"." : {
  "development": "./src/index.ts",
  "types": "./dist/index.d.ts",
  "default": "./dist/index.js"
}
```

- **Vite's dev server and vitest** resolve `development` and get source, so iteration
  never requires a build. Vite's default `resolve.conditions` carries the
  `development|production` token, which is what selects it. Verified: renaming the
  condition key breaks the whole suite's resolution of that package.
- **`vite build`** (both apps) resolves `production`, misses, and falls through to
  `default` — so the editor's production bundle and `apps/export-cli/dist/cli.js` are
  assembled from `packages/*/dist/*.js`. This is what makes turbo's
  `build -> ^build` edge load-bearing: with a dependency unbuilt, the app build fails with
  `Rolldown failed to resolve import "@map-editor/document"`.
- **`tsc`** resolves `types`. A batch `tsc -p` does *not* apply the project-reference
  source redirect, so every `typecheck` task reads real `.d.ts` and reports `TS2307` the
  moment a dependency's `dist/` is missing — `typecheck -> ^build` is load-bearing too.
  The language service *does* apply the redirect, which is why `pnpm lint`
  (typescript-eslint drives the project service) and an editor still work in a checkout
  that has never been built.
- **`packages/eslint-rules` is the one exception**: its `exports` stays on source. It is
  tooling, off the ladder, and `eslint.config.js` imports it through Node's type stripping
  (`erasableSyntaxOnly`) before anything in the repo has been built — an entry point that
  pointed at `dist/` would make `pnpm lint` depend on a build. It is still `composite` and
  still emits, so `tsc -b` and the root solution cover it like everything else.
- **`apps/*` are not referenced by the root solution.** Being referenced requires
  `composite`, which requires emitting declarations into the same `dist/` each app's own
  bundler empties — and nothing imports an app, so there is no declaration surface to
  publish. Their own configs still carry `references`.

**Per-package `test` tasks stay unbuilt (A9 fog, revisited and left as fog).** Now that
every package builds, a per-package `test` task is *possible*; it is not cheap. The whole
suite is one root `vitest run` whose 25 s budget (#10) is measured by a `globalSetup`
teardown across the single process — twelve vitest processes would lose that measurement
and add twelve startups to a suite that finishes in ~1.3 s. Revisit if a package ever
needs an environment (`jsdom`, say) the root run does not give it.
- [x] `apps/export-cli` produces a `.glb` with **no WebGL context** — *built, then cut:
      it needed `@napi-rs/canvas`, a native binary, because both `textures.ts` and three's
      GLTFExporter draw through a 2D canvas; revived by #48.* The texture half was #47:
      `runtime` compiles without `DOM`, takes its sheet and sprites as raw RGBA, and
      `exportGltf` encodes its embedded PNGs through a caller-supplied `encodePng`
      (`fast-png`, pure JS), so three's canvas never runs. What remained was three's own
      GLB assembly: `GLTFWriter.writeAsync` (three 0.186.0, `GLTFExporter.js`: `new Blob`
      at line 679, `new FileReader()` at 697 and 731) concatenates its buffers with `Blob`
      + `FileReader`, and Node has no `FileReader` — a gap `apps/export-cli/src/node-file-reader.ts`
      bridges with one `readAsArrayBuffer` method over `Blob.arrayBuffer()`, a method Node
      already implements. Not the 2D-canvas shim the 2026-09-11 ruling argues against: it
      draws nothing and interprets no pixel, only reshapes an async result three already
      has a real, correct implementation of into the older callback shape it asks for.
- [x] A test enforcing dependency direction, since pnpm does not.
      `tests/dependency-direction.test.ts`: it reads every workspace `package.json`,
      checks each declared arrow against the ladder above, checks the graph is
      acyclic, keeps runtime libraries (and their `@types/` twins) off the root
      so none can re-hoist into a package that never declared them, and keeps
      every package's `exports` map explicit so a declared entry point can't
      itself be a wildcard. A workspace package with no entry in its table fails,
      so a new package cannot be silently unchecked — which is the bug the
      deleted script had.
- [x] **Delete `scripts/check-boundaries.mjs`.** Its header has always said to, and
      [#20](https://github.com/Syynth/map-editor/issues/20) found it is regex-over-source
      and therefore blind to types. It had also started passing vacuously: it walked
      `src/{core,runtime,editor}`, which no longer exists, so it inspected zero files.

## Phase 3 — Development practices

- [x] ~~ESLint~~ — moved to Phase 1 by [#20](https://github.com/Syynth/map-editor/issues/20). Prettier still to decide.
- [x] ~~A rule for the stale-memo trap: the store mutates the document in place
      behind a revision counter, so any `useMemo`/`useEffect` keyed on `doc`
      never recomputes. This already shipped one bug (the frozen coverage
      readout).~~ — the hook came first and the lint rule turned out to be the
      stock one. `useDocument(selector)` in `editor-host` subscribes to the
      revision and re-selects on it, which is the "make the correct thing the
      easy thing" half; #66 step 7 moved every React read in the app onto it
      and turned `react-hooks/exhaustive-deps` on repo-wide, with no
      suppressions available (`noInlineConfig`), which is the backstop. The
      coverage readout is a `useDocument` selector now rather than a `useMemo`
      keyed on a counter.
- [x] ~~GitHub Actions: typecheck, lint, test, build on every PR.~~ —
      [#25](https://github.com/Syynth/map-editor/issues/25): `.github/workflows/gate.yml`,
      build ordered before lint so a fresh runner exercises the case that would actually
      catch a broken `dist/` ignore (see the workflow's header comment).
- [x] ~~Branch protection on `main` once CI is green.~~ — same PR: the `gate` check is
      required, `strict`, and applies to admins.
- [ ] husky + lint-staged for format and lint only — tests belong in CI.
- [ ] Issue and PR templates.

## Phase 4 — Testing

The largest gap, and not where it looks.

- [x] ~~**`src/editor` is the biggest layer (~2,640 lines) and has zero tests.**
      All 53 tests live in core and runtime.~~ — `apps/editor` carries three
      test files now: the keyboard dispatcher (`keys.test.ts`), the app's
      composition of host and feature (`features/features.test.ts` — the only
      place both halves are visible, #35), and the React glue under jsdom
      (`react-glue.test.tsx`). The panels and `App` themselves are still
      untested as components; what they now hold is wiring, since every control
      dispatches a declared command that is tested where it is handled.
- [x] ~~Put `scripts/tour.mjs` in CI as a smoke test.~~ — [#56](https://github.com/Syynth/map-editor/issues/56):
      `.github/workflows/visual.yml` installs Chromium and runs `pnpm tour`, which fails
      on a console error, a below-floor luminance reading (the black-frame signature from
      "Bloom renders black under software GL" below) or too few triangles, on top of its
      own scripted assertions. Screenshots upload as a workflow artifact on every run, pass
      or fail. Since 2026-09-12 it runs on `workflow_dispatch` only, not per PR — it took
      four minutes to the gate's one and was never a required check.
- [x] ~~**Prerequisite:** make `tour.mjs` and `probe.mjs` portable.~~ —
      [#26](https://github.com/Syynth/map-editor/issues/26): both resolve
      Playwright's own bundled Chromium now (`CHROMIUM_PATH` stays as an
      override) and take a shared `--gpu` flag; see
      `scripts/chromium-launch.mjs`.
- [x] ~~Decide where screenshot baselines live; `shots/` is gitignored today.~~ —
      [#60](https://github.com/Syynth/map-editor/issues/60): no pixel baselines for now
      (SwiftShader-vs-Metal and run-to-run GL noise would make tolerance tuning a
      treadmill without a stable GPU runner); CI asserts structural signals instead and
      keeps `shots/` gitignored, uploading it as a workflow artifact per run.
- [ ] Break up `viewport.ts` (831), `panels.tsx` (714) and `App.tsx` (565) as
      tests arrive. None of the three shrank much through the actor migration
      and that is expected: what left them was ownership, not lines — the
      state, the arbitration and the write path moved to actors, and the files
      kept the rendering, the GL and the wiring.

## Phase 5 — Debt carried from the prototype

- [ ] Narrow or remove the software-renderer post-processing detection. Bloom
      was confirmed working on an M2 via ANGLE/Metal, so the SwiftShader
      workaround now only needs to cover CI.
- [ ] Investigate the black canvas after a live viewport resize — observed once,
      not reproduced.
- [ ] Electron vs Tauri smoke test. Deliberately deferred, and there is now a
      heavy scene to test with.

## Deferred until there is an outside consumer

- Changesets, npm publishing, API documentation.
- Independent semver for the extras spec, which is the real public contract —
  "engine-agnostic" means other people implement it.
- Asset licensing check in CI. Placeholder art is generated procedurally today,
  which is what keeps the repo clean; a check would keep it that way.
