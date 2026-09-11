import { defineConfig, configDefaults, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

// Separate from vite.config.ts because vitest bundles its own copy of vite:
// declaring `test` inside the vite config fails to typecheck, since the two
// copies' plugin types are not assignable to each other.
export default mergeConfig(
  viteConfig,
  defineConfig({
    // Agent worktrees under .claude/ are full checkouts, so vitest's defaults
    // discover their copies of every test file and run the suite once per
    // worktree — a green run then reports several times the tests it has.
    test: { exclude: [...configDefaults.exclude, '**/.claude/worktrees/**'] },
  }),
)
