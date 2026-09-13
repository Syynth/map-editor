/**
 * Loading an artist's own terrain set: a sheet PNG and the sidecar beside it.
 *
 * The sidecar says what every tile is (spec §2); the PNG is only pixels. The
 * two are picked together, because the editor cannot read a sibling file
 * from a browser file picker. The sheet is checked against the sidecar's own
 * size, not against any layout the editor expects — there is none — and a
 * tile size that differs from the map's texel density is reported rather
 * than rescaled, because a sheet authored at another density is the fastest
 * way to make pixel art in 3D look wrong (brief section 10).
 */

import type { ReadonlyMapDoc, RgbaImage } from '@papercut/document'
import { parseTerrainSet, type LoadedSet } from '@papercut/geometry'

export interface TerrainLoadResult {
  set: LoadedSet
  warning: string | null
}

function decode(file: File): Promise<RgbaImage> {
  const url = URL.createObjectURL(file)
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image()
    element.onload = () => resolve(element)
    element.onerror = () => reject(new Error(`Could not decode ${file.name}`))
    element.src = url
  })
    .then((image) => {
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('2D canvas unavailable')
      ctx.drawImage(image, 0, 0)
      // The canvas was only ever the decoder; what leaves is pixels.
      return { width: image.width, height: image.height, data: ctx.getImageData(0, 0, image.width, image.height).data }
    })
    .finally(() => URL.revokeObjectURL(url))
}

/** Load a terrain set from the files picked together: one `.terrain.json` (or `.json`) and one image. */
export async function loadTerrainSetFiles(files: readonly File[], doc: ReadonlyMapDoc): Promise<TerrainLoadResult> {
  const sidecar = files.find((f) => f.name.endsWith('.json'))
  const image = files.find((f) => !f.name.endsWith('.json'))
  if (!sidecar || !image) throw new Error('Pick the sheet PNG and its .terrain.json together.')
  const set = parseTerrainSet(JSON.parse(await sidecar.text()))
  const pixels = await decode(image)
  const expected = { width: set.columns * set.tile, height: set.rows * set.tile }
  if (pixels.width !== expected.width || pixels.height !== expected.height) {
    throw new Error(`${image.name} is ${pixels.width}x${pixels.height}, but ${sidecar.name} describes a ${set.columns}×${set.rows} sheet of ${set.tile}px tiles (${expected.width}x${expected.height}).`)
  }
  const warning =
    set.tile === doc.texelDensity
      ? null
      : `${sidecar.name} has ${set.tile}px tiles; this map is ${doc.texelDensity}px per tile. Set the map's texel density to ${set.tile} to match the art.`
  return { set: { set: { ...set, sheet: set.sheet || image.name }, image: pixels }, warning }
}
