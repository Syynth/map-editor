/**
 * The runtime atlas: the one texture the terrain is drawn with (spec §3).
 *
 * It holds every authored tile of every terrain set the map uses, and one
 * baked tile per distinct corner combination nobody authored — a composite
 * of the terrains' edge sets in priority order. The mesher asks it two
 * things and nothing else: the tile for a corner's four terrains, and the
 * UV rectangle of one quadrant of a tile. It never composes pixels.
 *
 * Terrains are addressed across sets by key, `<sheet>/<terrain>`, so a map
 * can draw from several sheets. An exact tile can only come from one set,
 * where every terrain at the corner lives; a composite may mix sets.
 *
 * The atlas grows as strokes create combinations it has not seen. Growth
 * replaces `image` with a taller one and bumps `version`, which is what the
 * runtime keys its texture upload on. Nothing is ever moved: a tile id is
 * stable for the atlas's life, which is what lets a meshed chunk keep its
 * UVs while a neighbour grows the atlas.
 *
 * Pure RGBA over plain buffers: no canvas, so the meshing worker and a
 * headless export can build one.
 */

import type { RgbaImage } from '@papercut/document'

import { CORNER_BITS, exactTile, edgeTile, templateTags, type CornerTags, type TerrainSet } from './terrainset'

/** `<sheet>/<terrain>`: a terrain named across sets. */
export type TerrainKey = string

export function terrainKey(sheet: string, terrain: string): TerrainKey {
  return `${sheet}/${terrain}`
}

/** A terrain set and the pixels of its sheet. */
export interface LoadedSet {
  set: TerrainSet
  image: RgbaImage
}

/** The four terrains at a corner, in `CornerTags` order; `null` is nothing. */
export type CornerKeys = readonly [TerrainKey | null, TerrainKey | null, TerrainKey | null, TerrainKey | null]

export interface AtlasTile {
  tile: number
  /** Baked from edge sets because no tile is tagged for the combination. */
  composite: boolean
}

export interface CompositeReport {
  /** The distinct terrains at the corner, highest priority last, then "edge" when nothing is among them. */
  combo: string
  tile: number
}

const ATLAS_COLUMNS = 32

export class TerrainAtlas {
  readonly tile: number
  private rows = 0
  private next = 0
  private buffer: Uint8ClampedArray<ArrayBuffer>
  private byKey = new Map<string, AtlasTile>()
  private sheetTiles = new Map<string, number>() // `<sheet>:<index>` -> atlas tile
  private readonly sets = new Map<string, LoadedSet>()
  private composites: CompositeReport[] = []
  /** Bumps whenever `image` changes content or size. */
  version = 0

  /**
   * @param priority Where a terrain stands in the map's material order; a
   * higher number draws over a lower one in a composite. Unknown terrains
   * count as lowest.
   */
  constructor(sets: readonly LoadedSet[], private readonly priority: (key: TerrainKey) => number) {
    const tile = sets[0]?.set.tile ?? 16
    for (const loaded of sets) {
      if (loaded.set.tile !== tile) throw new Error(`Terrain set ${loaded.set.sheet} has ${loaded.set.tile} px tiles; the atlas is ${tile} px.`)
      if (loaded.image.width !== loaded.set.columns * tile || loaded.image.height !== loaded.set.rows * tile) {
        throw new Error(`Sheet ${loaded.set.sheet} is ${loaded.image.width}×${loaded.image.height} px; its terrain set says ${loaded.set.columns * tile}×${loaded.set.rows * tile}.`)
      }
      this.sets.set(loaded.set.sheet, loaded)
    }
    this.tile = tile
    this.buffer = new Uint8ClampedArray(0)
    // Every tagged tile of every set is in the atlas from the start, so an exact answer never grows it.
    for (const loaded of sets) for (const index of loaded.set.tiles.keys()) this.sheetTile(loaded, index)
  }

  get image(): RgbaImage {
    return { width: ATLAS_COLUMNS * this.tile, height: Math.max(1, this.rows) * this.tile, data: this.buffer }
  }

  /** The tile for a corner: exact when a set has it, else a composite baked on first sight. */
  tileFor(keys: CornerKeys): AtlasTile {
    const cacheKey = keys.map((k) => k ?? '').join('|')
    const cached = this.byKey.get(cacheKey)
    if (cached) return cached
    const answer = this.resolve(keys)
    this.byKey.set(cacheKey, answer)
    return answer
  }

  /** UV rectangle [u0, v0, u1, v1] of quadrant `q` (0 NW, 1 NE, 2 SW, 3 SE) of a tile, or the whole tile for -1; v from the bottom the way GL samples. */
  uv(tile: number, quadrant: number): [number, number, number, number] {
    const column = tile % ATLAS_COLUMNS
    const row = Math.floor(tile / ATLAS_COLUMNS)
    const rows = Math.max(1, this.rows)
    const half = quadrant < 0 ? 1 : 0.5
    const qx = quadrant < 0 ? 0 : quadrant % 2 ? 0.5 : 0
    const qy = quadrant < 0 ? 0 : quadrant > 1 ? 0.5 : 0
    const insetU = 0.5 / (ATLAS_COLUMNS * this.tile)
    const insetV = 0.5 / (rows * this.tile)
    const u0 = (column + qx) / ATLAS_COLUMNS + insetU
    const u1 = (column + qx + half) / ATLAS_COLUMNS - insetU
    const v1 = 1 - (row + qy) / rows - insetV
    const v0 = 1 - (row + qy + half) / rows + insetV
    return [u0, v0, u1, v1]
  }

  /** Every composite baked so far: the artist's list of transitions to draw. */
  compositeReport(): readonly CompositeReport[] {
    return this.composites
  }

  private resolve(keys: CornerKeys): AtlasTile {
    const terrains = [...new Set(keys.filter((k): k is TerrainKey => k !== null))]
    if (terrains.length === 0) return { tile: this.blankTile(), composite: false }
    // An exact tile lives in one set, where every terrain at the corner is.
    const sheets = new Set(terrains.map((k) => k.slice(0, k.lastIndexOf('/'))))
    if (sheets.size === 1) {
      const loaded = this.sets.get([...sheets][0])
      if (loaded) {
        const tags = keys.map((k) => (k === null ? null : k.slice(k.lastIndexOf('/') + 1))) as unknown as CornerTags
        const index = exactTile(loaded.set, tags)
        if (index !== null) return { tile: this.sheetTile(loaded, index), composite: false }
      }
    }
    return { tile: this.composite(keys, terrains), composite: true }
  }

  /** The atlas tile holding a sheet's tile, copied in on first use. */
  private sheetTile(loaded: LoadedSet, index: number): number {
    const key = `${loaded.set.sheet}:${index}`
    const known = this.sheetTiles.get(key)
    if (known !== undefined) return known
    const tile = this.allocate()
    const sx = (index % loaded.set.columns) * this.tile
    const sy = Math.floor(index / loaded.set.columns) * this.tile
    this.blit(loaded.image, sx, sy, tile, null, false)
    this.sheetTiles.set(key, tile)
    return tile
  }

  private blank: number | null = null

  private blankTile(): number {
    if (this.blank === null) this.blank = this.allocate()
    return this.blank
  }

  /**
   * Bake a corner nobody drew: the lowest terrain from its edge set, masked
   * to the corners that are not nothing, then each higher terrain's edge
   * tile over it. A terrain with no edge tile for a mask lends its full
   * tile, clipped to its own corners.
   */
  private composite(keys: CornerKeys, terrains: TerrainKey[]): number {
    const ordered = terrains.slice().sort((a, b) => this.priority(a) - this.priority(b))
    const tile = this.allocate()
    const present = keys.reduce((mask, k, i) => (k === null ? mask : mask | CORNER_BITS[i]), 0)
    ordered.forEach((key, layer) => {
      const mask = layer === 0 ? present : keys.reduce((m, k, i) => (k === key ? m | CORNER_BITS[i] : m), 0)
      const sheet = key.slice(0, key.lastIndexOf('/'))
      const terrain = key.slice(key.lastIndexOf('/') + 1)
      const loaded = this.sets.get(sheet)
      if (!loaded) return
      const edge = edgeTile(loaded.set, terrain, mask)
      const source = edge ?? exactTile(loaded.set, templateTags(15, null, terrain))
      if (source === null) return
      const sx = (source % loaded.set.columns) * this.tile
      const sy = Math.floor(source / loaded.set.columns) * this.tile
      this.blit(loaded.image, sx, sy, tile, edge === null ? mask : null, true)
    })
    const names = ordered.map((k) => k.slice(k.lastIndexOf('/') + 1))
    if (present !== 15) names.push('edge')
    this.composites.push({ combo: names.join(' · '), tile })
    return tile
  }

  /** A fresh, transparent tile; grows the image by a row when the current one is full. */
  private allocate(): number {
    const tile = this.next++
    const rowsNeeded = Math.floor(tile / ATLAS_COLUMNS) + 1
    if (rowsNeeded > this.rows) {
      const grown = new Uint8ClampedArray(ATLAS_COLUMNS * this.tile * rowsNeeded * this.tile * 4)
      grown.set(this.buffer)
      this.buffer = grown
      this.rows = rowsNeeded
    }
    this.version += 1
    return tile
  }

  /** Copy one tile of `source` at (`sx`, `sy`) onto atlas tile `tile`: the quadrants in `mask` only (all when null), source-over when `over`. */
  private blit(source: RgbaImage, sx: number, sy: number, tile: number, mask: number | null, over: boolean): void {
    const t = this.tile
    const dx = (tile % ATLAS_COLUMNS) * t
    const dy = Math.floor(tile / ATLAS_COLUMNS) * t
    const width = ATLAS_COLUMNS * t
    const half = t / 2
    for (let y = 0; y < t; y++) {
      for (let x = 0; x < t; x++) {
        if (mask !== null && !(mask & CORNER_BITS[(y >= half ? 2 : 0) + (x >= half ? 1 : 0)])) continue
        const si = ((sy + y) * source.width + sx + x) * 4
        const di = ((dy + y) * width + dx + x) * 4
        const sa = source.data[si + 3] / 255
        if (!over || sa >= 1) {
          this.buffer[di] = source.data[si]
          this.buffer[di + 1] = source.data[si + 1]
          this.buffer[di + 2] = source.data[si + 2]
          this.buffer[di + 3] = source.data[si + 3]
          continue
        }
        if (sa <= 0) continue
        const da = this.buffer[di + 3] / 255
        const oa = sa + da * (1 - sa)
        for (let c = 0; c < 3; c++) this.buffer[di + c] = (source.data[si + c] * sa + this.buffer[di + c] * da * (1 - sa)) / oa
        this.buffer[di + 3] = oa * 255
      }
    }
    this.version += 1
  }
}
