/**
 * Pixel plumbing for export: compositing facings into an atlas, and getting
 * PNG bytes into a glTF without three ever seeing a canvas.
 *
 * Both used to be `drawImage` / `toBlob` calls. They are typed-array loops now
 * because the boundary this package sits behind is raw RGBA (#47): the only
 * thing export still needs that a typed array cannot do is PNG compression,
 * and that one step is injected by the caller rather than reached for here.
 */

import * as THREE from 'three'
import type { GLTFExporterPlugin, GLTFWriter } from 'three/examples/jsm/exporters/GLTFExporter.js'

import type { RgbaImage, SpriteAsset } from '@map-editor/document'

/**
 * The one operation the runtime cannot do over raw pixels. The editor passes a
 * canvas-backed encoder; a headless caller passes a pure-JS one (per the
 * 2026-09-11 no-native-binaries ruling, never a native one).
 */
export type PngEncoder = (image: RgbaImage) => Promise<Uint8Array>

/**
 * Pack an object's facings side by side into one atlas, frame `i` at
 * `x = i * frameWidth`. The runtime picks a facing by shifting UVs, which is
 * why the layout is a strip rather than a grid — see `spriteExtras`.
 *
 * Every facing a sprite ships is the same size, but the copy clips to the
 * first frame's box anyway, which is exactly what `drawImage` onto a
 * first-frame-sized canvas did before.
 */
export function atlasFor(asset: SpriteAsset): RgbaImage {
  if (asset.facings.length === 1) return asset.facings[0]
  const first = asset.facings[0]
  const width = first.width * asset.facings.length
  const data = new Uint8ClampedArray(width * first.height * 4)
  asset.facings.forEach((facing, index) => {
    const rows = Math.min(facing.height, first.height)
    const columns = Math.min(facing.width, first.width)
    for (let y = 0; y < rows; y++) {
      const from = y * facing.width * 4
      data.set(facing.data.subarray(from, from + columns * 4), (y * width + index * first.width) * 4)
    }
  })
  return { width, height: first.height, data }
}

/** Top row becomes bottom row; the pixel order within a row is untouched. */
export function flipRows(image: RgbaImage): RgbaImage {
  const stride = image.width * 4
  const data = new Uint8ClampedArray(image.data.length)
  for (let y = 0; y < image.height; y++) {
    data.set(image.data.subarray(y * stride, (y + 1) * stride), (image.height - 1 - y) * stride)
  }
  return { width: image.width, height: image.height, data }
}

/** glTF requires every buffer view to start on a 4-byte boundary. */
function padToFour(bytes: Uint8Array): ArrayBuffer {
  const length = Math.ceil(bytes.byteLength / 4) * 4
  const padded = new Uint8Array(length)
  padded.set(bytes)
  return padded.buffer
}

/**
 * What a `DataTexture` carries as its `image`. `rgbaTexture` hands the GPU a
 * `Uint8Array` view, so the bytes come back here as one; the encoder wants the
 * `Uint8ClampedArray` the boundary is typed in, and a view is free either way.
 */
interface TextureImage {
  width: number
  height: number
  data: Uint8Array<ArrayBuffer> | Uint8ClampedArray<ArrayBuffer>
}

function isTextureImage(image: unknown): image is TextureImage {
  if (typeof image !== 'object' || image === null) return false
  const candidate = image as Partial<TextureImage>
  return (
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    (candidate.data instanceof Uint8Array || candidate.data instanceof Uint8ClampedArray)
  )
}

interface ImageDef {
  mimeType: string
  bufferView?: number
}

interface BufferViewDef {
  buffer: number
  byteOffset: number
  byteLength: number
}

/**
 * The slice of `GLTFWriter` the override below touches. three's typings stop
 * at the plugin hooks, and no hook runs *instead of* `processImage` — every
 * hook runs after the writer has already drawn the image onto its own canvas
 * (GLTFExporter.js, `processTextureAsync` → `processImage`, three 0.186.0).
 * The plugin factory does receive the writer itself, though, so replacing the
 * method on the instance is the one seam that exists. These five members are
 * what three's own `processBufferViewImage` uses to land an image — named
 * here so the override reads like it targets a typed API, but the writer
 * only reaches this file as `writer as unknown as WriterInternals`, an
 * unchecked cast. A three upgrade that renames one of these does not fail to
 * compile: it fails as a `TypeError` thrown mid-export, inside the promise
 * `writeAsync` awaits, which three's own `.catch(onError)` swallows into
 * whatever `onError` does with it. The real-writer test in `images.test.ts`
 * exists to catch that drift some other way.
 */
export interface WriterInternals {
  json: { images?: ImageDef[]; bufferViews?: BufferViewDef[] }
  pending: Promise<unknown>[]
  byteOffset: number
  processBuffer(buffer: ArrayBuffer): number
  processImage(image: unknown, format: number, flipY: boolean, mimeType?: string): number
}

/**
 * A `GLTFExporter` plugin that embeds every texture through `encodePng`.
 *
 * `GLTFWriter.processImage` draws the texture onto a 2D canvas and calls
 * `toBlob` on it, whatever the texture's source — a `DataTexture` included.
 * That is the last canvas between a document and a `.glb`, and it is here
 * rather than in `exportGltf` so it can be exercised against a stand-in writer
 * without mocking the exporter wholesale.
 *
 * `flipY` is NOT honoured the way three honours it for a `DataTexture`: three's
 * own `processImage` draws one with `ctx.putImageData` (GLTFExporter.js:1496),
 * which ignores the `ctx.translate` / `ctx.scale` flip it sets up for `flipY`
 * just above (1465–1467) — three never actually flips a `DataTexture`. The
 * flip here instead preserves the orientation the pre-#47 `CanvasTexture` /
 * `drawImage` path produced, which is what the mesher's UVs are still built
 * against. Do not "simplify" this to match three's (non-)behavior — the two
 * are unrelated; this one exists for the mesher, not for parity with three.
 */
export function embedPngImages(encodePng: PngEncoder): (writer: GLTFWriter) => GLTFExporterPlugin {
  return (writer) => {
    const internals = writer as unknown as WriterInternals
    // Same texture image, same orientation, same glTF image — three's own
    // cache does this too, keyed the same way, so `map` and `emissiveMap`
    // pointing at one texture embed one PNG.
    const seen = new WeakMap<TextureImage, Map<boolean, number>>()

    internals.processImage = (image, format, flipY) => {
      if (!isTextureImage(image)) {
        throw new Error('glTF export: every texture must be a DataTexture over RGBA bytes (see rgbaTexture)')
      }
      if (format !== THREE.RGBAFormat) {
        throw new Error(`glTF export: only RGBAFormat textures can be encoded as PNG, got ${format}`)
      }

      const variants = seen.get(image) ?? new Map<boolean, number>()
      seen.set(image, variants)
      const cached = variants.get(flipY)
      if (cached !== undefined) return cached

      const json = internals.json
      json.images ??= []
      const imageDef: ImageDef = { mimeType: 'image/png' }
      const index = json.images.push(imageDef) - 1
      variants.set(flipY, index)

      const rgba: RgbaImage = {
        width: image.width,
        height: image.height,
        data: new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.byteLength),
      }
      internals.pending.push(
        encodePng(flipY ? flipRows(rgba) : rgba).then((png) => {
          const buffer = padToFour(png)
          json.bufferViews ??= []
          const view: BufferViewDef = {
            buffer: internals.processBuffer(buffer),
            byteOffset: internals.byteOffset,
            byteLength: buffer.byteLength,
          }
          internals.byteOffset += buffer.byteLength
          imageDef.bufferView = json.bufferViews.push(view) - 1
        }),
      )
      return index
    }

    return {}
  }
}
