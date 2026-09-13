/**
 * Edit operations: functions from the document to patches. Nothing here
 * mutates; the store applies what these return and keeps the inverse.
 *
 * Terrain ops take the voxel structure they edit — patches carry its id —
 * so two volumes in one level never share an index. Object grounding asks
 * the whole level, since an object can stand on any structure.
 */

import type { Patch } from './edits'
import { NO_RAMP, NO_WATER, cellIndex, inBounds, newId, worldHeight, type DeepReadonly, type MapObject, type ReadonlyMapDoc } from './document'
import { cliffKey, tintKey, topKey } from './paint'
import { descendantsOf, type Placement, type ProfilePoint, type QuarterTurn, type ReadonlySketch, type ReadonlyVoxel, type SketchStructure, type Structure } from './structure'
import { frameOf, groundHeight, toLocal, type Frame } from './terrain'

export type BrushShape = 'square' | 'circle'

export interface Brush {
  size: number
  shape: BrushShape
}

export type Cell = [number, number]

// --- cell selection ----------------------------------------------------------

export function brushCells(voxel: ReadonlyVoxel, cx: number, cy: number, brush: Brush): Cell[] {
  const cells: Cell[] = []
  const radius = Math.floor((brush.size - 1) / 2)
  const extra = (brush.size - 1) % 2
  for (let y = cy - radius; y <= cy + radius + extra; y++) {
    for (let x = cx - radius; x <= cx + radius + extra; x++) {
      if (!inBounds(voxel.size, x, y)) continue
      if (brush.shape === 'circle') {
        const dx = x - cx
        const dy = y - cy
        if (Math.hypot(dx, dy) > brush.size / 2) continue
      }
      cells.push([x, y])
    }
  }
  return cells
}

export function rectCells(voxel: ReadonlyVoxel, ax: number, ay: number, bx: number, by: number): Cell[] {
  const cells: Cell[] = []
  const x0 = Math.max(0, Math.min(ax, bx))
  const x1 = Math.min(voxel.size.width - 1, Math.max(ax, bx))
  const y0 = Math.max(0, Math.min(ay, by))
  const y1 = Math.min(voxel.size.height - 1, Math.max(ay, by))
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.push([x, y])
  return cells
}

/** Flood fill over cells of the same material and height, capped so a runaway fill stays interactive. */
export function fillCells(voxel: ReadonlyVoxel, sx: number, sy: number, limit = 4096): Cell[] {
  if (!inBounds(voxel.size, sx, sy)) return []
  const seed = cellIndex(voxel.size, sx, sy)
  const material = voxel.terrain.material[seed]
  const height = voxel.terrain.height[seed]
  const seen = new Set<number>([seed])
  const out: Cell[] = []
  const queue: Cell[] = [[sx, sy]]
  while (queue.length > 0 && out.length < limit) {
    const [x, y] = queue.shift() as Cell
    out.push([x, y])
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx
      const ny = y + dy
      if (!inBounds(voxel.size, nx, ny)) continue
      const index = cellIndex(voxel.size, nx, ny)
      if (seen.has(index)) continue
      if (voxel.terrain.material[index] !== material) continue
      if (voxel.terrain.height[index] !== height) continue
      seen.add(index)
      queue.push([nx, ny])
    }
  }
  return out
}

// --- sculpt ------------------------------------------------------------------

export const MIN_HEIGHT = 0
export const MAX_HEIGHT = 40

export function raise(doc: ReadonlyMapDoc, voxel: ReadonlyVoxel, cells: Cell[], delta: number): Patch[] {
  const patches: Patch[] = []
  for (const [x, y] of cells) {
    const index = cellIndex(voxel.size, x, y)
    const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, voxel.terrain.height[index] + delta))
    patches.push({ t: 'voxel', id: voxel.id, field: 'height', index, value: next }, ...drainedBy(voxel, index, next))
  }
  return [...patches, ...regroundObjects(doc, voxel, cells, patches)]
}

/** Water cannot sit at or below the terrain under it (ruling of 2026-09-12): a column raised to its water line drains. */
function drainedBy(voxel: ReadonlyVoxel, index: number, height: number): Patch[] {
  const water = voxel.terrain.water[index]
  return water !== NO_WATER && height >= water ? [{ t: 'voxel', id: voxel.id, field: 'water', index, value: NO_WATER }] : []
}

export function flatten(doc: ReadonlyMapDoc, voxel: ReadonlyVoxel, cells: Cell[], height: number): Patch[] {
  const clamped = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height))
  const patches: Patch[] = cells.flatMap(([x, y]) => {
    const index = cellIndex(voxel.size, x, y)
    return [{ t: 'voxel', id: voxel.id, field: 'height', index, value: clamped }, ...drainedBy(voxel, index, clamped)]
  })
  return [...patches, ...regroundObjects(doc, voxel, cells, patches)]
}

export function setMaterial(voxel: ReadonlyVoxel, cells: Cell[], material: number): Patch[] {
  return cells.map(([x, y]) => ({
    t: 'voxel',
    id: voxel.id,
    field: 'material',
    index: cellIndex(voxel.size, x, y),
    value: material,
  }))
}

export function setRamp(doc: ReadonlyMapDoc, voxel: ReadonlyVoxel, cells: Cell[], dir: number): Patch[] {
  const patches: Patch[] = cells.map(([x, y]) => {
    const index = cellIndex(voxel.size, x, y)
    const current = voxel.terrain.ramp[index]
    return {
      t: 'voxel',
      id: voxel.id,
      field: 'ramp',
      index,
      value: current === dir ? NO_RAMP : dir,
    }
  })
  return [...patches, ...regroundObjects(doc, voxel, cells, patches)]
}

/** Water at or below the terrain is not a state (ruling of 2026-09-12): such cells are left alone. */
export function setWater(voxel: ReadonlyVoxel, cells: Cell[], level: number | null): Patch[] {
  const patches: Patch[] = []
  for (const [x, y] of cells) {
    const index = cellIndex(voxel.size, x, y)
    if (level !== null && level <= voxel.terrain.height[index]) continue
    patches.push({ t: 'voxel', id: voxel.id, field: 'water', index, value: level === null ? NO_WATER : level })
  }
  return patches
}

// --- paint -------------------------------------------------------------------

export function paintTop(voxel: ReadonlyVoxel, cells: Cell[], tile: number | undefined): Patch[] {
  return cells.map(([x, y]) => ({ t: 'voxelPaint', id: voxel.id, layer: 'top', key: topKey(x, y), value: tile }))
}

export function paintCliff(voxel: ReadonlyVoxel, faces: Array<{ x: number; y: number; dir: number; level: number }>, tile: number | undefined): Patch[] {
  return faces.map((face) => ({
    t: 'voxelPaint',
    id: voxel.id,
    layer: 'cliff',
    key: cliffKey(face.x, face.y, face.dir, face.level),
    value: tile,
  }))
}

export function paintTint(voxel: ReadonlyVoxel, cells: Cell[], color: number | undefined): Patch[] {
  return cells.map(([x, y]) => ({ t: 'voxelPaint', id: voxel.id, layer: 'tint', key: tintKey(x, y), value: color }))
}

// --- objects -----------------------------------------------------------------

export function addObject(doc: ReadonlyMapDoc, object: MapObject): Patch[] {
  return [
    { t: 'object', id: object.id, value: object },
    { t: 'objectOrder', value: [...doc.objectOrder, object.id] },
  ]
}

export function removeObject(doc: ReadonlyMapDoc, id: string): Patch[] {
  return [
    { t: 'object', id, value: undefined },
    { t: 'objectOrder', value: doc.objectOrder.filter((other) => other !== id) },
  ]
}

export function removeObjects(doc: ReadonlyMapDoc, ids: readonly string[]): Patch[] {
  const doomed = new Set(ids.filter((id) => doc.objects[id]))
  if (doomed.size === 0) return []
  return [
    ...[...doomed].map((id): Patch => ({ t: 'object', id, value: undefined })),
    { t: 'objectOrder', value: doc.objectOrder.filter((id) => !doomed.has(id)) },
  ]
}

export function updateObject(doc: ReadonlyMapDoc, id: string, changes: Partial<MapObject>): Patch[] {
  const existing = doc.objects[id]
  if (!existing) return []
  return [{ t: 'object', id, value: { ...cloneObject(existing), ...changes, id } }]
}

function cloneObject(object: DeepReadonly<MapObject>): MapObject {
  return {
    ...object,
    position: [...object.position],
    facing: { ...object.facing },
    anchorCell: object.anchorCell ? [...object.anchorCell] : null,
  }
}

/**
 * Objects anchored to cells a sculpt is about to change follow the ground:
 * the pending height/ramp patches are applied to a scratch copy of the
 * voxel and every anchored object on a touched cell is re-grounded against
 * the level as it will be.
 */
export function regroundObjects(doc: ReadonlyMapDoc, voxel: ReadonlyVoxel, cells: Cell[], pending: Patch[]): Patch[] {
  if (doc.objectOrder.length === 0) return []
  const touched = new Set(cells.map(([x, y]) => `${x},${y}`))
  const heightOverride = new Map<number, number>()
  const rampOverride = new Map<number, number>()
  for (const patch of pending) {
    if (patch.t !== 'voxel' || patch.id !== voxel.id) continue
    if (patch.field === 'height') heightOverride.set(patch.index, patch.value)
    if (patch.field === 'ramp') rampOverride.set(patch.index, patch.value)
  }
  if (heightOverride.size === 0 && rampOverride.size === 0) return []
  const height = voxel.terrain.height.slice()
  const ramp = voxel.terrain.ramp.slice()
  for (const [index, value] of heightOverride) height[index] = value
  for (const [index, value] of rampOverride) ramp[index] = value
  const after: ReadonlyMapDoc = {
    ...doc,
    structures: { ...doc.structures, [voxel.id]: { ...voxel, terrain: { ...voxel.terrain, height, ramp } } },
  }
  const patches: Patch[] = []
  for (const id of doc.objectOrder) {
    const object = doc.objects[id]
    if (!object?.anchorCell) continue
    const [ax, ay] = object.anchorCell
    if (!touched.has(`${ax},${ay}`)) continue
    const y = groundHeight(after, object.position[0], object.position[2])
    if (Math.abs(y - object.position[1]) < 1e-6) continue
    patches.push({
      t: 'object',
      id,
      value: { ...cloneObject(object), position: [object.position[0], y, object.position[2]] },
    })
  }
  return patches
}

/** Drop an object onto whatever is under it. */
export function groundedPosition(doc: ReadonlyMapDoc, worldX: number, worldZ: number): [number, number, number] {
  return [worldX, groundHeight(doc, worldX, worldZ), worldZ]
}

export function heightToWorld(halfTiles: number): number {
  return worldHeight(halfTiles)
}

// --- structures --------------------------------------------------------------

export function addStructure(doc: ReadonlyMapDoc, structure: Structure): Patch[] {
  return [
    { t: 'structure', id: structure.id, value: structure },
    { t: 'structureOrder', value: [...doc.structureOrder, structure.id] },
  ]
}

/** A structure and everything standing on it. */
export function removeStructure(doc: ReadonlyMapDoc, id: string): Patch[] {
  if (!doc.structures[id]) return []
  const doomed = new Set([id, ...descendantsOf(doc, id)])
  return [
    ...[...doomed].map((each): Patch => ({ t: 'structure', id: each, value: undefined })),
    { t: 'structureOrder', value: doc.structureOrder.filter((each) => !doomed.has(each)) },
  ]
}

export function renameStructure(doc: ReadonlyMapDoc, id: string, name: string): Patch[] {
  return doc.structures[id] ? [{ t: 'structure.meta', id, field: 'name', value: name }] : []
}

export function placeStructure(doc: ReadonlyMapDoc, id: string, placement: Placement): Patch[] {
  return doc.structures[id] ? [{ t: 'structure.meta', id, field: 'placement', value: { ...placement } }] : []
}

/**
 * Put a structure's origin at a world point, standing on `parent` (or the
 * root), with the placement re-measured in that parent's frame so where it
 * is and which way it faces in the world do not change with the parent —
 * a drag that carries a tier off its island and onto the ground. `snap`
 * rounds the placement in the new frame. Refused (empty) for the root, for
 * a parent that would make a cycle, and for one that is not there.
 */
export function placeStructureOnto(
  doc: ReadonlyMapDoc,
  id: string,
  parent: string | null,
  world: { readonly x: number; readonly z: number },
  snap: (value: number) => number = (value) => value,
): Patch[] {
  const structure = doc.structures[id]
  if (!structure || structure.parent === null) return []
  if (parent !== null && (parent === id || !doc.structures[parent] || descendantsOf(doc, id).includes(parent))) return []
  const from = frameOf(doc, structure.parent)
  const to = parent === null ? ROOT_FRAME : frameOf(doc, parent)
  const [lx, lz] = toLocal(to, world.x, world.z)
  const worldYaw = (from.yaw + structure.placement.yaw) % 4
  const placement: Placement = { x: snap(lx), z: snap(lz), yaw: ((worldYaw - to.yaw + 4) % 4) as QuarterTurn }
  const patches: Patch[] = []
  if (parent !== structure.parent) patches.push({ t: 'structure.meta', id, field: 'parent', value: parent })
  if (placement.x !== structure.placement.x || placement.z !== structure.placement.z || placement.yaw !== structure.placement.yaw || parent !== structure.parent)
    patches.push({ t: 'structure.meta', id, field: 'placement', value: placement })
  return patches
}

const ROOT_FRAME: Frame = { x: 0, z: 0, yaw: 0, y: 0 }

/** Move a structure under another (or to the root), keeping its placement as measured; refused when that would make a cycle. */
export function reparentStructure(doc: ReadonlyMapDoc, id: string, parent: string | null): Patch[] {
  if (!doc.structures[id]) return []
  if (parent !== null && (parent === id || !doc.structures[parent] || descendantsOf(doc, id).includes(parent))) return []
  return [{ t: 'structure.meta', id, field: 'parent', value: parent }]
}

// --- sketches ----------------------------------------------------------------

export const DEFAULT_WALL_PROFILE: SketchStructure['wall'] = {
  points: [
    { out: 0.8, t: 0 },
    { out: 0.44, t: 0.2 },
    { out: 0.18, t: 0.45 },
    { out: 0.04, t: 0.75 },
    { out: 0, t: 1 },
  ],
  smooth: true,
}

/** A fresh, open sketch on `parent` (or the ground), ready for its first point. */
export function createSketch(parent: string | null, name = 'Sketch', placement: Placement = { x: 0, z: 0, yaw: 0 }): SketchStructure {
  return {
    id: newId('sk'),
    kind: 'sketch',
    name,
    parent,
    placement,
    points: [],
    closed: false,
    layers: 3,
    wall: { points: DEFAULT_WALL_PROFILE.points.map((p) => ({ ...p })), smooth: DEFAULT_WALL_PROFILE.smooth },
    lip: 'skirt',
    capMaterial: 'grass',
    wallMaterial: 'earth',
  }
}

export type SketchChanges = Partial<Pick<SketchStructure, 'points' | 'closed' | 'layers' | 'wall' | 'lip' | 'capMaterial' | 'wallMaterial'>>

function sketchAt(doc: ReadonlyMapDoc, id: string): ReadonlySketch | undefined {
  const s = doc.structures[id]
  return s && s.kind === 'sketch' ? s : undefined
}

export function setSketch(doc: ReadonlyMapDoc, id: string, changes: SketchChanges): Patch[] {
  if (!sketchAt(doc, id)) return []
  const patches: Patch[] = []
  if (changes.points !== undefined) patches.push({ t: 'sketch', id, field: 'points', value: changes.points.map((p) => ({ ...p })) })
  if (changes.closed !== undefined) patches.push({ t: 'sketch', id, field: 'closed', value: changes.closed })
  if (changes.layers !== undefined) patches.push({ t: 'sketch', id, field: 'layers', value: changes.layers })
  if (changes.wall !== undefined) patches.push({ t: 'sketch', id, field: 'wall', value: { points: changes.wall.points.map((p) => ({ ...p })), smooth: changes.wall.smooth } })
  if (changes.lip !== undefined) patches.push({ t: 'sketch', id, field: 'lip', value: changes.lip })
  if (changes.capMaterial !== undefined) patches.push({ t: 'sketch', id, field: 'capMaterial', value: changes.capMaterial })
  if (changes.wallMaterial !== undefined) patches.push({ t: 'sketch', id, field: 'wallMaterial', value: changes.wallMaterial })
  return patches
}

function points(sketch: ReadonlySketch): ProfilePoint[] {
  return sketch.points.map((p) => ({ ...p }))
}

/** Append a point, or insert it before `at`. */
export function addSketchPoint(doc: ReadonlyMapDoc, id: string, point: ProfilePoint, at?: number): Patch[] {
  const sketch = sketchAt(doc, id)
  if (!sketch) return []
  const next = points(sketch)
  next.splice(at === undefined ? next.length : Math.max(0, Math.min(next.length, at)), 0, { ...point })
  return [{ t: 'sketch', id, field: 'points', value: next }]
}

export function updateSketchPoint(doc: ReadonlyMapDoc, id: string, index: number, changes: Partial<ProfilePoint>): Patch[] {
  const sketch = sketchAt(doc, id)
  if (!sketch || !sketch.points[index]) return []
  const next = points(sketch)
  next[index] = { ...next[index], ...changes }
  return [{ t: 'sketch', id, field: 'points', value: next }]
}

/** Remove a point; a closed sketch left with fewer than three opens again. */
export function deleteSketchPoint(doc: ReadonlyMapDoc, id: string, index: number): Patch[] {
  const sketch = sketchAt(doc, id)
  if (!sketch || !sketch.points[index]) return []
  const next = points(sketch)
  next.splice(index, 1)
  const patches: Patch[] = [{ t: 'sketch', id, field: 'points', value: next }]
  if (sketch.closed && next.length < 3) patches.push({ t: 'sketch', id, field: 'closed', value: false })
  return patches
}

/** Close an open sketch: three points make an outline. */
export function closeSketch(doc: ReadonlyMapDoc, id: string): Patch[] {
  const sketch = sketchAt(doc, id)
  if (!sketch || sketch.closed || sketch.points.length < 3) return []
  return [{ t: 'sketch', id, field: 'closed', value: true }]
}
