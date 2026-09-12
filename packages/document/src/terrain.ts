/**
 * Height queries over the level.
 *
 * "What is under this point" is answered per structure kind and taken
 * top-most: a voxel column's bilinear top, a closed sketch's cap. Each
 * structure is asked in its own frame — its parent's origin, turned by its
 * yaw, lifted to its parent's top where it stands — so a tier on an island
 * on a voxel volume reports the height the artist sees.
 */

import { HALF, NO_RAMP, cellIndex, inBounds, type ReadonlyMapDoc } from './document'
import { ancestorsOf, outlineOf, pointInOutline, type QuarterTurn, type ReadonlyStructure, type ReadonlyVoxel } from './structure'

export const CORNER_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
]

/** For each ramp direction, which two corners (indices into CORNER_OFFSETS) drop. */
export const RAMP_LOW_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [3, 2],
  [1, 2],
  [0, 1],
  [3, 0],
]

export const RAMP_DROP = 2

export function cornerHeights(voxel: ReadonlyVoxel, x: number, y: number): [number, number, number, number] {
  const index = cellIndex(voxel.size, x, y)
  const h = voxel.terrain.height[index]
  const corners: [number, number, number, number] = [h, h, h, h]
  const ramp = voxel.terrain.ramp[index]
  if (ramp !== NO_RAMP) {
    for (const corner of RAMP_LOW_CORNERS[ramp]) corners[corner] = h - RAMP_DROP
  }
  return corners
}

/** The top of a voxel volume at a local point, bilinear across the cell, in world units; `null` outside it. */
export function voxelTop(voxel: ReadonlyVoxel, localX: number, localZ: number): number | null {
  const cx = Math.floor(localX)
  const cy = Math.floor(localZ)
  if (!inBounds(voxel.size, cx, cy)) return null
  const [c00, c01, c11, c10] = cornerHeights(voxel, cx, cy)
  const fx = localX - cx
  const fz = localZ - cy
  // Bilinear across the cell. c00 at (0,0), c10 at (1,0), c01 at (0,1), c11 at (1,1).
  const north = c00 + (c10 - c00) * fx
  const south = c01 + (c11 - c01) * fx
  return (north + (south - north) * fz) * HALF
}

/** A structure's frame in world space: where its origin is, which way it faces, and the height of the plane it stands on. */
export interface Frame {
  x: number
  z: number
  yaw: QuarterTurn
  y: number
}

const ROOT: Frame = { x: 0, z: 0, yaw: 0, y: 0 }

function turn(x: number, z: number, yaw: QuarterTurn): [number, number] {
  switch (yaw) {
    case 0:
      return [x, z]
    case 1:
      return [-z, x]
    case 2:
      return [-x, -z]
    case 3:
      return [z, -x]
  }
}

export function toWorld(frame: Frame, localX: number, localZ: number): [number, number] {
  const [x, z] = turn(localX, localZ, frame.yaw)
  return [frame.x + x, frame.z + z]
}

export function toLocal(frame: Frame, worldX: number, worldZ: number): [number, number] {
  return turn(worldX - frame.x, worldZ - frame.z, ((4 - frame.yaw) % 4) as QuarterTurn)
}

/** The height of a structure's top at one of its own local points; what a child standing there sits on. */
function topAt(structure: ReadonlyStructure, localX: number, localZ: number): number {
  if (structure.kind === 'voxel') return voxelTop(structure, localX, localZ) ?? 0
  return structure.closed && structure.points.length >= 3 ? structure.layers * HALF : 0
}

/** The frame a structure's own coordinates are measured in, composed down from the root. */
export function frameOf(doc: ReadonlyMapDoc, id: string): Frame {
  const chain = [...ancestorsOf(doc, id)].reverse()
  chain.push(id)
  let frame = ROOT
  let parent: ReadonlyStructure | undefined
  for (const current of chain) {
    const s = doc.structures[current]
    if (!s) break
    if (parent) {
      const [x, z] = toWorld(frame, s.placement.x, s.placement.z)
      const y = frame.y + topAt(parent, s.placement.x, s.placement.z)
      frame = { x, z, yaw: ((frame.yaw + s.placement.yaw) % 4) as QuarterTurn, y }
    }
    parent = s
  }
  return frame
}

/** Height of whatever is under a world point: the top-most structure there, or the ground at 0. */
export function groundHeight(doc: ReadonlyMapDoc, worldX: number, worldZ: number): number {
  let best = 0
  for (const id of doc.structureOrder) {
    const s = doc.structures[id]
    if (!s) continue
    const frame = frameOf(doc, id)
    const [lx, lz] = toLocal(frame, worldX, worldZ)
    if (s.kind === 'voxel') {
      const top = voxelTop(s, lx, lz)
      if (top !== null) best = Math.max(best, frame.y + top)
    } else if (s.closed && s.points.length >= 3 && pointInOutline(outlineOf(s.points), lx, lz)) {
      best = Math.max(best, frame.y + s.layers * HALF)
    }
  }
  return best
}

/** The world position of the centre of one of a voxel volume's cells, on its top. */
export function cellCentreWorld(doc: ReadonlyMapDoc, voxel: ReadonlyVoxel, x: number, y: number): [number, number, number] {
  const frame = frameOf(doc, voxel.id)
  const [wx, wz] = toWorld(frame, x + 0.5, y + 0.5)
  return [wx, frame.y + (voxelTop(voxel, x + 0.5, y + 0.5) ?? 0), wz]
}
