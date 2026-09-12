import { defineConfig, configDefaults } from 'vitest/config'

// No longer merged with the Vite config: that config moved to `apps/editor`
// along with the app. A test lives in a `packages/*` package, in a repo-root
// `tests/*.test.ts` (dependency direction, the gate workflow, and other
// cross-package assertions with no single package to live under), in
// `apps/editor` (since #66 step 5 — #35 rules that a feature never imports the
// host and the host never imports a feature, so the composition of the two is
// only visible from the app that assembles it, and neither package's own test
// directory can hold that assertion), or (since #57) in a `scripts/*.test.mjs`
// beside the script it covers.
//
// None of them needs the Vite config: esbuild transforms the app's `.tsx`
// against that package's own tsconfig, so reaching across for the app's config
// would pull a bundler plugin back into repo-root tooling for nothing.
export default defineConfig({
  test: {
    // Agent worktrees under .claude/ are full checkouts, so vitest's defaults
    // discover their copies of every test file and run the suite once per
    // worktree — a green run then reports several times the tests it has.
    exclude: [...configDefaults.exclude, '**/.claude/worktrees/**'],
    // #10's 15 s gate budget, measured over the whole run and enforced by a
    // throw from the teardown — see the file for why it is not a test file.
    globalSetup: ['tests/gate-budget.ts'],
  },
})
