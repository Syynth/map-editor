/**
 * The placeholder art: the terrain set, the sprites and the sketch textures
 * the generators draw for the document's texel density.
 *
 * Generated once per change of what it is generated from, and shared: the
 * stage draws with it, export writes it. Each keeps the last result for the
 * inputs it was made from, so three regions asking for the same art get the
 * same images — which the runtime's texture cache is keyed by — rather than
 * three copies.
 *
 * A terrain set the artist loaded from files lives on the viewport actor and
 * is drawn beside the generated one until the document's texel density
 * changes.
 * When the artist can configure terrains and sheets live, this is the one
 * place that learns where the art comes from.
 */

import { useMemo } from 'react'

import type { ReadonlyMapDoc, RgbaImage, SpriteAsset } from '@papercut/document'
import { useDocumentSelector, useViewportSelector } from '@papercut/editor-host'
import { generatePlaceholderTerrainSet } from '@papercut/fixtures'
// Behind its own subpath (#48): the sprite generator draws with a canvas, and the package root stays DOM-free.
import { generateSketchTextures, generateSprites } from '@papercut/fixtures/textures'
import type { LoadedSet } from '@papercut/geometry'

/** The last result for the last inputs: enough, since the document has one texel density at a time. */
function lastOf<K extends readonly unknown[], V>(make: (...key: K) => V): (...key: K) => V {
  let last: { key: K; value: V } | null = null
  return (...key) => {
    if (last && last.key.length === key.length && last.key.every((part, i) => part === key[i])) return last.value
    const value = make(...key)
    last = { key, value }
    return value
  }
}

const terrainFor = lastOf((density: number): LoadedSet[] => [generatePlaceholderTerrainSet(density)])
const spritesFor = lastOf((density: number): Record<string, SpriteAsset> => generateSprites(density))
const texturesFor = lastOf((density: number): Record<string, RgbaImage> => generateSketchTextures(density))

export interface GeneratedArt {
  /** The placeholder terrain set, which the default materials point into. */
  readonly generatedTerrain: LoadedSet[]
  readonly sprites: Record<string, SpriteAsset>
  readonly textures: Record<string, RgbaImage>
}

/** The generated art for a document as it stands: for a click handler, which reads rather than subscribes. */
export function artFor(doc: ReadonlyMapDoc): GeneratedArt {
  return { generatedTerrain: terrainFor(doc.texelDensity), sprites: spritesFor(doc.texelDensity), textures: texturesFor(doc.texelDensity) }
}

export interface Art extends GeneratedArt {
  /** What the terrain draws with: the loaded terrain set if there is one, else the generated one. */
  readonly terrain: LoadedSet[]
  readonly terrainWarning: string | null
}

const densityOf = (doc: ReadonlyMapDoc): number => doc.texelDensity
const same = Object.is

/** The art, re-rendering only when what it is made from changes. */
export function useArt(): Art {
  const density = useDocumentSelector(densityOf, { equal: same })
  // The host holds what this app loaded, in the narrowest shape that says what it is; this is the one reader.
  const loaded = useViewportSelector((snapshot) => snapshot.context.loadedTerrain) as LoadedSet | null
  const terrainWarning = useViewportSelector((snapshot) => snapshot.context.terrainWarning)
  const generatedTerrain = terrainFor(density)
  // The loaded set joins the generated one rather than replacing it: the default materials point into the placeholder
  // sheet, and would draw as nothing without it. A set named like a generated one stands in for it.
  const terrain = useMemo(() => (loaded ? [...generatedTerrain.filter((s) => s.set.sheet !== loaded.set.sheet), loaded] : generatedTerrain), [loaded, generatedTerrain])
  return { terrain, generatedTerrain, sprites: spritesFor(density), textures: texturesFor(density), terrainWarning }
}
