/**
 * Editing operations.
 *
 * Every op is a pure function from the document plus some arguments to a list
 * of patches. Nothing here mutates; the store applies the patches and derives
 * the inverse. That means a new tool gets undo, redo, stroke coalescing and
 * dirty-chunk tracking by writing one of these and nothing else.
 *
 * NOTE ON THE PAINT INVARIANT. Sculpt ops in this file write to `terrain.*`
 * and never to `paint.*`. That is not an oversight — it is the mechanism by
 * which painted work survives geometry edits (see paint.ts). Do not "tidy up"
 * paint here.
 */

import type { Patch } from './edits'
import {
  NO_RAMP,
  NO_WATER,
  cellIndex,
  inBounds,
  worldHeight,
  type DeepReadonly,
  type MapObject,
  type ReadonlyMapDoc,
} from './document'
import { cliffKey, tintKey, topKey } from './paint'
import { groundHeight } from './terrain'

export type BrushShape = 'square' | 'circle'

export interface Brush {
  size: number
  shape: BrushShape
}

export type Cell = [number, number]

/** Cells covered by a brush centred on a cell. */
export function brushCells(doc: ReadonlyMapDoc, cx: number, cy: number, brush: Brush): Cell[] {
  const cells: Cell[] = []
  const radius = Math.floor((brush.size - 1) / 2)
  const extra = (brush.size - 1) % 2
  for (let y = cy - radius; y <= cy + radius + extra; y++) {
    for (let x = cx - radius; x <= cx + radius + extra; x++) {
      if (!inBounds(doc.size, x, y)) continue
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

/** Cells in the rectangle spanned by two corners, clipped to the map. */
export function rectCells(doc: ReadonlyMapDoc, ax: number, ay: number, bx: number, by: number): Cell[] {
  const cells: Cell[] = []
  const x0 = Math.max(0, Math.min(ax, bx))
  const x1 = Math.min(doc.size.width - 1, Math.max(ax, bx))
  const y0 = Math.max(0, Math.min(ay, by))
  const y1 = Math.min(doc.size.height - 1, Math.max(ay, by))
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.push([x, y])
  return cells
}

/** Flood fill across cells matching the seed's material and height. */
export function fillCells(doc: ReadonlyMapDoc, sx: number, sy: number, limit = 4096): Cell[] {
  if (!inBounds(doc.size, sx, sy)) return []
  const seed = cellIndex(doc.size, sx, sy)
  const material = doc.terrain.material[seed]
  const height = doc.terrain.height[seed]

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
      if (!inBounds(doc.size, nx, ny)) continue
      const index = cellIndex(doc.size, nx, ny)
      if (seen.has(index)) continue
      if (doc.terrain.material[index] !== material) continue
      if (doc.terrain.height[index] !== height) continue
      seen.add(index)
      queue.push([nx, ny])
    }
  }
  return out
}

export const MIN_HEIGHT = 0
export const MAX_HEIGHT = 40

// --- sculpt ------------------------------------------------------------------

export function raise(doc: ReadonlyMapDoc, cells: Cell[], delta: number): Patch[] {
  const patches: Patch[] = []
  for (const [x, y] of cells) {
    const index = cellIndex(doc.size, x, y)
    const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, doc.terrain.height[index] + delta))
    patches.push({ t: 'terrain', field: 'height', index, value: next }, ...drainedBy(doc, index, next))
  }
  return [...patches, ...regroundObjects(doc, cells, patches)]
}

/**
 * Water is a surface over the terrain, never level with it (ruling of
 * 2026-09-12): a column whose ground reaches its water line has no water.
 * Every height write goes through here so the invariant holds in the same
 * edit rather than depending on whoever sculpted to remember it.
 */
function drainedBy(doc: ReadonlyMapDoc, index: number, height: number): Patch[] {
  const water = doc.terrain.water[index]
  return water !== NO_WATER && height >= water ? [{ t: 'terrain', field: 'water', index, value: NO_WATER }] : []
}

export function flatten(doc: ReadonlyMapDoc, cells: Cell[], height: number): Patch[] {
  const clamped = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height))
  const patches: Patch[] = cells.flatMap(([x, y]) => {
    const index = cellIndex(doc.size, x, y)
    return [{ t: 'terrain', field: 'height', index, value: clamped }, ...drainedBy(doc, index, clamped)]
  })
  return [...patches, ...regroundObjects(doc, cells, patches)]
}

export function setMaterial(doc: ReadonlyMapDoc, cells: Cell[], material: number): Patch[] {
  return cells.map(([x, y]) => ({
    t: 'terrain',
    field: 'material',
    index: cellIndex(doc.size, x, y),
    value: material,
  }))
}

/** Toggle a cell between a cliff edge and a ramp descending toward `dir`. */
export function setRamp(doc: ReadonlyMapDoc, cells: Cell[], dir: number): Patch[] {
  const patches: Patch[] = cells.map(([x, y]) => {
    const index = cellIndex(doc.size, x, y)
    const current = doc.terrain.ramp[index]
    return {
      t: 'terrain',
      field: 'ramp',
      index,
      value: current === dir ? NO_RAMP : dir,
    }
  })
  return [...patches, ...regroundObjects(doc, cells, patches)]
}

/**
 * Set the water line, or clear it with `null`. A line at or below a column's
 * ground is not water (see `drainedBy`), so such a cell is left alone rather
 * than given an invisible, invalid value.
 */
export function setWater(doc: ReadonlyMapDoc, cells: Cell[], level: number | null): Patch[] {
  const patches: Patch[] = []
  for (const [x, y] of cells) {
    const index = cellIndex(doc.size, x, y)
    if (level !== null && level <= doc.terrain.height[index]) continue
    patches.push({ t: 'terrain', field: 'water', index, value: level === null ? NO_WATER : level })
  }
  return patches
}


// --- paint -------------------------------------------------------------------

export function paintTop(doc: ReadonlyMapDoc, cells: Cell[], tile: number | undefined): Patch[] {
  void doc
  return cells.map(([x, y]) => ({ t: 'paint', layer: 'top', key: topKey(x, y), value: tile }))
}

export function paintCliff(
  doc: ReadonlyMapDoc,
  faces: Array<{ x: number; y: number; dir: number; level: number }>,
  tile: number | undefined,
): Patch[] {
  void doc
  return faces.map((face) => ({
    t: 'paint',
    layer: 'cliff',
    key: cliffKey(face.x, face.y, face.dir, face.level),
    value: tile,
  }))
}

export function paintTint(doc: ReadonlyMapDoc, cells: Cell[], color: number | undefined): Patch[] {
  void doc
  return cells.map(([x, y]) => ({ t: 'paint', layer: 'tint', key: tintKey(x, y), value: color }))
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

/**
 * The plural form, for `objects.delete`. Not `ids.flatMap(removeObject)`:
 * every call rebuilds the WHOLE order from the document as it stands now, and
 * the document has not been written yet, so the second list would still
 * contain the first id and the last patch to land would put it back. The
 * order is filtered once, against the whole doomed set.
 */
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

/**
 * A patch carries a value the applier will install as-is, so an object read
 * through the readonly view is copied before it goes into one: the copy is
 * what the type asks for (`MapObject`, with mutable tuples), and it is also
 * what keeps the undo inverse — which captures the value being replaced —
 * from aliasing the value replacing it.
 */
function cloneObject(object: DeepReadonly<MapObject>): MapObject {
  return {
    ...object,
    position: [...object.position],
    facing: { ...object.facing },
    anchorCell: object.anchorCell ? [...object.anchorCell] : null,
  }
}

/**
 * Grounding. An object anchored to a cell rides the terrain, so sculpting
 * moves it instead of burying it. Called by the sculpt ops above with the
 * heights they are about to write, since the document has not changed yet.
 */
export function regroundObjects(doc: ReadonlyMapDoc, cells: Cell[], pending: Patch[]): Patch[] {
  if (doc.objectOrder.length === 0) return []

  const touched = new Set(cells.map(([x, y]) => `${x},${y}`))
  const heightOverride = new Map<number, number>()
  const rampOverride = new Map<number, number>()
  for (const patch of pending) {
    if (patch.t !== 'terrain') continue
    if (patch.field === 'height') heightOverride.set(patch.index, patch.value)
    if (patch.field === 'ramp') rampOverride.set(patch.index, patch.value)
  }
  if (heightOverride.size === 0 && rampOverride.size === 0) return []

  // Evaluate the ground against a shallow view of the post-edit document,
  // rather than applying and rolling back. The two copied arrays are the only
  // thing written, and they are written before the view is typed readonly.
  const height = doc.terrain.height.slice()
  const ramp = doc.terrain.ramp.slice()
  for (const [index, value] of heightOverride) height[index] = value
  for (const [index, value] of rampOverride) ramp[index] = value
  const after: ReadonlyMapDoc = { ...doc, terrain: { ...doc.terrain, height, ramp } }

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

/** Drop an object onto whatever surface is under it. */
export function groundedPosition(
  doc: ReadonlyMapDoc,
  worldX: number,
  worldZ: number,
): [number, number, number] {
  return [worldX, groundHeight(doc, worldX, worldZ), worldZ]
}

export function heightToWorld(halfTiles: number): number {
  return worldHeight(halfTiles)
}
