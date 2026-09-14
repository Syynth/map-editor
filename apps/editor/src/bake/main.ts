/**
 * The bake page, `/bake.html` under the Vite dev server.
 *
 * `scripts/bake-fixtures.mjs` drives this in a headless Chromium to produce
 * `packages/fixtures/baked/`: the sample map's placeholder sheet and sprites
 * as PNG, for a consumer with no canvas to draw them with (#47). It lives in
 * the app rather than under `scripts/` because the generator needs a real 2D
 * canvas and a bundler that resolves the workspace packages, and the editor's
 * dev server is the one thing in the repo that provides both. It is not part
 * of the production build — Vite's build input is `index.html` alone.
 *
 * The page also renders what it baked, so `pnpm dev` + `/bake.html` is a way
 * to eyeball the art without the editor around it.
 */

import type { RgbaImage } from '@papercut/document'
import { createSampleProject } from '@papercut/fixtures'
// See `App.tsx`'s import of the same package for why the generator sits
// behind its own subpath.
import { generateSprites } from '@papercut/fixtures/textures'
import { rgbaToDataUrl } from '../editor/rgba'

export interface BakedSprite {
  widthTiles: number
  heightTiles: number
  emissive: boolean
  /** Every facing is this size, in pixels. */
  frame: { width: number; height: number }
  /** One PNG per facing, index 0 the front, relative to the manifest. */
  facings: string[]
}

export interface BakeManifest {
  source: string
  regenerate: string
  texelDensity: number
  materials: Array<{ name: string; color: number }>
  sprites: Record<string, BakedSprite>
}

export interface BakeResult {
  manifest: BakeManifest
  /** Relative path -> PNG as a data URL; the driver decodes the base64 and writes the file. */
  files: Record<string, string>
}

function bake(): BakeResult {
  const project = createSampleProject()
  const density = project.resolution.texelDensity
  // The terrain set is not baked: `generatePlaceholderTerrainSet` draws it without a canvas, so a headless consumer makes its own.
  const sprites = generateSprites(density)

  const files: Record<string, string> = {}
  const manifest: BakeManifest = {
    source: 'createSampleProject() in packages/fixtures/src/sample.ts, drawn by packages/fixtures/src/textures.ts',
    regenerate: 'pnpm bake',
    texelDensity: density,
    materials: project.materials.map(({ name, color }) => ({ name, color })),
    sprites: {},
  }

  for (const asset of Object.values(sprites)) {
    const first: RgbaImage = asset.facings[0]
    const facings = asset.facings.map((facing, index) => {
      const file = `sprites/${asset.name}.${index}.png`
      files[file] = rgbaToDataUrl(facing)
      return file
    })
    manifest.sprites[asset.name] = {
      widthTiles: asset.widthTiles,
      heightTiles: asset.heightTiles,
      emissive: asset.emissive,
      frame: { width: first.width, height: first.height },
      facings,
    }
  }

  return { manifest, files }
}

function show(result: BakeResult): void {
  const root = document.getElementById('bake')
  if (!root) return
  const section = (title: string, paths: string[]) => {
    const heading = document.createElement('h2')
    heading.textContent = title
    root.append(heading)
    for (const path of paths) {
      const img = document.createElement('img')
      img.src = result.files[path]
      img.title = path
      // Scaled up so a 16px tile reads at desk distance; the PNG itself is 1:1.
      img.style.width = `${img.naturalWidth || 0}px`
      img.onload = () => {
        img.style.width = `${img.naturalWidth * 3}px`
      }
      root.append(img)
    }
  }
  for (const [name, sprite] of Object.entries(result.manifest.sprites)) {
    section(`${name} — ${sprite.facings.length} facing(s), ${sprite.frame.width}x${sprite.frame.height}`, sprite.facings)
  }
}

const result = bake()
show(result)
// The driver reads this back with `page.evaluate(() => window.__bake)`. The
// same hook shape App.tsx uses for its scripting handles: nothing in the page
// reads it.
;(window as unknown as { __bake?: BakeResult }).__bake = result
