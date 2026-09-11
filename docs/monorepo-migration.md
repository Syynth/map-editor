# Monorepo migration

The working checklist for taking the prototype to a maintained multi-package
repository. Decisions behind it are in [`decision-log.md`](decision-log.md);
this file is the task list, not the rationale. Technology choices live in
[`stack.md`](stack.md).

Target layout:

```
packages/core      document, commands, undo, meshers, ops   (no three, no react)
packages/runtime   three.js reference runtime               (private, built as if publishable)
packages/exporter  glTF writer + headless CLI
apps/editor        the React/Vite editor
apps/desktop       Electron or Tauri shell                  (slot reserved, not built)
```

`core <- runtime <- editor` is enforced by pnpm's strict `node_modules` once the
split lands: core cannot import three.js if it is not a declared dependency.

---

## Phase 0 — Land the prototype

- [x] Merge `prototype` into `main`. Tag the merge `prototype-v0` so the
      pre-restructure state stays referenceable.
- [x] Convert the open items in `FINDINGS.md` into issues. It is a prototype
      log, not a living document.
- [x] Migrate the "decisions taken up front" table from `PLAN.md` into
      `decision-log.md`, then retire `PLAN.md`.

## Phase 1 — Workspace skeleton

- [ ] Switch to pnpm: delete `package-lock.json`, add `pnpm-workspace.yaml`,
      set the `packageManager` field.
- [ ] Add `.nvmrc` — development is on Node 26, CI will default to something else.
- [ ] Add Turborepo with a `turbo.json` pipeline covering `build`, `test`,
      `typecheck`, `lint`.
- [ ] Confirm `pnpm test` still passes before moving a single file.

## Phase 2 — Extract packages, leaves first

Extract bottom-up and run the suite after each step, so a break is attributable
to one move rather than to the whole restructure.

- [ ] **`packages/core`** — no dependencies, so it moves cleanly. Needs a real
      `index.ts`: there are currently no barrel files anywhere and every import
      reaches into a file path.
- [ ] **`packages/runtime`** — depends on core. Same barrel work.
- [ ] **`packages/exporter`** — split `src/runtime/export.ts` (301 lines) out of
      the runtime. The CLI must produce a `.glb` with no WebGL context, which is
      the forcing function the boundary script always named.
- [ ] **`apps/editor`** — moves last; it may import anything.
- [ ] Replace the `@core` / `@runtime` / `@editor` path aliases with workspace
      package names. They are currently declared twice, in `tsconfig.json` and
      `vite.config.ts`, and drift silently.
- [ ] Per-package `tsconfig.json` with project references; the root config
      currently covers everything with `noEmit: true`.
- [ ] Build emit (tsup or unbuild) for `core`, `runtime`, `exporter`. Nothing
      emits today, so `runtime` is not consumable by anyone.
- [ ] **Delete `scripts/check-boundaries.mjs`.** Its header has always said to.

## Phase 3 — Development practices

- [ ] ESLint (flat config) + Prettier, configured once against the final layout.
- [ ] A rule for the stale-memo trap: the store mutates the document in place
      behind a revision counter, so any `useMemo`/`useEffect` keyed on `doc`
      never recomputes. This already shipped one bug (the frozen coverage
      readout). Prefer a `useRevision()` hook that makes the correct thing the
      easy thing, with a lint rule as backstop.
- [ ] GitHub Actions: typecheck, lint, test, build on every PR.
- [ ] Branch protection on `main` once CI is green.
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
- [ ] **Prerequisite:** make `tour.mjs` and `probe.mjs` portable. Both hardcode
      `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` and force
      `--use-angle=swiftshader`. They should resolve Playwright's own browser
      and take a `--gpu` flag.
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
