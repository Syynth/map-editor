import { describe, expect, it } from 'vitest'

import { chromiumArgs } from './chromium-launch.mjs'

// --ignore-gpu-blocklist only means anything on the GPU path: the blocklist
// gates hardware GPU use, and SwiftShader is the fallback when it fires, so
// on the software path (which always launches with SwiftShader anyway) the
// flag is a no-op. Putting it there instead — as screenshot.mjs used to —
// silently loses the one thing it does: keeping a blocklisted Linux
// headless/container GPU from falling back to SwiftShader under --gpu.
describe('chromiumArgs', () => {
  it('sets --ignore-gpu-blocklist on the GPU path', () => {
    expect(chromiumArgs(true)).toContain('--ignore-gpu-blocklist')
  })

  it('does not set --ignore-gpu-blocklist on the software path', () => {
    expect(chromiumArgs(false)).not.toContain('--ignore-gpu-blocklist')
  })
})
