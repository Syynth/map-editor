# map-editor pump configuration

Fill `pump.js`'s CONFIG from these. Replaces brink's `BRINK-CONFIG.md`; nothing in that
file applies here.

**Provenance.** `SKILL.md` and `pump.js` are copied verbatim from `~/code/rs/brink`
at `.claude/skills/autonomous-pump`, brink commit `0692a12` (2026-07-29). They are the
same author's work, not third-party — unlike the `mattpocock/skills` copies in this
directory, which have their own rules in [`../VENDORED.md`](../VENDORED.md). When brink's
version improves, re-copy rather than editing in place, and keep project-specific
material in *this* file so the re-copy stays clean.

## ⚠ Readiness: the pump is not usable yet

The restructure is done (branch `restructure`, twelve commits, verified in
[`docs/audit-2026-09-11.md`](../../../docs/audit-2026-09-11.md)), so the layout objection is
gone. One blocker remains, and it is the one Gate 0 is strictest about:

**There is no build-ready backlog.** Every open issue is a wayfinder decision ticket
(`needs-design` by definition), a question needing a human or a real GPU, or already done.
The three waves produced ~56 scope notes and gaps that live only in workflow journals.
**Scope reconciliation — turning those into triaged issues — is the prerequisite for the
first parallel wave**, and per the wayfinder-feed rule each item sorts into either a map
ticket (a decision) or an ordinary issue (merely unbuilt). That sorting is a human call.

## Gate

```
pnpm install --prefer-offline && pnpm turbo run test typecheck lint
```
Twelve turbo tasks across seven packages and two apps; 60 tests (53 pre-existing + a
5-test dependency-direction suite + 2 for `export-cli`). ~6 s cold, single-digit ms on a
cache hit — the gate is fast enough that agents should run it on every iteration.

CI (`.github/workflows/gate.yml`) runs a superset of this on every PR and every push to
`main`: it also builds `apps/editor` — the only package with a `build` script, and not
covered by the `test`/`typecheck`/`lint` tasks above, which depend only on `^build` — as
its own step *before* linting, in a fresh checkout with no pre-existing `dist/`. That
ordering is load-bearing, not incidental: see the workflow's header comment and
`eslint.config.js`'s `ignores` comment for the bug a lint-before-build job would never
catch. `pnpm gate` / `pnpm gate:full` in root `package.json` are the turbo-fronted entry
points CI and a local run both call, so the two do not drift into separate command lists.

`scripts/check-boundaries.mjs` is gone. `tests/dependency-direction.test.ts` replaces it:
it builds the workspace graph from declared dependencies, asserts the decided direction
and acyclicity, and **fails on an unplaced package**, so a new package cannot be silently
unchecked. pnpm's strict `node_modules` handles the other half — an undeclared import fails
to resolve (verified: `import 'three'` inside `packages/document` is TS2307).

`lint` is ESLint 10 + typescript-eslint 8, type-aware, `noInlineConfig: true`. Test files,
benchmarks and `scripts/` are scoped out; `packages/fixtures` is not. The custom-rules
package (`packages/eslint-rules`) is a wired-in **empty** skeleton until #22 and #12 land.

**CACHE prefix** (once Turborepo is installed):
```
export TURBO_CACHE_DIR=/tmp/pump-turbo-cache-map-editor
```
There is no Rust here, so the multi-gigabyte `target/` problem brink fought does not
apply. Peak disk is `node_modules` per worktree, which pnpm hard-links from its
content-addressable store — keep worktrees on the same volume and clone `node_modules`
with `cp -c -R` (APFS) as the `DISK` preamble already instructs.

## Repo

- **Repo:** `Syynth/map-editor` · **default branch:** `main` · **assignee:** `Syynth`
- **Trailer:** `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **PR footer:** `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
- **CI is live.** `.github/workflows/gate.yml` runs the gate above (plus a build) on every
  PR and push to `main`; branch protection on `main` requires the `gate` check, `strict`
  (up to date before merge), and applies to admins too (#25). The adversarial review step
  still carries the weight it always did — CI catches what the gate checks, not what a
  review does.

## Conventions (CONV)

TypeScript, ESM, single quotes, no semicolons, 2-space indent. Named exports; no default
exports. Comments explain *why*, not *what* — match the existing density, which is high
and load-bearing. Design tokens come from `packages/ui`'s token object, which generates
the Mantine theme; never invent a token or write a raw colour.

## House rules (RULES seed)

Unlike brink's, this seed is **not** empty — these are earned, most of them verified
empirically in this repo, and all of them are on the wayfinder map
([#2](https://github.com/Syynth/map-editor/issues/2)) as standing constraints.

- **Nothing writes the store in an XState transition body; every effect goes through
  `enq`.** A v6 transition body re-runs from the top the moment it calls any `enq` method,
  so statements above the first `enq` call run twice — and an inline effect fires even when
  the transition is not taken. Verified on `6.0.0-alpha.53`. On the document's single write
  path this is silent corruption: a `+3` raise moves a cell by 6, with no error.
- **Address child actors by `ActorRef`, never a string id.** Structural on v6 — `enq.sendTo`
  has no string form. Retain stale child refs rather than nulling them: a send to a stopped
  ref dead-letters and is observable, a send to `undefined` is a silent no-op.
- **Pass the document store by factory closure, never by `input`.** `input` rides on the
  `xstate.init` event and reaches the inspector even when kept out of context — measured at
  100,089 bytes versus 22.
- **Teardown is never in `exit`.** Exit actions do not run when an actor is stopped
  (xstate#4630, by design).
- **The document has one write path and one read path.** Only the actor holds the write
  handle; everyone else sees a deep-readonly view. Never put the document in machine
  context.
- **Command arguments are plain serialisable data addressing targets by stable id** — never
  object references, closures, or ambient selection.
- **No suppressions.** `noInlineConfig` is on. If you need an escape hatch, the primitive is
  missing — say so rather than working around it. Test files and `scripts/` are scoped out
  by config globs; `packages/fixtures` is **not**, because the sample map it generates is
  real data the editor loads.
- **A rule that matters is machine-checked, not documented.** Push each constraint to the
  cheapest bucket that holds it: structural → type-checked → workspace-structural →
  runtime-registration → test → lint → prose. Lint is the residue, not the destination.
- **Never state a number, `file:line`, or symbol you did not just read at the ref you are
  citing.** (Brink's rule, earned there, and it applies to any agent fleet.)
- **A regression test must FAIL without the fix.** Revert the production diff and watch it
  go red before committing.
- **Prove reachability, not just green tests.** Both rendering bugs this repo has ever had
  — degenerate UVs on terrain tops and a double colour-space conversion in the sky — were
  found by looking at screenshots while 53 unit tests passed. `pnpm tour` drives the app
  and captures a walkthrough; use it.
- **Never `git stash`** — all worktrees share one stash stack.

## Verification: how the human drives it

```
pnpm browsers                              # once, to fetch Playwright's matching Chromium
pnpm --filter @map-editor/editor dev      # http://localhost:5173
pnpm tour --gpu                            # 25-step guided walkthrough to shots/tour/
pnpm probe --gpu                           # whether post-processing survives on this GPU
```

`--gpu` is what makes the probe mean anything on this Mac: without it, both scripts force
SwiftShader for CI parity, so a software-renderer fallback firing is not a signal — it's
the default. `--gpu` requests the real backend (ANGLE/Metal here) so the probe reports
whether the fallback is happening for real.

## Reference material for Gate 0

Any feature mirroring an existing tool should study it first. The two primary sources
already in-repo, both from wayfinder research:

- [`docs/research/command-registries.md`](../../../docs/research/command-registries.md) —
  VS Code, Blender, Godot, Unity, Photoshop, Figma.
- [`docs/research/xstate-topology.md`](../../../docs/research/xstate-topology.md) —
  measured against xstate 5.32.6, because several documented answers were wrong.

The vision is [`level-editor-design-brief.md`](../../../level-editor-design-brief.md);
vocabulary is [`CONTEXT.md`](../../../CONTEXT.md) — note `Command` (an intent) versus
`Edit` (an undo entry).

## Ledger

Not set up. Brink uses a standing wave-ledger issue (`LEDGER`); mint one here before the
first wave if wave history is wanted.
