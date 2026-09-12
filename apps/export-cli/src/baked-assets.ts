/**
 * Turns the checked-in bake (`packages/fixtures/baked/`) into the `sheet` and
 * `sprites` `exportGltf` now requires as inputs (#47).
 *
 * The editor builds these live with `generateTerrainSheet` / `generateSprites`
 * (`@map-editor/fixtures`), which draw with a 2D canvas — the one thing this
 * app is proving it does not need (#48). The bake is that same output,
 * pre-rendered to PNG for exactly this situation; decoding it back to raw
 * RGBA is `fast-png`'s job, the pure-JS PNG codec this app carries so that
 * job never reaches for a canvas either.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { decode } from 'fast-png'

import type { RgbaImage, SpriteAsset } from '@map-editor/document'
import { bakedDir } from '@map-editor/fixtures'

/** The slice of `baked/manifest.json` this loader reads; see `baked.test.ts` for the rest of its shape. */
interface BakedManifest {
  sheet: { file: string }
  sprites: Record<
    string,
    {
      widthTiles: number
      heightTiles: number
      emissive: boolean
      facings: string[]
    }
  >
}

async function decodeRgba(path: string): Promise<RgbaImage> {
  const decoded = decode(await readFile(path))
  // The bake is always 8-bit RGBA (`scripts/bake-fixtures.mjs` writes exactly
  // what a canvas's `getImageData` returns), so a decode that came back any
  // other shape means the bake and this reader have drifted — surfacing that
  // here is better than feeding `atlasFor`/`rgbaTexture` bytes they will
  // silently misinterpret as something else.
  if (decoded.channels !== 4) {
    throw new Error(`export-cli: ${path} decoded with ${decoded.channels} channels, expected 4 (RGBA)`)
  }
  // `decode` may hand back a `Uint16Array` for a 16-bit PNG (not this one) or
  // a view that does not own its buffer; copying into a fresh
  // `Uint8ClampedArray` is what `RgbaImage` promises its `data` is.
  return { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data) }
}

/** Loads the sheet and every sprite the bake carries, keyed as `exportGltf` expects. */
export async function loadBakedAssets(): Promise<{ sheet: RgbaImage; sprites: Record<string, SpriteAsset> }> {
  const dir = bakedDir()
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as BakedManifest

  const sheet = await decodeRgba(join(dir, manifest.sheet.file))

  const sprites: Record<string, SpriteAsset> = {}
  for (const [name, sprite] of Object.entries(manifest.sprites)) {
    sprites[name] = {
      name,
      widthTiles: sprite.widthTiles,
      heightTiles: sprite.heightTiles,
      emissive: sprite.emissive,
      facings: await Promise.all(sprite.facings.map((file) => decodeRgba(join(dir, file)))),
    }
  }

  return { sheet, sprites }
}
