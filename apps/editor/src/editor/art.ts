/**
 * The placeholder art: the terrain set, the sprites and the sketch textures
 * the generators draw for the project's texel density.
 *
 * Generated once per change of what it is generated from, and shared: the
 * stage draws with it, export writes it. Each keeps the last result for the
 * inputs it was made from, so three regions asking for the same art get the
 * same images — which the runtime's texture cache is keyed by — rather than
 * three copies.
 *
 * The project's own sheets, loaded from its folder, live on the viewport
 * actor; they are drawn beside the generated placeholder, standing in for it
 * where they share a name. A sheet at another tile size than the profile's
 * is left out here — the atlas is one tile size — and reported by the
 * project settings instead.
 * When the artist can configure terrains and sheets live, this is the one
 * place that learns where the art comes from.
 */

import { useMemo } from 'react'

import type { ReadonlyProjectDoc, RgbaImage, SpriteAsset } from '@papercut/document'
import { useProject, useViewportSelector } from '@papercut/editor-host'
import { generatePlaceholderTerrainSet } from '@papercut/fixtures'
// Behind its own subpath (#48): the sprite generator draws with a canvas, and the package root stays DOM-free.
import { generateSketchTextures, generateSprites } from '@papercut/fixtures/textures'
import type { LoadedSet } from '@papercut/geometry'

/** The last result for the last inputs: enough, since the project has one texel density at a time. */
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

/** The generated art for a project as it stands: for a click handler, which reads rather than subscribes. */
export function artFor(project: ReadonlyProjectDoc): GeneratedArt {
  const density = project.resolution.texelDensity
  return { generatedTerrain: terrainFor(density), sprites: spritesFor(density), textures: texturesFor(density) }
}

export interface Art extends GeneratedArt {
  /** What the terrain draws with: the project's sheets at the profile's tile size, the generated placeholder standing in for what is missing. */
  readonly terrain: LoadedSet[]
  /** The project's sheets as they loaded, every tile size, for the settings to list. */
  readonly loadedTerrain: readonly LoadedSet[]
  readonly terrainWarning: string | null
}

const densityOf = (project: ReadonlyProjectDoc): number => project.resolution.texelDensity

/** The art, re-rendering only when what it is made from changes. */
export function useArt(): Art {
  const density = useProject(densityOf)
  // The host holds what this app loaded, in the narrowest shape that says what it is; this is the one reader.
  const loaded = useViewportSelector((snapshot) => snapshot.context.loadedTerrain) as readonly LoadedSet[]
  const terrainWarning = useViewportSelector((snapshot) => snapshot.context.terrainWarning)
  const generatedTerrain = terrainFor(density)
  // The loaded sets join the generated one rather than replacing it: the default materials point into the placeholder
  // sheet, and would draw as nothing without it. A set named like a generated one stands in for it.
  const terrain = useMemo(() => {
    const usable = loaded.filter((s) => s.set.tile === density)
    if (usable.length === 0) return generatedTerrain
    const names = new Set(usable.map((s) => s.set.sheet))
    return [...generatedTerrain.filter((s) => !names.has(s.set.sheet)), ...usable]
  }, [loaded, generatedTerrain, density])
  return { terrain, loadedTerrain: loaded, generatedTerrain, sprites: spritesFor(density), textures: texturesFor(density), terrainWarning }
}
