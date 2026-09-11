/**
 * The terrain template.
 *
 * A template kind is three things: a sheet layout the artist paints into, a
 * parameter schema, and a mesher. This file is the first two for terrain.
 * There is exactly one template kind here and it is hardcoded — the general
 * "template kind" system in brief section 4 should be extracted once a second
 * kind (buildings) exists to generalise from, not before.
 *
 * SHEET LAYOUT
 * ------------
 * Position on the sheet defines what a tile means, the way RPG Maker autotile
 * sheets work, so the artist never tags tiles by hand.
 *
 * The sheet is a grid of square tiles, each `texelDensity` pixels.
 * Each material owns a block 4 tiles wide and 5 tiles tall. Material N owns
 * tile columns N*4 .. N*4+3.
 *
 *     columns within the block:   0      1      2      3
 *     row 0 .. 3    the 16 autotile variants for the top surface
 *     row 4         cliff top | cliff middle | cliff bottom | ramp
 *
 * The autotile variant is chosen by a 4-bit mask of which neighbours share the
 * material: N=1, E=2, S=4, W=8. The tile for mask m sits at
 * (col = m & 3, row = m >> 2) within the block, so row 0 is the four
 * "nothing to the south or west" cases and row 3 is the four "connected on
 * south and west" cases. The shipped guide layer draws the connecting edges on
 * each tile, which is what actually makes this learnable.
 *
 * A tile id, as stored in the paint layers, is an absolute index into the
 * whole sheet: `row * sheetColumns + column`. A painted override can therefore
 * reference any tile on the sheet, including another material's, which is what
 * lets a tile brush paint dirt onto a grass cell without changing the cell's
 * material.
 */

import type { MapDoc } from '@map-editor/document'

export const BLOCK_COLUMNS = 4
export const BLOCK_ROWS = 5
export const CLIFF_ROW = 4

export const CLIFF_TOP = 0
export const CLIFF_MIDDLE = 1
export const CLIFF_BOTTOM = 2
export const RAMP_COLUMN = 3

export type CliffBand = 'top' | 'middle' | 'bottom'

export interface SheetLayout {
  /** Tiles across the whole sheet. */
  columns: number
  /** Tiles down the whole sheet. */
  rows: number
  /** Pixels per tile. */
  density: number
}

export function sheetLayoutFor(doc: MapDoc): SheetLayout {
  return {
    columns: doc.materials.length * BLOCK_COLUMNS,
    rows: BLOCK_ROWS,
    density: doc.texelDensity,
  }
}

export function tileId(layout: SheetLayout, column: number, row: number): number {
  return row * layout.columns + column
}

export function tileColumnRow(layout: SheetLayout, id: number): { column: number; row: number } {
  return { column: id % layout.columns, row: Math.floor(id / layout.columns) }
}

/** The automatic default tile for a terrain top, before any painted override. */
export function defaultTopTile(layout: SheetLayout, material: number, mask: number): number {
  const column = material * BLOCK_COLUMNS + (mask & 3)
  const row = mask >> 2
  return tileId(layout, column, row)
}

export function cliffTile(layout: SheetLayout, material: number, band: CliffBand): number {
  const offset = band === 'top' ? CLIFF_TOP : band === 'bottom' ? CLIFF_BOTTOM : CLIFF_MIDDLE
  return tileId(layout, material * BLOCK_COLUMNS + offset, CLIFF_ROW)
}

export function rampTile(layout: SheetLayout, material: number): number {
  return tileId(layout, material * BLOCK_COLUMNS + RAMP_COLUMN, CLIFF_ROW)
}

/**
 * UV rectangle for a tile, as [u0, v0, u1, v1] with v measured from the bottom
 * the way GL expects.
 *
 * The inset is half a texel. With NEAREST filtering and no mipmaps exact UVs
 * would be fine, but the moment mipmaps are on (which the linear/high-res
 * profile wants) a sample at a tile boundary blends in the neighbouring tile.
 * Half a texel costs nothing visually and removes the whole class of bug.
 */
export function tileUv(layout: SheetLayout, id: number): [number, number, number, number] {
  const { column, row } = tileColumnRow(layout, id)
  const insetU = 0.5 / (layout.columns * layout.density)
  const insetV = 0.5 / (layout.rows * layout.density)
  const u0 = column / layout.columns + insetU
  const u1 = (column + 1) / layout.columns - insetU
  // Sheets are authored top-down; GL samples bottom-up.
  const v1 = 1 - row / layout.rows - insetV
  const v0 = 1 - (row + 1) / layout.rows + insetV
  return [u0, v0, u1, v1]
}
