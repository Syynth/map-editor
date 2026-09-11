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
    ignores: ['dist/**', '.turbo/**', '.claude/**'],
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
    files: ['packages/runtime/src/export.ts'],
    // The two rules from `recommendedTypeChecked` that the existing code does
    // not satisfy, and whose fixes are API-shape decisions rather than
    // mechanical ones. Both land on `exportGltf`/`buildExportScene` in
    // `packages/runtime/src/export.ts`, which has no test covering it — so "make the
    // linter happy" would mean reshaping untested exported surface inside a
    // toolchain commit. Turned on by whoever owns that call, with a test.
    rules: {
      // `buildExportScene` is declared `async` and never awaits. Dropping
      // `async` changes its exported return type; keeping it may be deliberate
      // headroom for image decoding. Not this commit's call.
      '@typescript-eslint/require-await': 'off',
      // The glTF exporter's error callback is rejected verbatim. Wrapping it in
      // an `Error` changes what the one caller catches, unobserved by any test.
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
    },
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

  { files: ['src/**'], languageOptions: { globals: globals.browser } },
  {
    files: ['*.config.{ts,js}', 'eslint.config.js'],
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
