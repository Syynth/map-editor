/**
 * Voxels: the ground as cubes, and everything derived from a column.
 *
 * A voxel volume is a box of cubes, one tile on every side, `layers` deep
 * along y. A voxel is `AIR` or a material plus a shape. Nothing stores a
 * height: the top of a column is the highest voxel that is not air, and its
 * shape says how tall that voxel is and whether it slopes. Every height the
 * rest of the editor reads — `heightAt`, `cornerHeights`, the layer view's
 * cap — is derived from here, in half-tiles, so a cube is two and a slab is
 * one and nothing downstream had to learn a new unit (spec §1).
 *
 * The per-voxel arrays are flat `number[]` addressed by `voxelIndex`, and
 * water stays a flat `number[]` per column, because the patch applier and
 * the store's dirty-chunk derivation index a field's array generically and
 * recover the cell from the index.
 *
 * The shape constants live in `document.ts` beside `NO_RAMP`, so that
 * `createVoxel` can use them without this module importing the one that
 * imports it.
 */

import { AIR, NO_RAMP, SHAPE_BLOCK, SHAPE_HALF_RAMP, SHAPE_HALF_RAMP_UP, SHAPE_RAMP, SHAPE_SLAB, cellIndex, type MapSize } from './document'
import type { ReadonlyVoxel, VoxelStructure } from './structure'

export interface VoxelBox {
  readonly size: MapSize
  readonly layers: number
}

export function voxelIndex(box: VoxelBox, x: number, z: number, y: number): number {
  return (y * box.size.height + z) * box.size.width + x
}

export function rampShape(dir: number): number {
  return SHAPE_RAMP + dir
}

/** The half ramp that hugs the floor: rises from the middle of the cell to one half-tile at the high edge. */
export function halfRampShape(dir: number): number {
  return SHAPE_HALF_RAMP + dir
}

/** The half ramp that rides a slab: flat at one half-tile to the middle, then rises to two at the high edge. */
export function halfRampUpShape(dir: number): number {
  return SHAPE_HALF_RAMP_UP + dir
}

/** The direction a sloped shape descends toward, or NO_RAMP for a block or a slab. */
export function shapeRampDir(shape: number): number {
  if (shape >= SHAPE_RAMP && shape < SHAPE_RAMP + 4) return shape - SHAPE_RAMP
  if (shape >= SHAPE_HALF_RAMP && shape < SHAPE_HALF_RAMP + 4) return shape - SHAPE_HALF_RAMP
  if (shape >= SHAPE_HALF_RAMP_UP && shape < SHAPE_HALF_RAMP_UP + 4) return shape - SHAPE_HALF_RAMP_UP
  return NO_RAMP
}

/** A full 45° ramp. */
export function isRampShape(shape: number): boolean {
  return shape >= SHAPE_RAMP && shape < SHAPE_RAMP + 4
}

/** Either half ramp. */
export function isHalfRampShape(shape: number): boolean {
  return shape >= SHAPE_HALF_RAMP && shape < SHAPE_HALF_RAMP_UP + 4
}

/** Anything whose top is not level. */
export function isSlopedShape(shape: number): boolean {
  return shapeRampDir(shape) !== NO_RAMP
}

/** The height of a shape's top at its highest, in half-tiles above the voxel's floor. */
export function shapeHeight(shape: number): number {
  return shape === SHAPE_SLAB || (shape >= SHAPE_HALF_RAMP && shape < SHAPE_HALF_RAMP + 4) ? 1 : 2
}

/** The height of a sloped shape's top at its lowest, in half-tiles above the voxel's floor. */
export function shapeLowHeight(shape: number): number {
  return shape >= SHAPE_HALF_RAMP_UP && shape < SHAPE_HALF_RAMP_UP + 4 ? 1 : 0
}

/** The layer of the column's top voxel, or -1 for an empty column. */
export function columnTopAt(voxel: ReadonlyVoxel, x: number, z: number): number {
  const { width, height } = voxel.size
  const material = voxel.voxels.material
  for (let y = voxel.layers - 1; y >= 0; y--) if (material[(y * height + z) * width + x] !== AIR) return y
  return -1
}

/** The top voxel's shape; a block for an empty column, whose top is the floor. */
export function topShapeAt(voxel: ReadonlyVoxel, x: number, z: number): number {
  const y = columnTopAt(voxel, x, z)
  return y < 0 ? SHAPE_BLOCK : voxel.voxels.shape[voxelIndex(voxel, x, z, y)]
}

/** The column's top at its highest, in half-tiles from the volume's floor. */
export function topHeight(voxel: ReadonlyVoxel, x: number, z: number): number {
  const y = columnTopAt(voxel, x, z)
  if (y < 0) return 0
  return y * 2 + shapeHeight(voxel.voxels.shape[voxelIndex(voxel, x, z, y)])
}

/** The tallest a column in this volume can be, in half-tiles. */
export function maxHeightOf(box: VoxelBox): number {
  return box.layers * 2
}

function clampX(voxel: ReadonlyVoxel, x: number): number {
  return Math.min(Math.max(x, 0), voxel.size.width - 1)
}

function clampZ(voxel: ReadonlyVoxel, z: number): number {
  return Math.min(Math.max(z, 0), voxel.size.height - 1)
}

/** Height in half-tiles, or the edge value clamped, for out-of-bounds reads. */
export function heightAt(voxel: ReadonlyVoxel, x: number, z: number): number {
  return topHeight(voxel, clampX(voxel, x), clampZ(voxel, z))
}

/** The top voxel's material, clamped at the edges; the first material for an empty column. */
export function materialAt(voxel: ReadonlyVoxel, x: number, z: number): number {
  const cx = clampX(voxel, x)
  const cz = clampZ(voxel, z)
  const y = columnTopAt(voxel, cx, cz)
  return y < 0 ? 0 : voxel.voxels.material[voxelIndex(voxel, cx, cz, y)]
}

/** The direction the column's top descends toward, or NO_RAMP. */
export function rampDirAt(voxel: ReadonlyVoxel, x: number, z: number): number {
  return shapeRampDir(topShapeAt(voxel, x, z))
}

/** Every column's top height, in half-tiles, indexed by cell — what the layer view's cap and slider read. */
export function columnHeights(voxel: ReadonlyVoxel): number[] {
  const out = new Array<number>(voxel.size.width * voxel.size.height)
  for (let z = 0; z < voxel.size.height; z++) for (let x = 0; x < voxel.size.width; x++) out[cellIndex(voxel.size, x, z)] = topHeight(voxel, x, z)
  return out
}

/**
 * Stand a column at `height` half-tiles by writing the arrays directly, in
 * `material`: for building a map before it has a store — a fixture, a test.
 * An edit goes through `columnPatches` in `ops.ts` and the document actor.
 */
export function fillColumn(voxel: VoxelStructure, x: number, z: number, height: number, material = 0, topShape?: number): void {
  const shapes = columnShapes(voxel.layers, height, topShape)
  for (let y = 0; y < voxel.layers; y++) {
    const index = voxelIndex(voxel, x, z, y)
    voxel.voxels.material[index] = shapes[y] === AIR ? AIR : material
    voxel.voxels.shape[index] = shapes[y] === AIR ? SHAPE_BLOCK : shapes[y]
  }
}

/**
 * The voxels a column holds when its top stands at `height` half-tiles: a
 * block per full cube, a slab for an odd half-tile, `topShape` for the top
 * voxel when given (a ramp cell is a column whose top voxel slopes). Returned
 * as one shape per layer, AIR above the top, so a caller can diff it against
 * the column as it is.
 */
export function columnShapes(layers: number, height: number, topShape?: number): number[] {
  const out = new Array<number>(layers).fill(AIR)
  const full = Math.floor(height / 2)
  for (let y = 0; y < Math.min(full, layers); y++) out[y] = SHAPE_BLOCK
  if (height % 2 === 1 && full < layers) out[full] = SHAPE_SLAB
  const top = height % 2 === 1 ? full : full - 1
  if (topShape !== undefined && top >= 0 && top < layers) out[top] = topShape
  return out
}
