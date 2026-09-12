/**
 * Drive the editor in a headless browser and capture what it draws.
 *
 * This is how the prototype gets checked without a screen: it also doubles as
 * the pixel-art-in-perspective spike, since it can pose the camera at a range
 * of pitches and save the frames for comparison.
 *
 * Usage:  node scripts/screenshot.mjs [outputDir] [--gpu]
 */
import { chromium } from 'playwright'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromiumArgs, stripGpuFlag, wantsGpu } from './chromium-launch.mjs'

// Vite's config, `index.html` and `dist/` all live with the app now, so both
// spawns below run from there rather than from the repo root.
const APP = fileURLToPath(new URL('../apps/editor', import.meta.url))

const GPU = wantsGpu()
const OUT = stripGpuFlag()[0] ?? 'shots'
const PORT = 4300 + Math.floor(Math.random() * 400)
mkdirSync(OUT, { recursive: true })

// Preview serves dist/, so building here is the difference between capturing
// the current code and capturing whatever happened to be built last.
console.log('Building...')
const build = spawnSync('npx', ['vite', 'build'], { cwd: APP, stdio: ['ignore', 'ignore', 'inherit'] })
if (build.status !== 0) process.exit(build.status ?? 1)

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: APP,
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', () => {})
server.stderr.on('data', (chunk) => process.stderr.write(chunk))

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      // A bare fetch can hang rather than fail, which turns "server did not
      // start" into "script never finishes".
      const response = await fetch(`http://localhost:${PORT}/`, {
        signal: AbortSignal.timeout(1500),
      })
      if (response.ok) return
    } catch {
      // not up yet
    }
    await sleep(250)
  }
  throw new Error('vite preview did not start')
}

/** @type {string[]} */
const problems = []

try {
  await waitForServer()

  const browser = await chromium.launch({
    // No executablePath by default: Playwright resolves its own bundled
    // build (`npx playwright install chromium`, or `pnpm browsers`), the
    // only build guaranteed to match the Playwright version in
    // package.json. CHROMIUM_PATH stays as an override for a machine that
    // already pins its own browser.
    executablePath: process.env.CHROMIUM_PATH,
    args: chromiumArgs(GPU),
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  // Always start from the sample map rather than whatever a previous run
  // autosaved, so the captures are comparable between runs.
  await page.addInitScript(() => window.localStorage.clear())

  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' })
  // Let the first meshing pass and a few frames go by.
  await sleep(3500)

  const report = await page.evaluate(() => {
    // Plain JS has no generic-call syntax (`querySelector<T>()` is a type-only
    // construct `tsc` rejects outright in a `.mjs` file), so an `@type` cast
    // is the only way to tell `checkJs` this selector is a canvas — a bare
    // `querySelector` types as `Element | null`, which has no `.getContext`.
    const canvas = /** @type {HTMLCanvasElement | null} */ (document.querySelector('.stage canvas'))
    const gl = canvas && canvas.getContext('webgl2')
    return {
      hasCanvas: Boolean(canvas),
      width: canvas?.width ?? 0,
      height: canvas?.height ?? 0,
      renderer: gl ? gl.getParameter(gl.VERSION) : 'no webgl2 context',
      status: [...document.querySelectorAll('.status span')].map((s) => s.textContent),
    }
  })
  console.log('\nPage report:', JSON.stringify(report, null, 2))

  await page.screenshot({ path: `${OUT}/01-editor.png` })

  // Sculpt: drag across the terrain with the raise brush.
  const canvasHandle = await page.$('.stage canvas')
  if (!canvasHandle) throw new Error('".stage canvas" not found — did the editor mount?')
  const box = await canvasHandle.boundingBox()
  if (!box) throw new Error('".stage canvas" has no bounding box — is it hidden or zero-sized?')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2

  await page.mouse.move(cx - 120, cy - 40)
  await page.mouse.down()
  for (let i = 0; i < 14; i++) {
    await page.mouse.move(cx - 120 + i * 16, cy - 40 + Math.sin(i / 2) * 22)
    await sleep(30)
  }
  await page.mouse.up()
  await sleep(900)
  await page.screenshot({ path: `${OUT}/02-sculpted.png` })

  // Paint: switch to paint mode and brush a different tile.
  await page.keyboard.press('Tab')
  await sleep(300)
  await page.mouse.move(cx - 80, cy)
  await page.mouse.down()
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(cx - 80 + i * 18, cy + 10)
    await sleep(30)
  }
  await page.mouse.up()
  await sleep(700)
  await page.screenshot({ path: `${OUT}/03-painted.png` })

  // Objects: place a few sprites.
  await page.keyboard.press('2')
  await sleep(300)
  for (const [dx, dy] of [
    [-60, 30],
    [10, 60],
    [80, 20],
  ]) {
    await page.mouse.click(cx + dx, cy + dy)
    await sleep(400)
  }
  await page.screenshot({ path: `${OUT}/04-objects.png` })

  // Coverage readout under a freely rotating camera.
  await page.keyboard.press('3')
  await sleep(600)
  const coverage = await page.evaluate(() =>
    [...document.querySelectorAll('.readout')].map((p) => p.textContent?.replace(/\s+/g, ' ').trim()),
  )
  console.log('\nCoverage readout:', coverage)
  await page.screenshot({ path: `${OUT}/05-coverage.png` })

  // Pixel-art-in-perspective spike: the same scene at a range of pitches.
  for (const pitch of [20, 35, 55, 75]) {
    await page.mouse.move(cx, cy)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(cx, cy + (pitch - 35) * 3)
    await page.mouse.up({ button: 'middle' })
    await sleep(600)
    await page.screenshot({ path: `${OUT}/pitch-${pitch}.png`, clip: { x: box.x, y: box.y, width: box.width, height: box.height } })
  }

  // Play mode.
  await page.keyboard.press('p')
  await sleep(1200)
  await page.keyboard.down('w')
  await sleep(900)
  await page.keyboard.up('w')
  await sleep(400)
  await page.screenshot({ path: `${OUT}/06-play.png` })
  await page.keyboard.press('p')
  await sleep(400)

  const fps = await page.evaluate(() => document.querySelectorAll('.status span')[4]?.textContent)
  console.log('\nPerformance line:', fps)

  await browser.close()
} finally {
  server.kill()
}

if (problems.length > 0) {
  console.error('\nPage problems:')
  for (const problem of [...new Set(problems)]) console.error('  ' + problem)
  process.exit(1)
}
console.log(`\nNo console errors. Screenshots in ${OUT}/`)
