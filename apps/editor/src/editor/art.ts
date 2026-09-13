/**
 * The placeholder art: the terrain sheet, the sprites and the sketch textures
 * the generator draws for the document's materials and texel density.
 *
 * Generated once per change of what it is generated from, and shared: the
 * stage draws with it, the inspector's tile palette shows the sheet, and
 * export writes it. Each keeps the last result for the inputs it was made
 * from, so three regions asking for the same art get the same images — which
 * the runtime's texture cache is keyed by — rather than three copies.
 *
 * A sheet the artist loaded from a file lives on the viewport actor and wins
 * over the generated one until the document's materials change. When the
 * artist can configure terrains and textures live, this is the one place
 * that learns where the art comes from.
 */

import type { ReadonlyMapDoc, RgbaImage, SpriteAsset } from '@papercut/document'
import { useDocumentSelector, useViewportSelector } from '@papercut/editor-host'
// Behind its own subpath (#48): the generator draws with a canvas, and the package root stays DOM-free.
import { generateSketchTextures, generateSprites, generateTerrainSheet } from '@papercut/fixtures/textures'

type Materials = ReadonlyMapDoc['materials']

/** The last result for the last inputs: enough, since the document has one set of materials at a time. */
function lastOf<K extends readonly unknown[], V>(make: (...key: K) => V): (...key: K) => V {
  let last: { key: K; value: V } | null = null
  return (...key) => {
    if (last && last.key.length === key.length && last.key.every((part, i) => part === key[i])) return last.value
    const value = make(...key)
    last = { key, value }
    return value
  }
}

const sheetFor = lastOf((materials: Materials, density: number): RgbaImage => generateTerrainSheet(materials, density))
const spritesFor = lastOf((density: number): Record<string, SpriteAsset> => generateSprites(density))
const texturesFor = lastOf((density: number): Record<string, RgbaImage> => generateSketchTextures(density))

export interface GeneratedArt {
  readonly generatedSheet: RgbaImage
  readonly sprites: Record<string, SpriteAsset>
  readonly textures: Record<string, RgbaImage>
}

/** The generated art for a document as it stands: for a click handler, which reads rather than subscribes. */
export function artFor(doc: ReadonlyMapDoc): GeneratedArt {
  return { generatedSheet: sheetFor(doc.materials, doc.texelDensity), sprites: spritesFor(doc.texelDensity), textures: texturesFor(doc.texelDensity) }
}

export interface Art extends GeneratedArt {
  /** What the terrain draws with: the loaded sheet if there is one, else the generated one. */
  readonly sheet: RgbaImage
  readonly sheetWarning: string | null
}

const materialsOf = (doc: ReadonlyMapDoc): Materials => doc.materials
const densityOf = (doc: ReadonlyMapDoc): number => doc.texelDensity
const same = Object.is

/** The art, re-rendering only when what it is made from changes. */
export function useArt(): Art {
  const materials = useDocumentSelector(materialsOf, { equal: same })
  const density = useDocumentSelector(densityOf, { equal: same })
  const loaded = useViewportSelector((snapshot) => snapshot.context.loadedSheet)
  const sheetWarning = useViewportSelector((snapshot) => snapshot.context.sheetWarning)
  const generatedSheet = sheetFor(materials, density)
  return { sheet: loaded ?? generatedSheet, generatedSheet, sprites: spritesFor(density), textures: texturesFor(density), sheetWarning }
}
