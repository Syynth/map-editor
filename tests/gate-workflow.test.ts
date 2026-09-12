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

  // #79: nothing else in this suite would notice `check-bundle-size` (#57)
  // dropping out of the Build step's `run:` line — the two assertions above
  // only look for `build`. It rides in the same turbo invocation as `build`
  // (not its own step) because it dependsOn apps/editor's own `build` task,
  // so turbo's graph, not runner step ordering, is what makes it wait for
  // `dist/`; see the "Build" step's own comment in gate.yml.
  it('keeps check-bundle-size wired into the build step', () => {
    expect(steps[buildStepIndex]).toMatch(/run:\s*pnpm turbo run build\b[^\n]*\bcheck-bundle-size\b/)
  })

  // A group keyed only by `github.ref` (as it once was) puts every push to
  // `main` in the same group as every other: GitHub cancels a `pending` run
  // whenever a third run queues behind it, so a fast merge-train can cancel
  // an intermediate `main` SHA's pending run and leave it with no completed
  // gate run at all — restricting `cancel-in-progress` to `pull_request`
  // does not stop that, it only decides who does the cancelling. Keying the
  // group by `github.sha` for non-PR events gives every push to `main` its
  // own group, so no two `main` runs ever share one to queue behind or
  // supersede within.
  it('keys the concurrency group by sha (not just ref) outside pull requests', () => {
    const concurrency = workflow.slice(workflow.indexOf('\nconcurrency:'), workflow.indexOf('\npermissions:'))
    expect(concurrency).toMatch(/group:.*github\.event_name == 'pull_request'.*&&.*github\.ref.*\|\|.*github\.sha/)
  })
})
