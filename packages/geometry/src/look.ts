/**
 * The look: how a material becomes a terrain on a face (spec §2, §3).
 *
 * The mesher never sees a material index for what it is. It asks the look
 * for the terrain key a material's top or side is drawn with, and asks the
 * atlas for the tile at a corner. The look owns the atlas, whose priority
 * order is the map's material order, so a change to the materials or to
 * the loaded terrain sets is a new look and a fresh atlas, and nothing in
 * between caches a stale answer.
 */

import type { MaterialDef, TerrainRef } from '@papercut/document'

import { TerrainAtlas, terrainKey, type LoadedSet, type TerrainKey } from './atlas'

export interface TerrainLook {
  readonly atlas: TerrainAtlas
  /** The terrain drawing one face of a material, by the material's id: its side terrain on a side, its top terrain otherwise; `null` for an id the map does not have. */
  keyOf(material: number, side: boolean): TerrainKey | null
}

const keyFor = (ref: TerrainRef): TerrainKey => terrainKey(ref.sheet, ref.terrain)

export function createTerrainLook(materials: readonly MaterialDef[], sets: readonly LoadedSet[]): TerrainLook {
  const top = materials.map((m) => keyFor(m.top))
  const side = materials.map((m) => keyFor(m.side ?? m.top))
  // A terrain's priority is the first material it is the top of; one that is only ever a side takes the first
  // material whose side it is. Later in the list draws over earlier in a composite.
  const topOf = new Map<TerrainKey, number>()
  const sideOf = new Map<TerrainKey, number>()
  materials.forEach((_, index) => {
    if (!topOf.has(top[index])) topOf.set(top[index], index)
    if (!sideOf.has(side[index])) sideOf.set(side[index], index)
  })
  const priority = (key: TerrainKey): number => topOf.get(key) ?? sideOf.get(key) ?? -1
  // The colour a terrain falls back to when its sheet is not loaded: the swatch of the first material that names it.
  const colorOf = (key: TerrainKey): number | null => {
    const index = topOf.get(key) ?? sideOf.get(key)
    return index === undefined ? null : materials[index].color
  }
  const byId = new Map(materials.map((m, index) => [m.id, index]))
  return {
    atlas: new TerrainAtlas(sets, priority, colorOf),
    keyOf: (material, isSide) => {
      const index = byId.get(material)
      return index === undefined ? null : isSide ? side[index] : top[index]
    },
  }
}
