/**
 * Render diagnostic.
 *
 * Measures mean luminance at the centre of the viewport while toggling one
 * thing at a time. Written to track down a black viewport (see FINDINGS.md,
 * "Bloom renders black under software GL"); kept because the same question —
 * does post-processing survive on this machine's GPU? — is worth re-asking on
 * real hardware.
 *
 *   node scripts/probe.mjs
 *
 * A healthy run shows similar luminance for every row. A row near zero with
 * its neighbours bright names the pass that is failing.
 */
import { chromium } from 'playwright'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

spawnSync('npx', ['vite', 'build'], { stdio: ['ignore', 'ignore', 'inherit'] })

const PORT = 4700 + Math.floor(Math.random() * 200)
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
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

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
})
// Wide enough that the 264px + 316px panels still leave a real stage. Sampling
// a sliver of side panel instead of the canvas is how the first run lied.
const page = await browser.newPage({ viewport: { width: 1400, height: 820 } })
await page.addInitScript(() => window.localStorage.clear())
page.on('pageerror', (error) => console.log('PAGEERROR', error.message))
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' })
await sleep(5000)

const box = await (await page.$('.stage canvas')).boundingBox()

async function report(label) {
  const shot = await page.screenshot({
    clip: { x: box.x + box.width / 2 - 30, y: box.y + box.height / 2 - 30, width: 60, height: 60 },
  })
  const luma = await page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let sum = 0
    for (let i = 0; i < pixels.length; i += 4) {
      sum += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3
    }
    return sum / (pixels.length / 4)
  }, [...shot])
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
