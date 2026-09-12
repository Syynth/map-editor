# Scope reconciliation — three restructure waves, 97 items

Every `scopeNote` and `scopeGap` the build and review agents emitted, deduplicated and sorted.
Numbers in brackets are item ids in the raw extract. Per the wayfinder-feed rule: a discovered
**decision** goes to the map; merely **unbuilt** work becomes an ordinary issue.

## A. Decisions → the map (proposed as new tickets unless marked fog)

| # | Question | Why it is a decision, not a task | Sources |
|---|---|---|---|
| A1 | **What crosses the texture boundary** — the canvas-free path (raw RGBA + dimensions) that lets `textures.ts` leave `runtime` for `fixtures`, and lets a headless exporter exist again | #3 costed it as "real work" and parked it; it now gates two things (fixtures completion, CLI revival) and changes `RuntimeScene`/`exportGltf`'s public shape | 45, 51, 52, 46, 83, 85 |
| A2 | **Build emit and project references** — every package exports `./src/index.ts`; nothing emits; `composite` forbids `noEmit`, so `references` are absent everywhere and `^build` in turbo is a no-op edge | Deciding once for the whole tree, not per package; it is the Phase 2 "build emit (tsup/unbuild)" item that was never decided | 36, 38, 89.4, 97.2 |
| A3 | **Each package's public surface** — barrels republish 105/105 (document), all (geometry, runtime); 36 document symbols have no consumer; the narrowable set is the patch/undo machinery `EditorStore` exists to hide | #3 assigns document's narrowing to the document-actor work; needs a house rule on barrel width so it happens once | 32, 41, 47, 45.2 |
| A4 | **Where a feature sits on the ladder** — `feature-terrain` is deliberately unplaced because #3 does not settle above-or-below `editor-host`; the ladder currently has no rung for features at all | First real question of the extensibility deliverable your ruling endorsed; `ui`'s `visibleTo` set is decided at the same time (#12 fixes half) | 89.1, 92, 97.3, 94.1 |
| A5 | **Where `sheet.ts` lands** — 91 lines, the DOM-decode edge for a user PNG; #3 says `ui` or `viewport`, unsettled; tied to A1 | Explicitly left open by #3; blocks the editor-host split | 37.2, 69 |
| A6 | **React hooks linting** — `eslint-plugin-react-hooks` was never installed; three `exhaustive-deps` suppressions were removed, so those sites are now *unchecked* rather than checked-and-suppressed; under `noInlineConfig` adding the plugin means restructuring each site | A real rule-set decision #20 did not consider | 23.2, 24 |
| A7 | **Test exemption breadth** — the ESLint task read your amendment narrowly (house rules only; typescript-eslint recommended still runs on tests) and had to add an `OnDisk` helper to a test to satisfy it. Your rationale ("a test that must violate a rule has no recourse") is rule-agnostic | One-line clarification of a ruling you already made | 23.3 |
| A8 | **Supply-chain policy** — `minimumReleaseAgeStrict` is off, so a too-new resolve silently appends an exemption to a tracked file; and a warm `lockfile-verified` cache lets CI pass what a cold runner rejects | Belongs with the CI decision; cheap now, invisible later | 10, 15.1 |
| A9 | **Per-package test/lint tasks vs root-only** — every package's tests run under the root vitest process and root config; `viewport`/`ui` have no test task at all | Fog: revisit when `apps/editor` stops being the root's whole job — which it just did | 33, 43, 70 |

## B. Build-ready → ordinary issues

| # | Work | Sources |
|---|---|---|
| B1 | **CI**: GitHub Actions running `pnpm gate:full` on a fresh clone; branch protection; `engines` field. The dist/lint interaction would have been caught on the second task, not the fourth — CI, branch protection, and the wrong-Node-version guard are all **done** (#25, #55): the guard landed as `devEngines.runtime` in root `package.json`, not the `engines` field alone — `engineStrict` on `engines` only gates a dependency's own declared engines, never this workspace's. Reconciled 2026-09-11 (#78): `gate.yml` never actually runs `gate:full` — it runs `turbo run build check-bundle-size` as its own step, then `pnpm gate` (`test typecheck lint`), so the runner's own step ordering — not turbo's task graph — forces `dist/` to finish before lint runs against it | 3, 22, 75, 2.1 |
| B2 | **Make `tour`/`probe`/`screenshot` portable** — all three hardcode `/opt/pw-browsers/chromium-1194/...` and force SwiftShader; Playwright 1.63 wants chromium-1243. Prerequisite for the pump's drive-it gate. Note `window.__viewport` is an unlinted, untypechecked consumer of `Viewport`'s `*ForProbe` surface | 2.5, 64, 71, 81 |
| B3 | **Sixth direction-test assertion**: the root declares no runtime library — otherwise re-adding `three` to the root re-hoists it and silently reopens the defect wave 2b closed | 90 |
| B4 | **`exports` integrity assertion**: nothing asserts a package's `exports` map stays narrow (a `./src/*` wildcard would let `writer` leak) — #20's second pnpm gap | 89.2 |
| B5 | **Test `exportGltf`, then re-enable the two rules disabled for `export.ts`** (`require-await`, `prefer-promise-reject-errors`); it has no test and is reachable only from the editor | 23.1, 28, 56.3 |
| B6 | **`xstate` is no longer installed anywhere** — the #15 pin survives only in a dead `minimumReleaseAgeExclude` string. Re-pin in `packages/document` when the document actor lands; drop the two stale exclusions once aged | 71, 73, 11, 29.4 |
| B7 | **Bundle**: 902 kB single chunk; Vite 8 moved the knob to `rolldownOptions.output.codeSplitting` | 2.2, 9, 97.4 |
| B8 | **Small ESLint follow-ups**: the `src/**` browser-globals block now matches nothing; root tsconfig `include: ["scripts"]` is inert without `allowJs` | 49, 68, 74 |
| B9 | **`packages/ui`**: react/react-dom as `peerDependencies`; README should mention `ui` is off the ladder with a visibility list | 63, 96 |
| B10 | **Trivia**: bench header still says `src/core/document.ts`; `packageManager` lacks its sha512; pnpm "update available" nag is a deliberate pin | 37.3, 40, 14, 9 |

## C. Closed by the waves, or superseded — no action

- `check-boundaries.mjs` vacuous (items 31.5, 44, 51, 54, 59, 66, 72, 84) — **deleted**, replaced.
- Root `node_modules` hoisting leak (31.2, 53, 58, 65) — **closed** in wave 2b, verified by break-test.
- `MAP-EDITOR-CONFIG.md` stale npm/gate lines (13, 93, 97.5) — **fixed** today.
- Phase 1/2 checkboxes unticked (12, 16, 35, 42, 55) — **ticked** by task 5; Phase 1 boxes still need a sweep (B10-adjacent, trivial).
- Decision-log names `packages/core` (56.1) — **pointer added** today.
- Mantine conversion and `styles.css` entanglement (57, 60, 61) — this is #12's *implementation*, not new scope.
- `viewport-contrib` absent (64, 67) — correct per #3; lands with the first overlay (A4 territory).
- Headless-DOM `onerror` / `installHeadlessDom` guard / unreferenced `index.ts` (86, 87, 88) — **moot**, CLI cut.
- Toolchain deps installed-but-unused (29.1), `lint` leg wiring (18) — resolved by later tasks in the same wave.
- Everything agents said about their own worktree discipline (76, 82, 94, 97.7) — process, not scope.

## Recommendation on order

CI (B1) first — the whole pump runs on a local-only gate. Then A1 and A4 are the two decisions that unblock the most: A1 completes `fixtures` and revives export; A4 is the first question of the deliverable you just endorsed. A7 and A8 are five-minute rulings. B3 and B4 are an afternoon and make two closed defects permanent.


## Filed 2026-09-11

Decisions (map tickets, children of #2): A1 → #32, A2 → #33, A3 → #34, A4 → #35, A5 → #36, A6 → #37, A7 → #38, A8 → #39; A9 → fog on the map.

Build-ready (`build-ready` label): B1 → #25, B2 → #26, B34 → #27, B58 → #28, B7 → #29, B910 → #30; B6 → #31 (blocked on #13, not pumped).
