import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * eslint.config.js's `ignores` comment is the actual record of the bug this
 * workflow exists to catch: without a `**\/`-anchored ignore, `eslint .`
 * lints the built `dist/` bundle wherever one exists on disk, but a fresh
 * checkout has none yet — so a job that lints BEFORE it ever builds always
 * runs against a dist-less tree and stays green no matter how broken that
 * ignore is. The gate only reproduces the failing case (a machine that has
 * built) if the editor's own build step runs, as a separate CI step, before
 * the step that lints. It has to be a separate step and not merely an
 * earlier line in the same `turbo run build test typecheck lint` invocation:
 * `test`/`typecheck`/`lint` depend only on `^build` (a package's
 * dependencies), never on that package's own `build`, so turbo's scheduler
 * has no edge forcing apps/editor's build to finish first and could run the
 * two concurrently within one invocation.
 */
describe('CI gate workflow', () => {
  const workflow = readFileSync(join(import.meta.dirname, '../.github/workflows/gate.yml'), 'utf8')
  const steps = workflow.slice(workflow.indexOf('\n    steps:')).split(/\n {6}- /).slice(1)

  const buildStepIndex = steps.findIndex((step) =>
    /run:\s*pnpm (turbo run build\b|--filter @map-editor\/editor build\b)/.test(step),
  )
  const lintingStepIndex = steps.findIndex((step) => /run:\s*pnpm (gate\b|turbo run [^\n]*\blint\b)/.test(step))

  it('has a build step and a linting step', () => {
    expect(buildStepIndex).toBeGreaterThanOrEqual(0)
    expect(lintingStepIndex).toBeGreaterThanOrEqual(0)
  })

  it('builds the editor, in its own step, before the step that lints', () => {
    expect(buildStepIndex).not.toBe(lintingStepIndex)
    expect(buildStepIndex).toBeLessThan(lintingStepIndex)
  })
})
