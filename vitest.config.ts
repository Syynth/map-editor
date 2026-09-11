import { defineConfig, configDefaults } from 'vitest/config'

// No longer merged with the Vite config: that config moved to `apps/editor`
// along with the app, and every test now lives in a `packages/*` package that
// is plain TypeScript with no JSX, so reaching across for it would pull a
// bundler plugin back into repo-root tooling for nothing.
export default defineConfig({
  // Agent worktrees under .claude/ are full checkouts, so vitest's defaults
  // discover their copies of every test file and run the suite once per
  // worktree — a green run then reports several times the tests it has.
  test: { exclude: [...configDefaults.exclude, '**/.claude/worktrees/**'] },
})
