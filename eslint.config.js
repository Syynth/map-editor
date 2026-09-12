import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { plugin as houseRules } from '@map-editor/eslint-rules'

// Plain `.js`, not `.ts`: ESLint only reads a TypeScript config through `jiti`,
// and the config is the one file that must load before anything is configured.
// Issue #20 also names this path as the single place a rule can be turned off,
// which only holds if loading it cannot itself fail.

/**
 * Files that describe or drive the system from outside it, and are therefore
 * exempt from the house rules (issue #20's amendment). Benchmarks count as test
 * files here: vitest runs them, and a bench exists to measure the system rather
 * than to be part of it. `packages/fixtures` is deliberately absent — it
 * produces data the editor really loads, so its output has to satisfy the same
 * invariants as anything else.
 *
 * This is the whole exemption mechanism. There is no inline escape hatch — see
 * `linterOptions` below — so an exemption is always a glob in this file, which
 * a reviewer opens, rather than a comment scattered through source.
 */
const OUTSIDE_THE_SYSTEM = ['**/*.test.ts', '**/*.test.tsx', '**/*.bench.ts', 'scripts/**']

export default tseslint.config(
  {
    // `dist` and `.turbo` are build output. `.claude` holds vendored skills and
    // live agent worktrees — full checkouts of this repo, so linting it would
    // report every violation once per worktree.
    //
    // `**/` matters on the first two, for the same reason it does on the
    // `*.config.{ts,js}` glob below: a flat-config pattern with no leading `**/`
    // is anchored at the config's own directory, and build output now lands in
    // `apps/editor/dist` and `<pkg>/.turbo`, not at the root. Without it
    // `eslint .` lints the app's minified bundle — thousands of `no-undef`s —
    // but only on a machine that has built, which is why the gate can pass in a
    // fresh checkout and fail everywhere else. `.gitignore`'s `dist/` matches at
    // any depth (gitignore semantics differ), so `git status` stays clean and
    // hides it.
    ignores: ['**/dist/**', '**/.turbo/**', '.claude/**'],
  },

  {
    // No suppressions, anywhere, not even with a written reason (#20). An
    // escape hatch is a signal that a primitive is missing, and the fix is to
    // add the primitive. Verified to bite: an
    // `eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion`
    // placed over a violating line silences it with this off and is reported
    // anyway — plus a warning that the directive has no effect — with it on.
    linterOptions: { noInlineConfig: true },
  },

  js.configs.recommended,

  // Type-aware, which is the reason for choosing ESLint over Biome or oxlint at
  // all: the two rules this repo actually wants need a `ts.TypeChecker`.
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // `projectService`, never a `project` glob. A wide `**` glob on
        // `project` is the documented performance trap, and the service also
        // resolves each file against the nearest tsconfig, which is what lets
        // `packages/*` carry their own without listing them here.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    // Nothing in the repo compiles these, so there is no program to ask about
    // them and every type-aware rule would fail to parse rather than fail to
    // find a violation.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  {
    // The house rules — the register of machine-checked constraints. Empty
    // today: `enq` purity is #22 and no-styles-outside-`packages/ui` is #12,
    // and both are deliberately unimplemented here. The wiring lands now so
    // that the first rule is a rule file rather than a rule plus a migration.
    files: ['**/*.{ts,tsx}'],
    ignores: OUTSIDE_THE_SYSTEM,
    plugins: { 'map-editor': houseRules },
    rules: {},
  },

  // This block is not about `no-undef` — that's already off for every
  // `.ts`/`.tsx` file (see `eslint-recommended-raw` inside
  // `recommendedTypeChecked`), so deleting this block once looked inert. What
  // it actually buys is `no-global-assign`, from `js.configs.recommended`,
  // which reads `languageOptions.globals` directly and is untouched by that
  // `no-undef` shutoff — and `tsc` doesn't cover it either, since `window` and
  // `document` are ambient `declare var`s that happily accept a reassignment.
  // Verified on a probe: with this block absent, `window = undefined as never`
  // under `apps/editor/src` lints clean and type-checks clean; restoring the
  // block reports `no-global-assign`. Scoped to the packages that actually run
  // in a browser, not the whole repo, so a Node-only package keeps
  // `no-global-assign`'s real signal on its own globals instead of losing it
  // to a blanket `globals.browser`.
  { files: ['apps/editor/src/**', 'packages/{ui,viewport,runtime}/src/**'], languageOptions: { globals: globals.browser } },
  {
    // `**/` matters: a flat-config pattern with no slash matches only at the
    // config's own directory, and the app's Vite config now sits in
    // `apps/editor/`.
    files: ['**/*.config.{ts,js}', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // The Playwright drivers are Node scripts that also contain browser code:
    // every `page.evaluate` / `addInitScript` callback is serialised and run in
    // the page, so `window` and `document` are genuinely in scope there. Both
    // global sets, or `no-undef` fires on bodies that are correct.
    files: ['scripts/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
)
