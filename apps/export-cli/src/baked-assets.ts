/**
 * Turns the checked-in bake (`packages/fixtures/baked/`) into the `sprites`
 * `exportGltf` requires as an input (#47).
 *
 * The editor builds these live with `generateSprites` (`@papercut/fixtures`),
 * which draws with a 2D canvas — the one thing this app is proving it does
 * not need (#48). The bake is that same output, pre-rendered to PNG for
 * exactly this situation; decoding it back to raw RGBA is `fast-png`'s job,
 * the pure-JS PNG codec this app carries so that job never reaches for a
 * canvas either. The terrain set needs no bake: `generatePlaceholderTerrainSet`
 * draws it without a canvas, so `export-map.ts` makes it on the spot.
 */

import { readFile } from 'node:fs/promises'

import { decode } from 'fast-png'

import type { RgbaImage, SpriteAsset } from '@papercut/document'
import { bakedDir } from '@papercut/fixtures'

/** The slice of `baked/manifest.json` this loader reads; see `baked.test.ts` for the rest of its shape. */
interface BakedManifest {
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

async function decodeRgba(fileUrl: URL): Promise<RgbaImage> {
  const decoded = decode(await readFile(fileUrl))
  // The bake is always 8-bit RGBA (`scripts/bake-fixtures.mjs` writes exactly
  // what a canvas's `getImageData` returns), so a decode that came back any
  // other shape means the bake and this reader have drifted — surfacing that
  // here is better than feeding `atlasFor`/`rgbaTexture` bytes they will
  // silently misinterpret as something else.
  if (decoded.channels !== 4) {
    throw new Error(`export-cli: ${fileUrl.href} decoded with ${decoded.channels} channels, expected 4 (RGBA)`)
  }
  // Channel count alone doesn't rule out a 16-bit-per-channel RGBA PNG: `decode`
  // hands those back as a `Uint16Array` still sized for 4 channels, and
  // `new Uint8ClampedArray(uint16)` CLAMPS each element to 0-255 instead of
  // scaling it down (a 16-bit 0x0100 becomes 255, not 1) — silently wrong
  // pixels, not a thrown error. The bake is always 8-bit, so require it.
  if (decoded.depth !== 8) {
    throw new Error(`export-cli: ${fileUrl.href} decoded at ${decoded.depth}-bit depth, expected 8`)
  }
  // A view that does not own its buffer is copied into a fresh
  // `Uint8ClampedArray`, which is what `RgbaImage` promises its `data` is.
  return { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data) }
}

/** Loads every sprite the bake carries, keyed as `exportGltf` expects. The terrain set is generated, not baked. */
export async function loadBakedAssets(): Promise<{ sprites: Record<string, SpriteAsset> }> {
  const dir = bakedDir()
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dir), 'utf8')) as BakedManifest

  const sprites: Record<string, SpriteAsset> = {}
  for (const [name, sprite] of Object.entries(manifest.sprites)) {
    sprites[name] = {
      name,
      widthTiles: sprite.widthTiles,
      heightTiles: sprite.heightTiles,
      emissive: sprite.emissive,
      facings: await Promise.all(sprite.facings.map((file) => decodeRgba(new URL(file, dir)))),
    }
  }

  return { sprites }
}
