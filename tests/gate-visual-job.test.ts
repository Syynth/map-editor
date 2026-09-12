import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * #56, per #60's ruling: the tour has to actually run in CI and fail loudly,
 * not merely exist as a script nobody invokes. A refactor that drops the
 * browser-install step, reorders the tour ahead of it, or lets the
 * upload-artifact step stop firing on failure would silently remove the one
 * net that has ever caught this project's rendering bugs — see FINDINGS.md,
 * where both were found by a human looking at screenshots after every unit
 * test had already passed.
 *
 * Since 2026-09-12 the job lives in its own `visual.yml` on
 * `workflow_dispatch`, off the per-PR path: it took four minutes to the
 * gate's one and was never a required check. The steps are pinned the same
 * way; what changed is where they are read from and the assertion that it
 * must NOT have crept back into gate.yml, where every PR would pay for it.
 */
describe('CI visual workflow', () => {
  const workflows = join(import.meta.dirname, '../.github/workflows')
  const visual = readFileSync(join(workflows, 'visual.yml'), 'utf8')
  const gate = readFileSync(join(workflows, 'gate.yml'), 'utf8')

  // `visual:` is the only job, so slicing from its header to end-of-file
  // isolates its steps without needing a YAML parser — the same
  // regex-over-text approach tests/gate-workflow.test.ts uses for `gate`.
  const visualJobStart = visual.indexOf('\n  visual:')
  const visualJob = visualJobStart >= 0 ? visual.slice(visualJobStart) : ''
  const steps = visualJob.slice(visualJob.indexOf('\n    steps:')).split(/\n {6}- /).slice(1)

  it('is its own manually-run workflow, and not a job in the per-PR gate', () => {
    expect(visualJobStart).toBeGreaterThan(0)
    expect(visual).toMatch(/^on:\n\s+workflow_dispatch:/m)
    expect(visual).not.toMatch(/^\s+pull_request:/m)
    expect(gate).not.toMatch(/\n  visual:/)
    expect(gate).not.toMatch(/run:\s*pnpm tour\b/)
  })

  it('installs Chromium before running the tour', () => {
    const browsersIndex = steps.findIndex((step) => /run:\s*pnpm browsers\b/.test(step))
    const tourIndex = steps.findIndex((step) => /run:\s*pnpm tour\b/.test(step))
    expect(browsersIndex).toBeGreaterThanOrEqual(0)
    expect(tourIndex).toBeGreaterThan(browsersIndex)
    // pnpm forwards every token after the script name verbatim, `--` included
    // (see `pnpm help run`), so a lone `--` before `--with-deps` reaches
    // Playwright's CLI as a literal argument rather than a separator and
    // fails install with "Invalid installation targets: '--with-deps'" — the
    // exact regex above still matched that broken line, which is why the
    // invocation is pinned exactly here instead of just asserting the step
    // exists.
    expect(steps[browsersIndex]).toMatch(/run:\s*pnpm browsers --with-deps\s*$/m)
  })

  it('uploads the tour screenshots as a workflow artifact on every run, pass or fail', () => {
    const uploadStep = steps.find((step) => /uses:\s*actions\/upload-artifact@/.test(step))
    expect(uploadStep).toBeDefined()
    expect(uploadStep).toMatch(/if:\s*always\(\)/)
    expect(uploadStep).toMatch(/path:\s*shots\/tour\//)
  })
})
