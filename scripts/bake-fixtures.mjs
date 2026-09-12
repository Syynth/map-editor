/**
 * Regenerate `packages/fixtures/baked/` — the sample map's placeholder sheet
 * and sprites as PNG, for consumers with no canvas to draw them with (#47).
 *
 * The generator draws with a 2D canvas, and this repo has ruled against giving
 * Node one (see "No native binary dependencies for tooling" in
 * docs/decision-log.md). So the drawing happens where a canvas already exists:
 * a headless Chromium loads the editor's dev-only `/bake.html`, whose module
 * (`apps/editor/src/bake/main.ts`) runs the generator and encodes each image
 * with the browser's own PNG encoder. This script only writes what comes back.
 *
 * Always the software renderer: Canvas 2D rasterises on the CPU there, so two
 * machines produce byte-identical PNGs and a re-bake with no source change is
 * a no-op in `git status`.
 *
 * Usage:  pnpm bake
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromiumArgs } from './chromium-launch.mjs'

const APP = fileURLToPath(new URL('../apps/editor', import.meta.url))
const OUT = fileURLToPath(new URL('../packages/fixtures/baked', import.meta.url))
const PORT = 4700 + Math.floor(Math.random() * 300)

// The dev server, not `vite preview`: bake.html is a second HTML entry that
// the production build deliberately does not include, and dev serves any HTML
// under the app root without configuration.
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
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
      const response = await fetch(`http://localhost:${PORT}/bake.html`, {
        signal: AbortSignal.timeout(1500),
      })
      if (response.ok) return
    } catch {
      // not up yet
    }
    await sleep(250)
  }
  throw new Error('vite dev server did not start')
}

const problems = []

try {
  await waitForServer()

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: chromiumArgs(false),
  })
  const page = await browser.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))

  await page.goto(`http://localhost:${PORT}/bake.html`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__bake !== undefined, null, { timeout: 30_000 })
  const { manifest, files } = await page.evaluate(() => window.__bake)
  await browser.close()

  // Wipe first so a sprite that leaves the library does not leave its PNGs
  // behind; tests/baked-fixtures.test.ts checks for exactly that.
  rmSync(OUT, { recursive: true, force: true })
  for (const [path, dataUrl] of Object.entries(files)) {
    const target = join(OUT, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
  }
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  const written = readdirSync(OUT, { recursive: true }).filter((entry) => entry.endsWith('.png')).length
  console.log(`Baked ${written} PNGs + manifest.json into ${OUT}`)
} finally {
  server.kill()
}

if (problems.length > 0) {
  console.error('\nPage problems:')
  for (const problem of [...new Set(problems)]) console.error('  ' + problem)
  process.exit(1)
}
