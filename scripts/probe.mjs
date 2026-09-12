/**
 * Render diagnostic.
 *
 * Measures mean luminance at the centre of the viewport while toggling one
 * thing at a time. Written to track down a black viewport (see FINDINGS.md,
 * "Bloom renders black under software GL"); kept because the same question —
 * does post-processing survive on this machine's GPU? — is worth re-asking on
 * real hardware.
 *
 *   node scripts/probe.mjs [--gpu]
 *
 * A healthy run shows similar luminance for every row. A row near zero with
 * its neighbours bright names the pass that is failing. Add --gpu (or
 * TOUR_GPU=1) to ask the same question against a real driver instead of the
 * default SwiftShader — see scripts/chromium-launch.mjs.
 */
import { chromium } from 'playwright'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromiumArgs, wantsGpu } from './chromium-launch.mjs'
import { meanLuminance } from './luminance.mjs'

// Vite's config, `index.html` and `dist/` all live with the app now, so both
// spawns below run from there rather than from the repo root.
const APP = fileURLToPath(new URL('../apps/editor', import.meta.url))

spawnSync('npx', ['vite', 'build'], { cwd: APP, stdio: ['ignore', 'ignore', 'inherit'] })

const PORT = 4700 + Math.floor(Math.random() * 200)
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: APP,
  stdio: ['ignore', 'ignore', 'inherit'],
})

for (let i = 0; i < 60; i++) {
  try {
    const response = await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1500) })
    if (response.ok) break
  } catch {
    /* not up yet */
  }
  await sleep(250)
}

const GPU = wantsGpu()
const browser = await chromium.launch({
  // No executablePath by default: Playwright resolves its own bundled build
  // (`npx playwright install chromium`, or `pnpm browsers`). CHROMIUM_PATH
  // stays as an override for a machine that already pins its own browser.
  executablePath: process.env.CHROMIUM_PATH,
  args: chromiumArgs(GPU),
})
// Wide enough that the 264px + 316px panels still leave a real stage. Sampling
// a sliver of side panel instead of the canvas is how the first run lied.
const page = await browser.newPage({ viewport: { width: 1400, height: 820 } })
await page.addInitScript(() => window.localStorage.clear())
page.on('pageerror', (error) => console.log('PAGEERROR', error.message))
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' })
await sleep(5000)

const canvasHandle = await page.$('.stage canvas')
if (!canvasHandle) throw new Error('".stage canvas" not found — did the editor mount?')
const box = await canvasHandle.boundingBox()
if (!box) throw new Error('".stage canvas" has no bounding box — is it hidden or zero-sized?')
// Pulled into plain numbers rather than read off `box` inside `report`:
// `report` below is a hoisted `function` declaration, and `tsc` does not
// carry a `const` null-check's narrowing into a hoisted function's body (an
// arrow function assigned to a const would keep it) — so `report` would
// still see `box` as possibly-null even though it is only ever called after
// the throw above.
const { x: boxX, y: boxY, width: boxW, height: boxH } = box

/** @param {string} label */
async function report(label) {
  const luma = await meanLuminance(page, {
    x: boxX + boxW / 2 - 30,
    y: boxY + boxH / 2 - 30,
    width: 60,
    height: 60,
  })
  console.log(`${label.padEnd(30)} luma=${luma.toFixed(1)}`)
}

const software = await page.evaluate(() => window.__viewport.softwareRenderer)
console.log(`\nsoftware renderer detected: ${software}\n`)

// Post-processing switches itself off on a software renderer, so turn it back
// on here — measuring it is the whole point of this script.
await page.evaluate(() => {
  window.__viewport.setPassForProbe('bloom', true)
  window.__viewport.setPassForProbe('tiltShift', true)
})
await sleep(2200)
await report('composer, all passes')

await page.evaluate(() => window.__viewport.setPassForProbe('bloom', false))
await sleep(2200)
await report('composer, bloom off')

await page.evaluate(() => {
  window.__viewport.setPassForProbe('bloom', true)
  window.__viewport.setPassForProbe('tiltShift', false)
})
await sleep(2200)
await report('composer, tilt-shift off')

await page.evaluate(() => {
  window.__viewport.bypassComposer = true
})
await sleep(2200)
await report('direct render, no composer')

await browser.close()
server.kill()
