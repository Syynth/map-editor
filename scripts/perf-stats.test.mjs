import { describe, expect, it } from 'vitest'

import { compareRuns, distribution, formatBytes, parseArgs, percentile, slope, summarizeAllocations, summarizeCycles, summarizeIntervals } from './perf-stats.mjs'

describe('percentile and distribution', () => {
  it('interpolates between ranks and handles the ends and the empty case', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3)
    expect(percentile([10, 20], 0.5)).toBe(15)
    expect(percentile([5, 1, 3], 1)).toBe(5)
    expect(percentile([], 0.9)).toBe(0)
    expect(distribution([4, 2, 8, 6])).toMatchObject({ count: 4, mean: 5, max: 8 })
  })
})

describe('summarizeIntervals', () => {
  it('reports fps over the window and the share of frames that missed one and two budgets', () => {
    const intervals = [16.6, 16.7, 16.6, 40, 16.7, 16.6, 25, 16.7]
    const summary = summarizeIntervals(intervals)
    expect(summary.missed).toBeCloseTo(2 / 8)
    expect(summary.missedTwice).toBeCloseTo(1 / 8)
    expect(summary.fps).toBeCloseTo((8 * 1000) / intervals.reduce((a, b) => a + b, 0))
  })
})

describe('summarizeAllocations', () => {
  it('totals self sizes across the tree and ranks sites by bytes', () => {
    const frame = (/** @type {string} */ functionName, /** @type {number} */ line) => ({ functionName, url: 'http://localhost/assets/index-abc.js', lineNumber: line, columnNumber: 0 })
    const profile = {
      head: {
        callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 },
        selfSize: 0,
        children: [
          { callFrame: frame('meshTerrainChunk', 9), selfSize: 3000, children: [{ callFrame: frame('quad', 19), selfSize: 1000 }] },
          { callFrame: frame('pickAt', 99), selfSize: 500 },
          { callFrame: frame('meshTerrainChunk', 9), selfSize: 500 },
        ],
      },
    }
    const summary = summarizeAllocations(profile, 2)
    expect(summary.totalBytes).toBe(5000)
    expect(summary.sites).toEqual([
      { site: 'meshTerrainChunk index-abc.js:10:1', bytes: 3500, share: 0.7 },
      { site: 'quad index-abc.js:20:1', bytes: 1000, share: 0.2 },
    ])
  })
})

describe('leak detection', () => {
  it('fits a per-cycle slope', () => {
    expect(slope([10, 12, 14, 16])).toBeCloseTo(2)
    expect(slope([5])).toBe(0)
  })

  it('calls steady growth past the floor a leak, and a swing that came back or noise under the floor not', () => {
    const series = [
      { heap: 1000, textures: 4, geometries: 30 },
      { heap: 1500, textures: 5, geometries: 31 },
      { heap: 2100, textures: 6, geometries: 30 },
      { heap: 2600, textures: 7, geometries: 31 },
      { heap: 3200, textures: 8, geometries: 30 },
    ]
    const cycles = summarizeCycles(series, { heap: 256, textures: 0.5, geometries: 0.5 })
    expect(cycles.heap.grows).toBe(true)
    expect(cycles.heap.perCycle).toBeCloseTo(550)
    expect(cycles.textures.grows).toBe(true)
    expect(cycles.geometries.grows).toBe(false)

    const noisy = summarizeCycles([{ heap: 1000 }, { heap: 1100 }, { heap: 1050 }, { heap: 1150 }], { heap: 256 })
    expect(noisy.heap.grows).toBe(false)
  })
})

describe('compareRuns', () => {
  it('pairs tasks by name and reports each compared metric’s relative change', () => {
    const base = { tasks: [{ name: 'idle', intervals: { p95: 20 }, allocations: { bytesPerSecond: 1000 } }, { name: 'gone', intervals: { p95: 1 } }] }
    const head = { tasks: [{ name: 'idle', intervals: { p95: 15 }, allocations: { bytesPerSecond: 3000 } }, { name: 'new', intervals: { p95: 1 } }] }
    const rows = compareRuns(base, head)
    expect(rows).toEqual([
      { task: 'idle', metric: 'frame p95 ms', base: 20, head: 15, change: -0.25 },
      { task: 'idle', metric: 'alloc bytes/s', base: 1000, head: 3000, change: 2 },
    ])
  })
})

describe('parseArgs and formatBytes', () => {
  it('reads the flags with defaults, GPU on unless --software', () => {
    expect(parseArgs([])).toMatchObject({ only: null, seconds: 5, cycles: 8, gpu: true, headed: false, compare: null, out: 'shots/perf', dpr: 2 })
    expect(parseArgs(['--only', 'idle, sculpt', '--seconds', '2', '--software', '--compare', 'a.json', '--cycles', 'x'])).toMatchObject({
      only: ['idle', 'sculpt'],
      seconds: 2,
      gpu: false,
      compare: 'a.json',
      cycles: 8,
    })
  })

  it('formats byte counts on binary units', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(-5 * 1024 * 1024)).toBe('-5.0 MiB')
  })
})
