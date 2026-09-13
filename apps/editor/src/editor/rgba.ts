/**
 * The editor's side of the texture boundary (#47).
 *
 * `runtime` speaks raw `RgbaImage`s and nothing else. The editor is the one
 * place with a real 2D canvas, so the conversions that need one live here:
 * back into a canvas for the tile palette's preview, and through a canvas for
 * the PNG encoder the exporter asks its caller to supply. Nothing below is
 * reachable from a package; it is composition-root glue.
 */

import type { RgbaImage } from '@papercut/document'

export function rgbaToCanvas(image: RgbaImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas unavailable')
  ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0)
  return canvas
}

export function rgbaToDataUrl(image: RgbaImage): string {
  return rgbaToCanvas(image).toDataURL()
}

/**
 * The browser's own PNG encoder, offered to `exportGltf` as its `encodePng`.
 * A headless caller passes a pure-JS encoder in its place; neither one is
 * something the runtime gets to choose.
 */
export async function encodePngWithCanvas(image: RgbaImage): Promise<Uint8Array> {
  const canvas = rgbaToCanvas(image)
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('PNG encoding failed'))), 'image/png')
  })
  return new Uint8Array(await blob.arrayBuffer())
}
