/**
 * Loading an artist's own template sheet.
 *
 * This is where brief section 10's resolution profile earns its keep. A sheet
 * authored at a different texel density than the map is the fastest way to
 * make pixel art in 3D look wrong, so the editor checks the dimensions against
 * the layout the template expects and says something rather than silently
 * stretching the art.
 *
 * When the mismatch is a whole-number ratio, nearest-neighbour rescaling is
 * offered, which is lossless for pixel art in the upward direction and at
 * least predictable downward.
 */

import { BLOCK_COLUMNS, BLOCK_ROWS } from '@map-editor/geometry'
import type { MapDoc } from '@map-editor/document'

export interface SheetLoadResult {
  canvas: HTMLCanvasElement
  /** Density the file appears to have been authored at. */
  detectedDensity: number
  warning: string | null
  rescaled: boolean
}

export function expectedSheetSize(doc: MapDoc): { width: number; height: number } {
  return {
    width: doc.materials.length * BLOCK_COLUMNS * doc.texelDensity,
    height: BLOCK_ROWS * doc.texelDensity,
  }
}

function drawTo(image: HTMLImageElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas unavailable')
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(image, 0, 0, width, height)
  return canvas
}

export async function loadSheetFromFile(file: File, doc: MapDoc): Promise<SheetLoadResult> {
  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error(`Could not decode ${file.name}`))
      element.src = url
    })

    const expected = expectedSheetSize(doc)
    const columns = doc.materials.length * BLOCK_COLUMNS
    const detectedDensity = image.width / columns

    if (image.width === expected.width && image.height === expected.height) {
      return { canvas: drawTo(image, image.width, image.height), detectedDensity, warning: null, rescaled: false }
    }

    const ratio = expected.width / image.width
    const sameShape =
      Math.abs(image.width / image.height - expected.width / expected.height) < 0.001
    const wholeRatio = Number.isInteger(ratio) || Number.isInteger(1 / ratio)

    if (sameShape && wholeRatio) {
      return {
        canvas: drawTo(image, expected.width, expected.height),
        detectedDensity,
        warning:
          `Sheet was authored at ${detectedDensity}px per tile; this map is ${doc.texelDensity}px. ` +
          `Rescaled by ${ratio > 1 ? `${ratio}x` : `1/${1 / ratio}`} with nearest neighbour.`,
        rescaled: true,
      }
    }

    return {
      canvas: drawTo(image, expected.width, expected.height),
      detectedDensity,
      warning:
        `Sheet is ${image.width}x${image.height}, but this map's template expects ` +
        `${expected.width}x${expected.height} (${doc.materials.length} materials x ${BLOCK_COLUMNS} ` +
        `columns x ${doc.texelDensity}px). Stretched to fit — expect it to look wrong. ` +
        `Set the map's texel density to ${Math.round(detectedDensity)} to match the art.`,
      rescaled: true,
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}
