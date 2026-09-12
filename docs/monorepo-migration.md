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
packages/viewport-contrib  what a feature may import to contribute an overlay.
packages/editor-host       root actor, dispatch wiring, tool/stroke framework, files, play, feature folders.
packages/feature-terrain   the one extracted feature, proving the import surface is sufficient.
packages/fixtures          procedural texture generation + the sample map. Dev-only, but NOT lint-exempt.
apps/editor                index.html, Vite config, mount, composition root, features/index.ts.
apps/export-cli            headless glTF exporter. CUT 2026-09-11 — needed a native canvas;
                           returns once export has a canvas-free texture path.
```

Direction: `registry <- document <- geometry <- runtime <- viewport <- editor-host`, with
`ui` and `viewport-contrib` hanging off the side. `ui` has a restricted `visibleTo` set:
it is visible only to apps (currently `editor`) and to the planned `editor-host` package, and
it may depend only on `registry` — the React+Mantine package is the editor's design vocabulary,
not the runtime's. This constraint is asserted by the dependency direction test.

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
- [ ] Per-package `tsconfig.json` with project references; the root config currently
      covers everything with `noEmit: true`. Half done: every package has its own
      `tsconfig.json`, but none carries `references`, because a referenced project must
      be `composite` and `composite` forbids `noEmit`. Taking the references means
      deciding build emit first — the next box.
- [ ] Build emit (tsup or unbuild) where a package needs to be consumable.
- [ ] `apps/export-cli` must produce a `.glb` with **no WebGL context** — *built, then cut:
      it needed `@napi-rs/canvas`, a native binary, because both `textures.ts` and three's
      GLTFExporter draw through a 2D canvas. Revive after the canvas-free texture path.* — the forcing
      function the boundary script always named.
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
- [ ] A rule for the stale-memo trap: the store mutates the document in place
      behind a revision counter, so any `useMemo`/`useEffect` keyed on `doc`
      never recomputes. This already shipped one bug (the frozen coverage
      readout). Prefer a `useRevision()` hook that makes the correct thing the
      easy thing, with a lint rule as backstop.
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

- [ ] **`src/editor` is the biggest layer (~2,640 lines) and has zero tests.**
      All 53 tests live in core and runtime.
- [ ] Put `scripts/tour.mjs` in CI as a smoke test. Both rendering bugs in
      `FINDINGS.md` were found by looking at screenshots, and the unit tests
      passed throughout — they checked buffer lengths, not whether the UVs
      described a rectangle.
- [x] ~~**Prerequisite:** make `tour.mjs` and `probe.mjs` portable.~~ —
      [#26](https://github.com/Syynth/map-editor/issues/26): both resolve
      Playwright's own bundled Chromium now (`CHROMIUM_PATH` stays as an
      override) and take a shared `--gpu` flag; see
      `scripts/chromium-launch.mjs`.
- [ ] Decide where screenshot baselines live; `shots/` is gitignored today.
- [ ] Break up `viewport.ts` (770), `panels.tsx` (749) and `App.tsx` (533) as
      tests arrive.

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
