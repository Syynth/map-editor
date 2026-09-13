import { describe, expect, it } from 'vitest'

import { FRAME_PHASES, FrameProfile, GpuTimer } from './profile'

describe('FrameProfile', () => {
  it('records each phase per frame and the whole body, and stops at capacity rather than growing', () => {
    const profile = new FrameProfile(2, true)
    for (let frame = 0; frame < 3; frame++) {
      profile.begin()
      for (let i = 0; i < FRAME_PHASES.length; i++) profile.mark()
      profile.end()
    }
    profile.pick(1.5)
    profile.pick(0.5)
    for (const ms of [4, 5, 6]) profile.gpu(ms)
    const report = profile.report()
    expect(report.gpu).toEqual([4, 5])
    expect(report.gpuTimed).toBe(true)
    expect(report.frames).toBe(2)
    expect(report.total).toHaveLength(2)
    for (const phase of FRAME_PHASES) {
      expect(report.phases[phase]).toHaveLength(2)
      expect(report.phases[phase].every((ms) => ms >= 0)).toBe(true)
    }
    expect(report.picks).toEqual({ count: 2, ms: 2 })
  })

  it('ignores a mark past the last phase instead of writing into the next frame', () => {
    const profile = new FrameProfile(1, false)
    profile.begin()
    for (let i = 0; i < FRAME_PHASES.length + 3; i++) profile.mark()
    profile.end()
    expect(profile.report().frames).toBe(1)
    expect(profile.report().gpu).toEqual([])
  })
})

describe('GpuTimer', () => {
  /** A WebGL2 context with only what timer queries touch, whose queries finish when the test says so. */
  function fakeGl(withExtension: boolean) {
    const queries: object[] = []
    const results = new Map<object, number>()
    const state = { disjoint: false }
    const gl = {
      QUERY_RESULT_AVAILABLE: 1,
      QUERY_RESULT: 2,
      getExtension: () => (withExtension ? { TIME_ELAPSED_EXT: 10, GPU_DISJOINT_EXT: 11 } : null),
      createQuery: () => {
        const query = { id: queries.length }
        queries.push(query)
        return query
      },
      beginQuery: () => undefined,
      endQuery: () => undefined,
      getParameter: () => state.disjoint,
      getQueryParameter: (query: object, name: number) => (name === 1 ? results.has(query) : results.get(query)),
      deleteQuery: () => undefined,
    }
    return { gl: gl as unknown as WebGL2RenderingContext, queries, results, state }
  }

  it('reports spans oldest first once the GPU has them, waits on the rest, and reuses finished queries', () => {
    const { gl, queries, results } = fakeGl(true)
    const timer = new GpuTimer(gl)
    expect(timer.available).toBe(true)
    const recorded: number[] = []
    timer.begin()
    timer.end()
    timer.begin()
    timer.end()
    timer.poll((ms) => recorded.push(ms))
    expect(recorded).toEqual([])

    // The second finishing first does not jump the queue: results come back in frame order.
    results.set(queries[1], 5e6)
    timer.poll((ms) => recorded.push(ms))
    expect(recorded).toEqual([])
    results.set(queries[0], 3e6)
    timer.poll((ms) => recorded.push(ms))
    expect(recorded).toEqual([3, 5])

    // Both went back to the pool: the next spans reuse them rather than creating more.
    timer.begin()
    timer.end()
    timer.begin()
    timer.end()
    expect(queries).toHaveLength(2)
  })

  it('drops what was pending across a disjoint event rather than recording it wrong', () => {
    const { gl, queries, results, state } = fakeGl(true)
    const timer = new GpuTimer(gl)
    timer.begin()
    timer.end()
    results.set(queries[0], 9e6)
    state.disjoint = true
    const recorded: number[] = []
    timer.poll((ms) => recorded.push(ms))
    expect(recorded).toEqual([])
  })

  it('does nothing without the extension', () => {
    const { gl, queries } = fakeGl(false)
    const timer = new GpuTimer(gl)
    expect(timer.available).toBe(false)
    timer.begin()
    timer.end()
    const recorded: number[] = []
    timer.poll((ms) => recorded.push(ms))
    expect(recorded).toEqual([])
    expect(queries).toHaveLength(0)
  })
})
