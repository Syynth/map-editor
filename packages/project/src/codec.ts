/**
 * How a sheet's pixels get to and from disk.
 *
 * A PNG needs a decoder, and the decoders differ by host: the editor has a
 * canvas, the export CLI has `fast-png`, a test wants neither. So the codec
 * is handed in, and this package never names a PNG library. `rawImageCodec`
 * is the test's: eight bytes of size, then the pixels, nothing compressed.
 */

import type { RgbaImage } from '@papercut/document'

export interface ImageCodec {
  encode(image: RgbaImage): Promise<Uint8Array>
  decode(bytes: Uint8Array): Promise<RgbaImage>
}

export const rawImageCodec: ImageCodec = {
  encode(image) {
    const out = new Uint8Array(8 + image.data.length)
    new DataView(out.buffer).setUint32(0, image.width, true)
    new DataView(out.buffer).setUint32(4, image.height, true)
    out.set(image.data, 8)
    return Promise.resolve(out)
  },
  decode(bytes) {
    if (bytes.length < 8) return Promise.reject(new Error('Not an image.'))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const width = view.getUint32(0, true)
    const height = view.getUint32(4, true)
    if (bytes.length !== 8 + width * height * 4) return Promise.reject(new Error('Not an image: the size does not match the pixels.'))
    const data = new Uint8ClampedArray(width * height * 4)
    data.set(bytes.subarray(8))
    return Promise.resolve({ width, height, data })
  },
}
