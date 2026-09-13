/**
 * Performance harness.
 *
 * Runs the production editor in Chromium on this machine's real GPU, drives
 * it through a set of tasks, and measures each one for frame time, memory
 * footprint, allocations and leaks. Measurement only: nothing here fails on a
 * number. Compare two runs to see what a change did.
 *
 *   pnpm perf [--only idle,sculpt] [--seconds 5] [--cycles 8] [--compare shots/perf/<run>.json]
 *             [--software] [--headed] [--dpr 2] [--sites 5] [--out shots/perf]
 *
 * Tasks, each timed for `--seconds`:
 *
 *   frame time   rAF intervals (what a user feels); the viewport loop's own CPU
 *                work per frame split by phase — camera, meshing, objects,
 *                overlays, render, report — from `profile.ts`; GPU time per
 *                frame from WebGL timer queries; pick cost and long tasks.
 *                Missed frames with little CPU work and a large GPU figure are
 *                the GPU; with little of both, look at the main thread line.
 *   main thread  script, style and layout time per second from the DevTools
 *                protocol; script time outside the viewport loop is React,
 *                handlers and the document.
 *   allocations  V8's sampling heap profiler with collected objects counted,
 *                so the figure is what was allocated, not what survived; the
 *                top allocation sites by bytes. The bundle is built unminified
 *                (same production React, same code) so the sites are readable.
 *   memory       JS heap before, at the end of the work, and retained after a
 *                forced GC; GPU-side geometry and texture bytes and three's
 *                counts; the whole browser process tree's RSS and, on macOS,
 *                physical footprint — the Activity Monitor figure, which counts
 *                GPU memory on Apple silicon where RSS does not.
 *
 * Leak cycles repeat an action `--cycles` times, force a GC after each, and fit
 * a slope to heap, DOM nodes, listeners, geometries, textures, programs and
 * footprint; steady growth past a noise floor is reported as growth.
 *
 * Writes `<out>/<time>-<sha>.json` and `<out>/latest.json`. Defaults to the
 * real GPU, unlike tour and probe, because frame times under SwiftShader are
 * not this editor's frame times; `--software` runs it anyway.
 */
import { chromium } from 'playwright'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

import { buildWorkspacePackages } from './build-workspace.mjs'
import { chromiumArgs } from './chromium-launch.mjs'
import { compareRuns, distribution, formatBytes, mean, parseArgs, summarizeAllocations, summarizeCycles, summarizeIntervals } from './perf-stats.mjs'

const options = parseArgs(process.argv.slice(2))
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const APP = fileURLToPath(new URL('../apps/editor', import.meta.url))
// Its own output directory, so a perf build never replaces the `dist/` tour, probe and preview serve.
const OUT_DIR = 'dist-perf'
const SAMPLING_INTERVAL = 16 * 1024

/** @param {string} message */
const log = (message) => console.log(message)

// --- build and serve -----------------------------------------------------------

buildWorkspacePackages()
log('Building the editor (production, unminified)...')
const build = spawnSync('npx', ['vite', 'build', '--minify', 'false', '--outDir', OUT_DIR, '--emptyOutDir'], { cwd: APP, stdio: ['ignore', 'ignore', 'inherit'] })
if (build.status !== 0) process.exit(build.status ?? 1)

const PORT = 4900 + Math.floor(Math.random() * 90)
// Its own process group, so tearing it down takes vite with it rather than only npx.
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--outDir', OUT_DIR], { cwd: APP, stdio: ['ignore', 'ignore', 'inherit'], detached: true })
const profileDir = mkdtempSync(join(tmpdir(), 'papercut-perf-'))

/** @type {import('playwright').BrowserContext | null} */
let context = null
let exitCode = 0
try {
  await waitForServer()
  context = await chromium.launchPersistentContext(profileDir, {
    headless: !options.headed,
    executablePath: process.env.CHROMIUM_PATH,
    args: [...chromiumArgs(options.gpu), '--enable-precise-memory-info'],
    viewport: { width: 1400, height: 820 },
    deviceScaleFactor: options.dpr,
  })
  await run(context)
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  await context?.close().catch(() => undefined)
  try {
    if (server.pid) process.kill(-server.pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
  rmSync(profileDir, { recursive: true, force: true })
}
process.exit(exitCode)

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1500) })
      if (response.ok) return
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error(`vite preview did not come up on port ${PORT}`)
}

// --- the browser's process tree ------------------------------------------------

/**
 * Every process the browser started, found by the throwaway profile directory
 * on the browser's own command line and then by parentage: RSS for all of
 * them, and on macOS the physical footprint `top` reports, split by kind.
 */
function processMemory() {
  const table = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const rows = []
  for (const line of table.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]) * 1024, command: match[4] })
  }
  const marker = basename(profileDir)
  const root = rows.find((row) => row.command.includes(marker) && !row.command.includes('--type='))
  if (!root) return null
  const members = new Set([root.pid])
  for (let grew = true; grew; ) {
    grew = false
    for (const row of rows) {
      if (!members.has(row.pid) && members.has(row.ppid)) {
        members.add(row.pid)
        grew = true
      }
    }
  }
  const tree = rows.filter((row) => members.has(row.pid))
  /** @param {string} command */
  const kind = (command) => (/--type=renderer/.test(command) ? 'renderer' : /--type=gpu-process/.test(command) ? 'gpu' : /--type=/.test(command) ? 'utility' : 'browser')
  /** @type {Record<string, number>} */
  const footprints = platform() === 'darwin' ? footprintOf(tree.map((row) => row.pid)) : {}
  /** @type {Record<string, { rssBytes: number, footprintBytes: number }>} */
  const byKind = {}
  let rssBytes = 0
  let footprintBytes = 0
  for (const row of tree) {
    const entry = (byKind[kind(row.command)] ??= { rssBytes: 0, footprintBytes: 0 })
    entry.rssBytes += row.rss
    rssBytes += row.rss
    const footprint = footprints[String(row.pid)] ?? 0
    entry.footprintBytes += footprint
    footprintBytes += footprint
  }
  return { rssBytes, footprintBytes, processes: tree.length, byKind }
}

/**
 * macOS physical footprint per pid, from one `top` sample.
 * @param {readonly number[]} pids
 * @returns {Record<string, number>}
 */
function footprintOf(pids) {
  if (pids.length === 0) return {}
  try {
    const out = execFileSync('top', ['-l', '1', '-stats', 'pid,mem', ...pids.flatMap((pid) => ['-pid', String(pid)])], { encoding: 'utf8' })
    /** @type {Record<string, number>} */
    const result = {}
    const units = /** @type {Record<string, number>} */ ({ B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 })
    for (const line of out.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+([\d.]+)([BKMG])[+-]?$/)
      if (match) result[match[1]] = Math.round(Number(match[2]) * (units[match[3]] ?? 1))
    }
    return result
  } catch {
    return {}
  }
}

// --- the run -----------------------------------------------------------------

/** @param {import('playwright').BrowserContext} browserContext */
async function run(browserContext) {
  const page = browserContext.pages()[0] ?? (await browserContext.newPage())
  page.on('pageerror', (error) => log(`PAGEERROR ${error.message}`))
  await page.addInitScript(() => {
    window.localStorage.clear()
    const perf = { intervals: new Float64Array(1 << 16), count: 0, last: 0, recording: false, longTasks: /** @type {number[]} */ ([]) }
    window.__perf = perf
    /** @param {number} time */
    const tick = (time) => {
      if (perf.recording) {
        if (perf.last > 0 && perf.count < perf.intervals.length) perf.intervals[perf.count++] = time - perf.last
        perf.last = time
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    try {
      new PerformanceObserver((list) => {
        if (!perf.recording) return
        for (const entry of list.getEntries()) perf.longTasks.push(entry.duration)
      }).observe({ type: 'longtask' })
    } catch {
      /* no long task timing in this browser */
    }
  })

  const cdp = await browserContext.newCDPSession(page)
  await cdp.send('Performance.enable')
  await cdp.send('HeapProfiler.enable')

  const metrics = async () => {
    const { metrics: list } = await cdp.send('Performance.getMetrics')
    /** @type {Record<string, number>} */
    const out = {}
    for (const metric of list) out[metric.name] = metric.value
    return out
  }
  const gc = async () => {
    await cdp.send('HeapProfiler.collectGarbage')
    await cdp.send('HeapProfiler.collectGarbage')
  }
  const snapshot = async () => {
    const values = await metrics()
    const gpu = await page.evaluate(() => window.__viewport.gpuMemoryForProbe())
    const processes = processMemory()
    return {
      heapUsedBytes: values.JSHeapUsedSize ?? 0,
      heapTotalBytes: values.JSHeapTotalSize ?? 0,
      nodes: values.Nodes ?? 0,
      listeners: values.JSEventListeners ?? 0,
      gpu,
      processes,
    }
  }
  /**
   * @param {string} id
   * @param {unknown} [args]
   * @param {{ quiet?: boolean }} [how]  quiet: a refusal is expected (leaving play mode when not in it, on the way out of a failed task)
   */
  const dispatch = async (id, args, how = {}) => {
    const result = await page.evaluate(([command, commandArgs]) => window.__host.dispatch(/** @type {string} */ (command), commandArgs), [id, args])
    if (!result.ok && !how.quiet) log(`  ! ${id} refused: ${JSON.stringify(result)}`)
    return result
  }

  // --- boot ------------------------------------------------------------------
  const url = `http://localhost:${PORT}/`
  const bootStarted = Date.now()
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__viewport !== undefined && window.__viewport.gpuMemoryForProbe().triangles > 0, null, { timeout: 60_000, polling: 100 })
  const firstFrameMs = Date.now() - bootStarted
  await sleep(1500)
  await gc()
  const bootSnapshot = await snapshot()
  const rendererName = await page.evaluate(() => window.__viewport.rendererNameForProbe())
  const drawingBuffer = await page.evaluate(() => window.__viewport.drawingBufferForProbe())
  const userAgent = await page.evaluate(() => navigator.userAgent)
  const software = /swiftshader|llvmpipe|software/i.test(rendererName)
  log(`\nRenderer: ${rendererName}${software ? '  (SOFTWARE — frame times are not this machine’s)' : ''}`)
  log(`Drawing buffer ${drawingBuffer.width} × ${drawingBuffer.height} at ${drawingBuffer.pixelRatio}x`)
  log(`First frame ${firstFrameMs} ms · heap ${formatBytes(bootSnapshot.heapUsedBytes)} · footprint ${formatBytes(bootSnapshot.processes?.footprintBytes ?? 0)} · rss ${formatBytes(bootSnapshot.processes?.rssBytes ?? 0)}`)

  const sample = await page.evaluate(() => JSON.stringify(window.__host.reader.doc))
  const restore = async () => {
    await dispatch('document.load', { json: sample })
    await settle()
  }
  const settle = async () => {
    await page.evaluate(() => {
      window.__viewport.frameMap()
      window.__viewport.setCameraForProbe({ yaw: 35, pitch: 40 })
    })
    await sleep(400)
  }
  const box = async () => {
    const found = await page.locator('canvas.stage-canvas').boundingBox()
    if (!found) throw new Error('the stage canvas has no box')
    return found
  }
  /**
   * A client point whose pick is what a task wants to press, nearest the centre.
   * @param {'object' | 'sketch' | 'ground'} want
   */
  const findOnScreen = async (want) => {
    const stage = await box()
    return page.evaluate(
      ([bounds, wanted]) => {
        const b = /** @type {{ x: number, y: number, width: number, height: number }} */ (bounds)
        const hits = []
        for (let gy = 1; gy < 20; gy++) {
          for (let gx = 1; gx < 32; gx++) {
            const x = b.x + (gx / 32) * b.width
            const y = b.y + (gy / 20) * b.height
            const pick = window.__viewport.pickForProbe(x, y)
            const ok = wanted === 'object' ? pick.objectId !== null : wanted === 'sketch' ? pick.objectId === null && pick.kind === 3 : pick.objectId === null && pick.kind === 0
            if (ok) hits.push({ x, y, distance: Math.hypot(x - b.x - b.width / 2, y - b.y - b.height / 2) })
          }
        }
        hits.sort((a, c) => a.distance - c.distance)
        return hits[0] ?? null
      },
      [stage, want],
    )
  }
  /**
   * Call `step` about sixty times a second for `seconds`, as a mouse would move.
   * @param {number} seconds
   * @param {(t: number) => Promise<unknown>} step  `t` in seconds since the start
   */
  const paced = async (seconds, step) => {
    const started = Date.now()
    while (Date.now() - started < seconds * 1000) {
      const tick = Date.now()
      await step((tick - started) / 1000)
      const spent = Date.now() - tick
      if (spent < 16) await sleep(16 - spent)
    }
  }
  /**
   * A drag from `from`, circling it at `radius` pixels, with `button` held.
   * @param {{ x: number, y: number }} from
   * @param {number} radius
   * @param {'left' | 'middle'} button
   */
  const circleDrag = async (from, radius, button = 'left') => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down({ button })
    await paced(options.seconds, (t) => page.mouse.move(from.x + Math.sin(t * 2.4) * radius, from.y + (1 - Math.cos(t * 2.4)) * radius * 0.6, { steps: 1 }))
    await page.mouse.up({ button })
  }
  /** @param {string} tool */
  const useTool = (tool) => dispatch('tools.set', { tool })

  /**
   * @typedef {{ name: string, description: string, setup?: () => Promise<unknown>, run: () => Promise<unknown>, teardown?: () => Promise<unknown> }} Task
   */
  /** @type {Task[]} */
  const tasks = [
    {
      name: 'idle',
      description: 'the sample map open, nothing moving',
      setup: settle,
      run: () => sleep(options.seconds * 1000),
    },
    {
      name: 'hover',
      description: 'the pointer sweeping the stage with Select, no button held',
      setup: async () => {
        await settle()
        await useTool('select')
      },
      run: async () => {
        const stage = await box()
        const cx = stage.x + stage.width / 2
        const cy = stage.y + stage.height / 2
        await paced(options.seconds, (t) => page.mouse.move(cx + Math.sin(t * 1.7) * stage.width * 0.4, cy + Math.sin(t * 2.3) * stage.height * 0.35))
      },
    },
    {
      name: 'orbit',
      description: 'a middle-button drag orbiting the camera',
      setup: settle,
      run: async () => {
        const stage = await box()
        await circleDrag({ x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 }, 180, 'middle')
      },
    },
    {
      name: 'sculpt',
      description: 'a raise stroke dragged in circles over the ground',
      setup: async () => {
        await settle()
        await useTool('terrain')
        await dispatch('terrain.params', { terrainMode: 'sculpt', sculptVerb: 'raise' })
      },
      run: async () => {
        const at = await findOnScreen('ground')
        if (!at) throw new Error('no ground on screen to sculpt')
        await circleDrag(at, 120)
      },
      teardown: restore,
    },
    {
      name: 'paint',
      description: 'a tint stroke dragged in circles over the ground',
      setup: async () => {
        await settle()
        await useTool('terrain')
        await dispatch('terrain.params', { terrainMode: 'paint', paintVerb: 'tint' })
      },
      run: async () => {
        const at = await findOnScreen('ground')
        if (!at) throw new Error('no ground on screen to paint')
        await circleDrag(at, 120)
      },
      teardown: async () => {
        await dispatch('terrain.params', { terrainMode: 'sculpt' })
        await restore()
      },
    },
    {
      name: 'drag-object',
      description: 'an object dragged around with Select',
      setup: async () => {
        await settle()
        await useTool('select')
      },
      run: async () => {
        const at = await findOnScreen('object')
        if (!at) throw new Error('no object on screen to drag')
        await circleDrag(at, 140)
      },
      teardown: restore,
    },
    {
      name: 'drag-structure',
      description: 'a sketch dragged around with Select, hopping on and off what is under it',
      setup: async () => {
        await settle()
        await useTool('select')
      },
      run: async () => {
        const at = await findOnScreen('sketch')
        if (!at) throw new Error('no sketch on screen to drag')
        await circleDrag(at, 160)
      },
      teardown: restore,
    },
    {
      name: 'layers',
      description: 'the layer range swept down and up, a full rebuild on every step',
      setup: settle,
      run: () =>
        page.evaluate(async (seconds) => {
          const started = performance.now()
          let step = 0
          while (performance.now() - started < seconds * 1000) {
            const hi = 12 - Math.abs((step % 24) - 12)
            window.__host.dispatch('view.set', { layers: { lo: 0, hi } })
            step += 1
            await new Promise((resolve) => requestAnimationFrame(resolve))
          }
        }, options.seconds),
      teardown: () => dispatch('view.set', { layers: null }),
    },
    {
      name: 'play',
      description: 'play mode, walking in a weaving line',
      setup: settle,
      run: async () => {
        await dispatch('mode.play')
        await sleep(300)
        await page.keyboard.down('w')
        await paced(options.seconds, async (t) => {
          const turn = Math.floor(t / 0.7) % 2 === 0 ? 'a' : 'd'
          const other = turn === 'a' ? 'd' : 'a'
          await page.keyboard.up(other)
          await page.keyboard.down(turn)
        })
        for (const key of ['w', 'a', 'd']) await page.keyboard.up(key)
      },
      teardown: async () => {
        await dispatch('mode.edit')
        await restore()
      },
    },
    {
      name: 'undo-redo',
      description: 'undo and redo walked through forty terrain edits, one step a frame',
      setup: async () => {
        await settle()
        for (let i = 0; i < 40; i++) await dispatch('terrain.raise', { structure: 'ground', cells: [[4 + (i % 20), 4 + Math.floor(i / 20)]], delta: 1 })
      },
      run: () =>
        page.evaluate(async (seconds) => {
          const started = performance.now()
          let undoing = true
          while (performance.now() - started < seconds * 1000) {
            const result = window.__host.dispatch(undoing ? 'undo' : 'redo')
            if (!result.ok) undoing = !undoing
            await new Promise((resolve) => requestAnimationFrame(resolve))
          }
        }, options.seconds),
      teardown: restore,
    },
    {
      name: 'big-map',
      description: 'a 128 × 128 map, sculpted in circles',
      setup: async () => {
        await dispatch('document.new', { width: 128, height: 128, name: 'Perf 128' })
        await settle()
        await useTool('terrain')
        await dispatch('terrain.params', { terrainMode: 'sculpt', sculptVerb: 'raise' })
      },
      run: async () => {
        const at = await findOnScreen('ground')
        if (!at) throw new Error('no ground on screen to sculpt')
        await circleDrag(at, 160)
      },
      teardown: restore,
    },
  ]

  /**
   * @typedef {{ name: string, description: string, once: () => Promise<unknown> }} Cycle
   */
  /** @type {Cycle[]} */
  const cycles = [
    { name: 'reload-document', description: 'the same map loaded again: every structure torn down and rebuilt', once: restore },
    {
      name: 'play-stop',
      description: 'into play mode and back out',
      once: async () => {
        await dispatch('mode.play')
        await sleep(250)
        await dispatch('mode.edit')
        await sleep(250)
      },
    },
    {
      name: 'sculpt-undo',
      description: 'a short raise stroke, then undo',
      once: async () => {
        await useTool('terrain')
        await dispatch('terrain.params', { terrainMode: 'sculpt', sculptVerb: 'raise' })
        const at = await findOnScreen('ground')
        if (!at) return
        await page.mouse.move(at.x, at.y)
        await page.mouse.down()
        for (let i = 0; i < 12; i++) {
          await page.mouse.move(at.x + i * 6, at.y + i * 3)
          await sleep(16)
        }
        await page.mouse.up()
        await sleep(100)
        await dispatch('undo')
        await sleep(100)
      },
    },
    {
      name: 'layers-on-off',
      description: 'the layer view narrowed and cleared',
      once: async () => {
        await dispatch('view.set', { layers: { lo: 0, hi: 4 } })
        await sleep(150)
        await dispatch('view.set', { layers: null })
        await sleep(150)
      },
    },
    {
      name: 'tool-switch',
      description: 'every tool in turn, panels and all',
      once: async () => {
        for (const tool of ['terrain', 'object', 'sketch', 'select']) {
          await useTool(tool)
          await sleep(80)
        }
      },
    },
    {
      name: 'hover-sweep',
      description: 'a second of the pointer sweeping the stage',
      once: async () => {
        await useTool('select')
        const stage = await box()
        await paced(1, (t) => page.mouse.move(stage.x + stage.width * (0.2 + 0.6 * ((t * 2) % 1)), stage.y + stage.height * 0.5))
      },
    },
  ]

  const selected = (/** @type {string} */ name) => options.only === null || options.only.includes(name)

  // --- tasks -----------------------------------------------------------------
  const taskResults = []
  for (const task of tasks.filter((candidate) => selected(candidate.name))) {
    log(`\n▸ ${task.name} — ${task.description}`)
    try {
      await task.setup?.()
      await gc()
      const before = await snapshot()
      await cdp.send('HeapProfiler.startSampling', { samplingInterval: SAMPLING_INTERVAL, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true })
      const m0 = await metrics()
      await page.evaluate(() => {
        const perf = window.__perf
        if (!perf) throw new Error('the perf init script did not run')
        perf.count = 0
        perf.last = 0
        perf.longTasks.length = 0
        perf.recording = true
        window.__viewport.startFrameProfileForProbe(1 << 15)
      })
      const started = Date.now()
      await task.run()
      const wallMs = Date.now() - started
      await page.evaluate(() => {
        const perf = window.__perf
        if (perf) perf.recording = false
      })
      const m1 = await metrics()
      const { profile: heapProfile } = await cdp.send('HeapProfiler.stopSampling')
      const recorded = await page.evaluate(() => {
        const perf = window.__perf
        return { intervals: perf ? Array.from(perf.intervals.subarray(0, perf.count)) : [], longTasks: perf ? [...perf.longTasks] : [], profile: window.__viewport.takeFrameProfileForProbe() }
      })
      const peak = await snapshot()
      await task.teardown?.()
      await gc()
      const after = await snapshot()

      const seconds = wallMs / 1000
      const delta = (/** @type {string} */ key) => ((m1[key] ?? 0) - (m0[key] ?? 0)) * 1000
      const frameProfile = recorded.profile
      const loopMs = frameProfile ? frameProfile.total.reduce((sum, ms) => sum + ms, 0) : 0
      const allocations = summarizeAllocations(/** @type {import('./perf-stats.mjs').SamplingProfile} */ (/** @type {unknown} */ (heapProfile)), options.sites)
      const result = {
        name: task.name,
        description: task.description,
        wallMs,
        intervals: summarizeIntervals(recorded.intervals),
        work: frameProfile
          ? {
              total: distribution(frameProfile.total),
              phases: Object.fromEntries(Object.entries(frameProfile.phases).map(([phase, values]) => [phase, distribution(values)])),
              picks: { count: frameProfile.picks.count, msEach: frameProfile.picks.count > 0 ? frameProfile.picks.ms / frameProfile.picks.count : 0, msPerSecond: frameProfile.picks.ms / seconds },
              gpu: frameProfile.gpuTimed ? distribution(frameProfile.gpu) : null,
            }
          : null,
        longTasks: { count: recorded.longTasks.length, totalMs: recorded.longTasks.reduce((sum, ms) => sum + ms, 0), maxMs: recorded.longTasks.length > 0 ? Math.max(...recorded.longTasks) : 0 },
        mainThread: {
          scriptPerSecond: delta('ScriptDuration') / seconds,
          stylePerSecond: (delta('RecalcStyleDuration') + delta('LayoutDuration')) / seconds,
          taskPerSecond: delta('TaskDuration') / seconds,
          scriptOutsideLoopPerSecond: Math.max(0, delta('ScriptDuration') - loopMs) / seconds,
          layouts: (m1.LayoutCount ?? 0) - (m0.LayoutCount ?? 0),
          styleRecalcs: (m1.RecalcStyleCount ?? 0) - (m0.RecalcStyleCount ?? 0),
        },
        allocations: { bytes: allocations.totalBytes, bytesPerSecond: allocations.totalBytes / seconds, sites: allocations.sites },
        memory: {
          heapBeforeBytes: before.heapUsedBytes,
          heapPeakBytes: peak.heapUsedBytes,
          heapRetainedBytes: after.heapUsedBytes - before.heapUsedBytes,
          rssPeakBytes: peak.processes?.rssBytes ?? 0,
          footprintPeakBytes: peak.processes?.footprintBytes ?? 0,
          processes: peak.processes,
          gpu: peak.gpu,
          gpuAfter: after.gpu,
        },
      }
      taskResults.push(result)
      printTask(result)
    } catch (error) {
      log(`  ✗ ${error instanceof Error ? error.message : String(error)}`)
      await page.evaluate(() => {
        const perf = window.__perf
        if (perf) perf.recording = false
        window.__viewport.takeFrameProfileForProbe()
      }).catch(() => undefined)
      await cdp.send('HeapProfiler.stopSampling').catch(() => undefined)
      for (const button of /** @type {const} */ (['left', 'middle'])) await page.mouse.up({ button }).catch(() => undefined)
      await dispatch('mode.edit', undefined, { quiet: true }).catch(() => undefined)
      await restore().catch(() => undefined)
    }
  }

  // --- leak cycles -----------------------------------------------------------
  const cycleResults = []
  for (const cycle of cycles.filter((candidate) => selected(candidate.name))) {
    log(`\n↻ ${cycle.name} — ${cycle.description} (${options.cycles} cycles)`)
    try {
      await settle()
      // Two unmeasured rounds first: shader programs, caches and lazily built panels are a one-off, not a leak.
      await cycle.once()
      await cycle.once()
      const series = []
      for (let i = 0; i <= options.cycles; i++) {
        if (i > 0) await cycle.once()
        await gc()
        const reading = await snapshot()
        series.push({
          heapBytes: reading.heapUsedBytes,
          nodes: reading.nodes,
          listeners: reading.listeners,
          geometries: reading.gpu.geometries,
          textures: reading.gpu.textures,
          programs: reading.gpu.programs,
          sceneNodes: reading.gpu.sceneNodes,
          footprintBytes: reading.processes?.footprintBytes ?? 0,
          rssBytes: reading.processes?.rssBytes ?? 0,
        })
      }
      const summary = summarizeCycles(series, { heapBytes: 128 * 1024, nodes: 2, listeners: 2, geometries: 0.5, textures: 0.5, programs: 0.5, sceneNodes: 0.5, footprintBytes: 4 * 1024 * 1024, rssBytes: 4 * 1024 * 1024 })
      const result = { name: cycle.name, description: cycle.description, cycles: options.cycles, series, summary }
      cycleResults.push(result)
      printCycle(result)
    } catch (error) {
      log(`  ✗ ${error instanceof Error ? error.message : String(error)}`)
    }
    await restore().catch(() => undefined)
  }

  // --- write ---------------------------------------------------------------------
  const sha = git(['rev-parse', '--short', 'HEAD'])
  const dirty = git(['status', '--porcelain']) !== ''
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const report = {
    meta: {
      date: new Date().toISOString(),
      sha,
      dirty,
      renderer: rendererName,
      software,
      userAgent,
      gpuRequested: options.gpu,
      headed: options.headed,
      dpr: options.dpr,
      drawingBuffer,
      viewport: { width: 1400, height: 820 },
      seconds: options.seconds,
      cycles: options.cycles,
      os: { platform: platform(), release: release(), cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, memoryBytes: totalmem() },
      node: process.version,
    },
    boot: { firstFrameMs, snapshot: bootSnapshot },
    tasks: taskResults,
    cycles: cycleResults,
  }
  const outDir = join(ROOT, options.out)
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, `${stamp}-${sha}${dirty ? '-dirty' : ''}.json`)
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
  copyFileSync(file, join(outDir, 'latest.json'))
  log(`\nWrote ${file}`)

  if (options.compare) printComparison(JSON.parse(readFileSync(options.compare, 'utf8')), report)
}

/** @param {string[]} args */
function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : 'unknown'
}

// --- printing ----------------------------------------------------------------

// Declarations, not consts: the run above starts before this part of the module has executed.

/** @param {number} value */
function ms(value) {
  return `${value.toFixed(value < 10 ? 2 : 1)}ms`
}

/** @param {number} share */
function pct(share) {
  return `${(share * 100).toFixed(1)}%`
}

/** @param {any} result */
function printTask(result) {
  const i = result.intervals
  log(`  frames  ${i.count} at ${i.fps.toFixed(1)} fps · interval p50 ${ms(i.p50)} p95 ${ms(i.p95)} p99 ${ms(i.p99)} max ${ms(i.max)} · missed ${pct(i.missed)} (${pct(i.missedTwice)} twice)`)
  if (result.work) {
    const phases = Object.entries(result.work.phases)
      .map(([phase, d]) => /** @type {[string, any]} */ ([phase, d]))
      .sort((a, b) => b[1].mean - a[1].mean)
      .map(([phase, d]) => `${phase} ${ms(d.mean)}/${ms(d.p95)}`)
      .join(' · ')
    log(`  cpu     p50 ${ms(result.work.total.p50)} p95 ${ms(result.work.total.p95)} max ${ms(result.work.total.max)} — mean/p95: ${phases}`)
    const gpu = result.work.gpu
    log(gpu ? `  gpu     p50 ${ms(gpu.p50)} p95 ${ms(gpu.p95)} max ${ms(gpu.max)} over ${gpu.count} frames` : '  gpu     no timer queries on this driver')
    if (result.work.picks.count > 0) log(`  picks   ${result.work.picks.count} at ${ms(result.work.picks.msEach)} each, ${ms(result.work.picks.msPerSecond)}/s`)
  }
  const t = result.mainThread
  log(`  thread  script ${ms(t.scriptPerSecond)}/s (${ms(t.scriptOutsideLoopPerSecond)}/s outside the loop) · style+layout ${ms(t.stylePerSecond)}/s · ${t.styleRecalcs} recalcs, ${t.layouts} layouts · long tasks ${result.longTasks.count} (${ms(result.longTasks.totalMs)}, max ${ms(result.longTasks.maxMs)})`)
  log(`  alloc   ${formatBytes(result.allocations.bytesPerSecond)}/s (${formatBytes(result.allocations.bytes)} total)`)
  for (const site of result.allocations.sites) log(`          ${formatBytes(site.bytes).padStart(10)} ${pct(site.share).padStart(6)}  ${site.site}`)
  const m = result.memory
  log(`  memory  heap ${formatBytes(m.heapBeforeBytes)} → peak ${formatBytes(m.heapPeakBytes)}, retained ${formatBytes(m.heapRetainedBytes)} · footprint ${formatBytes(m.footprintPeakBytes)} · rss ${formatBytes(m.rssPeakBytes)}`)
  log(`  scene   ${m.gpu.drawCalls} draws · ${m.gpu.triangles} tris · ${m.gpu.geometries} geometries (${formatBytes(m.gpu.sceneGeometryBytes)}) · ${m.gpu.textures} textures (${formatBytes(m.gpu.sceneTextureBytes)}) · ${m.gpu.programs} programs · ${m.gpu.sceneNodes} nodes`)
}

/** @param {any} result */
function printCycle(result) {
  const labels = /** @type {Record<string, (value: number) => string>} */ ({
    heapBytes: formatBytes,
    footprintBytes: formatBytes,
    rssBytes: formatBytes,
  })
  for (const [key, entry] of Object.entries(result.summary)) {
    const e = /** @type {{ perCycle: number, first: number, last: number, grows: boolean }} */ (entry)
    const show = labels[key] ?? ((/** @type {number} */ value) => value.toFixed(value % 1 === 0 ? 0 : 2))
    log(`  ${e.grows ? '▲ GROWS' : '       '} ${key.padEnd(15)} ${show(e.first).padStart(10)} → ${show(e.last).padStart(10)}   ${show(e.perCycle)}/cycle`)
  }
}

/**
 * @param {any} base
 * @param {any} head
 */
function printComparison(base, head) {
  log(`\nCompared with ${base.meta?.sha ?? 'baseline'} (${base.meta?.date ?? ''}); changes of 5% or more:`)
  const rows = compareRuns(base, head).filter((row) => Math.abs(row.change) >= 0.05)
  if (rows.length === 0) log('  nothing moved by 5% or more')
  for (const row of rows) {
    const bytes = /bytes|heap|rss/.test(row.metric)
    const show = bytes ? formatBytes : (/** @type {number} */ value) => value.toFixed(2)
    const change = Number.isFinite(row.change) ? `${row.change > 0 ? '+' : ''}${(row.change * 100).toFixed(0)}%` : 'new'
    log(`  ${row.change < 0 ? 'better' : 'worse '} ${row.task.padEnd(15)} ${row.metric.padEnd(18)} ${show(row.base).padStart(10)} → ${show(row.head).padStart(10)}  ${change}`)
  }
  log(`  (mean of ${mean([1])} run each side — rerun before trusting a small change)`)
}
