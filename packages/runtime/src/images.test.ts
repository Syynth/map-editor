import { describe, expect, it } from 'vitest'

import * as THREE from 'three'
import { GLTFExporter, type GLTFWriter } from 'three/examples/jsm/exporters/GLTFExporter.js'

import type { RgbaImage, SpriteAsset } from '@papercut/document'
import { rgbaTexture } from './billboard'
import { atlasFor, embedPngImages, flipRows, type WriterInternals } from './images'

/** `width` x `height`, each pixel's red channel = column, green = row. */
function gradient(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set([x, y, 0, 255], (y * width + x) * 4)
    }
  }
  return { width, height, data }
}

function pixel(image: RgbaImage, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4
  return [...image.data.subarray(at, at + 4)]
}

function asset(facings: RgbaImage[]): SpriteAsset {
  return { name: 'thing', facings, widthTiles: 1, heightTiles: 1, emissive: false }
}

describe('atlasFor', () => {
  it('hands a single facing back untouched', () => {
    const only = gradient(3, 2)
    expect(atlasFor(asset([only]))).toBe(only)
  })

  it('lays facings out as a horizontal strip, frame i at x = i * frameWidth', () => {
    const a = gradient(3, 2)
    const b = gradient(3, 2)
    b.data.fill(200, 0, 4) // mark b's top-left pixel so the frames are distinguishable
    const atlas = atlasFor(asset([a, b]))

    expect(atlas.width).toBe(6)
    expect(atlas.height).toBe(2)
    expect(pixel(atlas, 0, 0)).toEqual([0, 0, 0, 255])
    expect(pixel(atlas, 2, 1)).toEqual([2, 1, 0, 255])
    expect(pixel(atlas, 3, 0)).toEqual([200, 200, 200, 200])
    expect(pixel(atlas, 5, 1)).toEqual([2, 1, 0, 255])
  })

  it('clips a mis-sized facing to the first frame, as drawImage onto that canvas did', () => {
    const first = gradient(2, 2)
    const wide = gradient(4, 3)
    const atlas = atlasFor(asset([first, wide]))
    expect(atlas.width).toBe(4)
    expect(atlas.height).toBe(2)
    expect(pixel(atlas, 3, 1)).toEqual([1, 1, 0, 255])
  })
})

describe('flipRows', () => {
  it('reverses row order and leaves each row intact', () => {
    const flipped = flipRows(gradient(3, 2))
    expect(pixel(flipped, 0, 0)).toEqual([0, 1, 0, 255])
    expect(pixel(flipped, 2, 1)).toEqual([2, 0, 0, 255])
  })
})

describe('rgbaTexture', () => {
  it("uploads the caller's bytes with the orientation a canvas texture had", () => {
    const image = gradient(2, 2)
    const texture = rgbaTexture(image, true)
    expect(texture).toBeInstanceOf(THREE.DataTexture)
    expect(texture.flipY).toBe(true)
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(texture.magFilter).toBe(THREE.NearestFilter)
    expect((texture.image as { data: Uint8Array }).data.buffer).toBe(image.data.buffer)
  })

  it('caches by image identity and re-applies the filter on a hit', () => {
    const image = gradient(2, 2)
    const nearest = rgbaTexture(image, true)
    const linear = rgbaTexture(image, false)
    expect(linear).toBe(nearest)
    expect(linear.magFilter).toBe(THREE.LinearFilter)
  })
})

/**
 * The parts of `GLTFWriter` the plugin drives, as three's `processImage`
 * finds them on a fresh writer. Standing in for the real one because the real
 * one's binary path needs `FileReader`, which Node does not have — that is
 * why `exportGltf` itself is only tested with the exporter mocked.
 */
function fakeWriter() {
  const buffers: ArrayBuffer[] = []
  const internals: WriterInternals = {
    json: {},
    pending: [],
    byteOffset: 0,
    processBuffer(buffer) {
      buffers.push(buffer)
      return 0
    },
    processImage() {
      throw new Error("three's own processImage ran: the override was not installed")
    },
  }
  return { internals, buffers, writer: internals as unknown as GLTFWriter }
}

describe('embedPngImages', () => {
  it('replaces processImage so no canvas is ever asked for', async () => {
    const encoded: RgbaImage[] = []
    const { internals, buffers, writer } = fakeWriter()
    embedPngImages((image) => {
      encoded.push(image)
      return Promise.resolve(new Uint8Array([1, 2, 3, 4, 5]))
    })(writer)

    const texture = rgbaTexture(gradient(2, 2), true)
    const index = internals.processImage(texture.image, texture.format, false)
    await Promise.all(internals.pending)

    expect(index).toBe(0)
    expect(encoded).toHaveLength(1)
    expect(internals.json.images).toEqual([{ mimeType: 'image/png', bufferView: 0 }])
    // Five bytes of PNG padded to the 4-byte alignment glTF requires.
    expect(internals.json.bufferViews).toEqual([{ buffer: 0, byteOffset: 0, byteLength: 8 }])
    expect([...new Uint8Array(buffers[0])]).toEqual([1, 2, 3, 4, 5, 0, 0, 0])
    expect(internals.byteOffset).toBe(8)
  })

  it('reverses rows for a flipY texture, the way three does before encoding', async () => {
    const encoded: RgbaImage[] = []
    const { internals, writer } = fakeWriter()
    embedPngImages((image) => {
      encoded.push(image)
      return Promise.resolve(new Uint8Array(4))
    })(writer)

    const texture = rgbaTexture(gradient(2, 2), true)
    internals.processImage(texture.image, texture.format, texture.flipY)
    await Promise.all(internals.pending)

    expect(pixel(encoded[0], 0, 0)).toEqual([0, 1, 0, 255])
  })

  it('embeds one image per (bytes, orientation), so map and emissiveMap share a PNG', async () => {
    let calls = 0
    const { internals, writer } = fakeWriter()
    embedPngImages(() => {
      calls++
      return Promise.resolve(new Uint8Array(4))
    })(writer)

    const texture = rgbaTexture(gradient(2, 2), true)
    const first = internals.processImage(texture.image, texture.format, true)
    const again = internals.processImage(texture.image, texture.format, true)
    const other = internals.processImage(texture.image, texture.format, false)
    await Promise.all(internals.pending)

    expect(again).toBe(first)
    expect(other).not.toBe(first)
    expect(calls).toBe(2)
  })

  it('refuses a texture that is not RGBA bytes rather than guessing', () => {
    const { internals, writer } = fakeWriter()
    embedPngImages(() => Promise.resolve(new Uint8Array(4)))(writer)
    expect(() => internals.processImage({ src: 'x' }, THREE.RGBAFormat, false)).toThrow(/DataTexture/)
    expect(() => internals.processImage(gradient(1, 1), THREE.RedFormat, false)).toThrow(/RGBAFormat/)
  })
})

describe('WriterInternals', () => {
  it("matches a real GLTFWriter's shape at the point a plugin registers", () => {
    // The cast to `WriterInternals` is unchecked (see the doc comment on the
    // interface), so nothing here is compile-checked against three's actual
    // writer. This pins the real shape down at runtime instead. `parse` runs
    // every plugin factory synchronously, before `writeAsync`, so the writer
    // can be captured with no `FileReader` shim and without waiting for (or
    // needing) export to finish — it would reject for lack of one, and
    // three's own `.catch(onError)` swallows that.
    let captured: WriterInternals | undefined
    const exporter = new GLTFExporter()
    exporter.register((writer) => {
      captured = writer as unknown as WriterInternals
      return {}
    })
    exporter.parse(
      new THREE.Scene(),
      () => {},
      () => {},
      { binary: true },
    )

    expect(typeof captured?.processImage).toBe('function')
    expect(Array.isArray(captured?.pending)).toBe(true)
    expect(typeof captured?.byteOffset).toBe('number')
    expect(typeof captured?.processBuffer).toBe('function')
    expect(typeof captured?.json).toBe('object')
  })
})
