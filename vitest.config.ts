import { defineConfig, configDefaults } from 'vitest/config'

// No longer merged with the Vite config: that config moved to `apps/editor`
// along with the app, and every test is plain TypeScript with no JSX — in a
// `packages/*` package, a repo-root `tests/*.test.ts` (dependency direction,
// the gate workflow, and other cross-package assertions with no single
// package to live under), or (since #57) a `scripts/*.test.mjs` beside the
// script it covers — so reaching across for the Vite config would pull a
// bundler plugin back into repo-root tooling for nothing.
export default defineConfig({
  // Agent worktrees under .claude/ are full checkouts, so vitest's defaults
  // discover their copies of every test file and run the suite once per
  // worktree — a green run then reports several times the tests it has.
  test: { exclude: [...configDefaults.exclude, '**/.claude/worktrees/**'] },
})
