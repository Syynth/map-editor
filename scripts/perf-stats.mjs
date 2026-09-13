/**
 * The arithmetic behind `scripts/perf.mjs`: percentiles, a frame-time
 * summary, the sampling heap profile's totals and top allocation sites, a
 * leak slope over repeated cycles, and a comparison of two runs. Kept apart
 * from the harness so it is tested without a browser (`perf-stats.test.mjs`).
 */

/**
 * The value below which `p` of the samples fall, by linear interpolation.
 * @param {readonly number[]} values
 * @param {number} p  0..1
 */
export function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, p * (sorted.length - 1)))
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}

/** @param {readonly number[]} values */
export function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * @typedef {{ count: number, mean: number, p50: number, p95: number, p99: number, max: number }} Distribution
 */

/**
 * @param {readonly number[]} values
 * @returns {Distribution}
 */
export function distribution(values) {
  return {
    count: values.length,
    mean: mean(values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length === 0 ? 0 : Math.max(...values),
  }
}

/** A frame at 60 Hz, and the frame budget a stutter blows twice over. */
export const FRAME_BUDGET_MS = 1000 / 60

/**
 * Frame intervals as a user feels them: the distribution, frames per second
 * over the window, and the share of frames that missed one and two budgets.
 * @param {readonly number[]} intervals  milliseconds between successive frames
 */
export function summarizeIntervals(intervals) {
  const total = intervals.reduce((sum, value) => sum + value, 0)
  const over = (/** @type {number} */ limit) => (intervals.length === 0 ? 0 : intervals.filter((value) => value > limit * 1.05).length / intervals.length)
  return {
    ...distribution(intervals),
    fps: total > 0 ? (intervals.length * 1000) / total : 0,
    missed: over(FRAME_BUDGET_MS),
    missedTwice: over(FRAME_BUDGET_MS * 2),
  }
}

/**
 * @typedef {{ functionName: string, url: string, lineNumber: number, columnNumber: number }} CallFrame
 * @typedef {{ callFrame: CallFrame, selfSize: number, children?: SamplingNode[] }} SamplingNode
 * @typedef {{ head: SamplingNode }} SamplingProfile
 */

/**
 * The sampling heap profile as totals: bytes allocated over the window
 * (V8 scales each node's `selfSize` into an estimate, and with the
 * collected-objects flags on it counts what the GC already freed), and the
 * allocation sites that account for most of it.
 * @param {SamplingProfile} profile
 * @param {number} top
 */
export function summarizeAllocations(profile, top = 10) {
  /** @type {Map<string, number>} */
  const sites = new Map()
  let total = 0
  /** @param {SamplingNode} node */
  const walk = (node) => {
    if (node.selfSize > 0) {
      total += node.selfSize
      const { functionName, url, lineNumber, columnNumber } = node.callFrame
      const file = url ? url.slice(url.lastIndexOf('/') + 1) : '(native)'
      const key = `${functionName || '(anonymous)'} ${file}:${lineNumber + 1}:${columnNumber + 1}`
      sites.set(key, (sites.get(key) ?? 0) + node.selfSize)
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(profile.head)
  const ranked = [...sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
  return { totalBytes: total, sites: ranked.map(([site, bytes]) => ({ site, bytes, share: total > 0 ? bytes / total : 0 })) }
}

/**
 * The least-squares slope of `values` against their index: how much a
 * quantity grows per cycle.
 * @param {readonly number[]} values
 */
export function slope(values) {
  const n = values.length
  if (n < 2) return 0
  const meanX = (n - 1) / 2
  const meanY = mean(values)
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i] - meanY)
    den += (i - meanX) ** 2
  }
  return den === 0 ? 0 : num / den
}

/**
 * What a cycle of repeated work leaves behind, per quantity: growth per
 * cycle, first and last reading, and whether it looks like a leak — steady
 * growth past a floor that allows for the heap's own noise. A reading that
 * rose and came back down is not a leak however large the swing.
 * @param {ReadonlyArray<Record<string, number>>} series  one snapshot per cycle, taken after a forced GC
 * @param {Record<string, number>} floors  per-quantity growth per cycle below which growth is noise
 */
export function summarizeCycles(series, floors) {
  const keys = series.length === 0 ? [] : Object.keys(series[0])
  /** @type {Record<string, { perCycle: number, first: number, last: number, grows: boolean }>} */
  const out = {}
  for (const key of keys) {
    const values = series.map((snapshot) => snapshot[key] ?? 0)
    const perCycle = slope(values)
    const first = values[0] ?? 0
    const last = values[values.length - 1] ?? 0
    const floor = floors[key] ?? 0
    // Rising at least three cycles in four, with the slope past the floor and the end above the start by more than one cycle's worth.
    let rises = 0
    for (let i = 1; i < values.length; i++) if (values[i] > values[i - 1]) rises += 1
    const steady = values.length > 1 && rises / (values.length - 1) >= 0.75
    out[key] = { perCycle, first, last, grows: perCycle > floor && last - first > floor && steady }
  }
  return out
}

/** The metrics `compareRuns` diffs, where lower is better for every one. */
export const COMPARED = [
  ['intervals.p95', 'frame p95 ms'],
  ['intervals.p99', 'frame p99 ms'],
  ['intervals.missed', 'missed frames'],
  ['work.total.p95', 'cpu work p95 ms'],
  ['work.gpu.p95', 'gpu p95 ms'],
  ['mainThread.scriptPerSecond', 'script ms/s'],
  ['mainThread.stylePerSecond', 'style+layout ms/s'],
  ['allocations.bytesPerSecond', 'alloc bytes/s'],
  ['memory.heapRetainedBytes', 'heap retained'],
  ['memory.rssPeakBytes', 'rss peak'],
]

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {number | undefined}
 */
function at(value, path) {
  /** @type {unknown} */
  let current = value
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = /** @type {Record<string, unknown>} */ (current)[key]
  }
  return typeof current === 'number' ? current : undefined
}

/**
 * Per task both runs have, each compared metric's baseline, head and change.
 * @param {{ tasks: ReadonlyArray<{ name: string }> }} base
 * @param {{ tasks: ReadonlyArray<{ name: string }> }} head
 */
export function compareRuns(base, head) {
  const rows = []
  for (const task of head.tasks) {
    const before = base.tasks.find((candidate) => candidate.name === task.name)
    if (!before) continue
    for (const [path, label] of COMPARED) {
      const a = at(before, path)
      const b = at(task, path)
      if (a === undefined || b === undefined) continue
      rows.push({ task: task.name, metric: label, base: a, head: b, change: a === 0 ? (b === 0 ? 0 : Infinity) : (b - a) / a })
    }
  }
  return rows
}

/**
 * @param {number} bytes
 */
export function formatBytes(bytes) {
  const sign = bytes < 0 ? '-' : ''
  const abs = Math.abs(bytes)
  if (abs >= 1024 ** 3) return `${sign}${(abs / 1024 ** 3).toFixed(2)} GiB`
  if (abs >= 1024 ** 2) return `${sign}${(abs / 1024 ** 2).toFixed(1)} MiB`
  if (abs >= 1024) return `${sign}${(abs / 1024).toFixed(1)} KiB`
  return `${sign}${Math.round(abs)} B`
}

/**
 * The harness's flags.
 * @param {readonly string[]} argv
 */
export function parseArgs(argv) {
  /** @param {string} name */
  const value = (name) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const number = (/** @type {string} */ name, /** @type {number} */ fallback) => {
    const raw = value(name)
    const parsed = raw === undefined ? NaN : Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }
  return {
    only: value('--only')?.split(',').map((name) => name.trim()).filter(Boolean) ?? null,
    seconds: number('--seconds', 5),
    cycles: number('--cycles', 8),
    gpu: !argv.includes('--software'),
    headed: argv.includes('--headed'),
    compare: value('--compare') ?? null,
    out: value('--out') ?? 'shots/perf',
    sites: number('--sites', 5),
    // Retina by default: the machines this runs on are Macs, and the renderer draws at up to 2x.
    dpr: number('--dpr', 2),
  }
}
