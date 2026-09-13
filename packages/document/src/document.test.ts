import { describe, expect, it } from 'vitest'

import { autotileMask, MASK_EAST, MASK_NORTH, MASK_SOUTH, MASK_WEST } from './autotile'
import { applyPatches, History, inversePatch, patchAddress, type Patch, type StrokeRecord } from './edits'
import { cellIndex, createMap, defaultFacing, NO_RAMP, type MapDoc, type MapObject, type ReadonlyMapDoc } from './document'
import { childrenOf, descendantsOf, type VoxelStructure } from './structure'
import { deserialize, LoadError, serialize } from './io'
import { addObject, addSketchPoint, addStructure, brushCells, closeSketch, createSketch, deleteSketchPoint, fillCells, flatten, paintTop, placeStructureOnto, raise, removeObject, removeStructure, reparentStructure, setRamp, setSketch, updateObject } from './ops'
import { cliffKey, countDormant, topKey } from './paint'
import { EditorStore } from './store'
import { frameOf, groundHeight, structureAt } from './terrain'

function objectAt(id: string, x: number, z: number): MapObject {
  return {
    id,
    name: id,
    sprite: 'tree',
    position: [x, 0, z],
    rotationY: 0,
    scale: 1,
    display: 'auto',
    facing: defaultFacing(),
    anchorCell: [x, z],
    seed: 0,
    locked: false,
    hidden: false,
  }
}

/** The one voxel volume a fresh level has, as the mutable thing a test sets up. */
const ground = (doc: MapDoc | ReadonlyMapDoc): VoxelStructure => doc.structures.ground as VoxelStructure

function setHeight(doc: MapDoc, x: number, y: number, h: number): void {
  const g = ground(doc)
  g.terrain.height[cellIndex(g.size, x, y)] = h
}

// `JSON.parse` returns `any` here on purpose: the whole point of these tests
// is to mangle the on-disk shape into something the loader must refuse, so
// typing it more tightly would just fight the tests. `OnDisk` used to pin this
// down for `no-unsafe-*`, but test files are now exempt from lint entirely
// (#38), so the type stopped earning its place.
function parseOnDisk(doc: MapDoc) {
  return JSON.parse(serialize(doc))
}

describe('edits', () => {
  it('derives an exact inverse without the tool writing one', () => {
    const doc = createMap(4, 4)
    const before = ground(doc).terrain.height.slice()

    const inverse = applyPatches(doc, [
      { t: 'voxel', id: ground(doc).id, field: 'height', index: 5, value: 9 },
      { t: 'voxel', id: ground(doc).id, field: 'height', index: 6, value: 7 },
    ])
    expect(ground(doc).terrain.height[5]).toBe(9)

    applyPatches(doc, inverse)
    expect(ground(doc).terrain.height).toEqual(before)
  })

  it('inverts repeated writes to one address in the right order', () => {
    const doc = createMap(4, 4)
    ground(doc).terrain.height[0] = 1

    const inverse = applyPatches(doc, [
      { t: 'voxel', id: ground(doc).id, field: 'height', index: 0, value: 2 },
      { t: 'voxel', id: ground(doc).id, field: 'height', index: 0, value: 3 },
    ])
    expect(ground(doc).terrain.height[0]).toBe(3)

    applyPatches(doc, inverse)
    expect(ground(doc).terrain.height[0]).toBe(1)
  })

  it('undoes and redoes through the history', () => {
    const doc = createMap(4, 4)
    const history = new History()
    const patches = [{ t: 'voxel' as const, id: ground(doc).id, field: 'height' as const, index: 3, value: 11 }]
    history.push({ label: 'Raise', patches, inverse: applyPatches(doc, patches) })

    expect(ground(doc).terrain.height[3]).toBe(11)
    history.undo(doc)
    expect(ground(doc).terrain.height[3]).toBe(2)
    history.redo(doc)
    expect(ground(doc).terrain.height[3]).toBe(11)
  })
})

describe('patch addresses and inverses', () => {
  it('keys a patch by the slot it writes, and nothing else', () => {
    expect(patchAddress({ t: 'voxel', id: 'g', field: 'height', index: 7, value: 1 })).toBe(patchAddress({ t: 'voxel', id: 'g', field: 'height', index: 7, value: 9 }))
    expect(patchAddress({ t: 'voxel', id: 'g', field: 'height', index: 7, value: 1 })).not.toBe(patchAddress({ t: 'voxel', id: 'g', field: 'water', index: 7, value: 1 }))
    expect(patchAddress({ t: 'voxelPaint', id: 'g', layer: 'top', key: '1,2', value: 3 })).not.toBe(patchAddress({ t: 'voxelPaint', id: 'g', layer: 'cliff', key: '1,2', value: 3 }))
    expect(patchAddress({ t: 'object', id: 'a', value: undefined })).toBe('object:a')
    expect(patchAddress({ t: 'doc', field: 'camera', value: null })).toBe('doc:camera')
  })

  it('reads the before-value the applier would have returned, without writing', () => {
    const doc = createMap(4, 4)
    setHeight(doc, 1, 1, 6)
    const patch: Patch = { t: 'voxel', id: ground(doc).id, field: 'height', index: cellIndex(ground(doc).size, 1, 1), value: 9 }
    const before = inversePatch(doc, patch)
    expect(before).toEqual({ ...patch, value: 6 })
    expect(ground(doc).terrain.height[patch.index]).toBe(6)
    // Same answer as the applier, which is what makes the two paths agree.
    expect(applyPatches(doc, [patch])).toEqual([before])
    expect(inversePatch(doc, { t: 'voxelPaint', id: ground(doc).id, layer: 'top', key: '0,0', value: 1 })).toEqual({ t: 'voxelPaint', id: ground(doc).id, layer: 'top', key: '0,0', value: undefined })
  })
})

/**
 * What the stroke actor does per tick, in miniature: read each patch's
 * before-value BEFORE applying it, keep the first inverse and the last forward
 * value per address, and hand the pair back on release.
 */
function compactingStroke(store: EditorStore, label: string): { apply(patches: Patch[]): void; end(): void } {
  const compaction = new Map<string, { first: Patch; last: Patch }>()
  store.beginStroke(label)
  return {
    apply(patches) {
      for (const patch of patches) {
        const key = patchAddress(patch)
        const entry = compaction.get(key)
        if (entry) entry.last = patch
        else compaction.set(key, { first: inversePatch(store.reader.doc, patch), last: patch })
      }
      store.applyStrokeTick(patches)
    },
    end() {
      const record: StrokeRecord = { patches: [], inverse: [] }
      for (const { first, last } of compaction.values()) {
        record.patches.push(last)
        record.inverse.push(first)
      }
      store.endStroke(record)
    },
  }
}

describe('store', () => {
  it('records a stroke as the one entry its record describes', () => {
    const store = new EditorStore(createMap(8, 8))
    const stroke = compactingStroke(store, 'Raise')
    for (let i = 0; i < 5; i++) stroke.apply(raise(store.reader.doc, ground(store.reader.doc), [[i, 0]], 1))
    stroke.end()

    expect(ground(store.reader.doc).terrain.height[0]).toBe(3)
    expect(store.reader.undoLabel()).toBe('Raise')
    store.undo()
    for (let i = 0; i < 5; i++) expect(ground(store.reader.doc).terrain.height[i]).toBe(2)
    expect(store.reader.canUndo()).toBe(false)
  })

  it('applies every tick immediately but keeps no history until the record arrives', () => {
    const store = new EditorStore(createMap(8, 8))
    const stroke = compactingStroke(store, 'Raise')
    stroke.apply(raise(store.reader.doc, ground(store.reader.doc), [[0, 0]], 1))
    // The terrain moved mid-drag, and the drag is not an undo entry yet.
    expect(ground(store.reader.doc).terrain.height[0]).toBe(3)
    expect(store.reader.canUndo()).toBe(false)
    expect(store.inStroke).toBe(true)

    // Undo mid-stroke is refused rather than closing the stroke early: the
    // old close-and-undo left the rest of the drag with no record at all.
    store.undo()
    expect(ground(store.reader.doc).terrain.height[0]).toBe(3)

    stroke.end()
    expect(store.reader.canUndo()).toBe(true)
  })

  it('records an ordinary edit that lands mid-stroke, so one undo brings it back', () => {
    // The Delete keybinding is on `window` and fires during a pointer drag —
    // pointer capture does not stop it — so an app write concurrent with a
    // stroke is reachable, not hypothetical. It used to be folded into the
    // open stroke; for one commit it was recorded by nothing at all.
    const store = new EditorStore(createMap(8, 8))
    const stroke = compactingStroke(store, 'Raise')
    stroke.apply(raise(store.reader.doc, ground(store.reader.doc), [[0, 0]], 1))
    store.apply('Elsewhere', raise(store.reader.doc, ground(store.reader.doc), [[7, 7]], 1))
    expect(ground(store.reader.doc).terrain.height[cellIndex(ground(store.reader.doc).size, 7, 7)]).toBe(3)

    stroke.end()
    // Two entries, innermost last: the mid-stroke edit unwinds on its own undo
    // and the drag unwinds on the next.
    expect(store.reader.undoLabel()).toBe('Raise')
    store.undo()
    expect(ground(store.reader.doc).terrain.height[0]).toBe(2)
    expect(store.reader.undoLabel()).toBe('Elsewhere')
    store.undo()
    expect(ground(store.reader.doc).terrain.height[cellIndex(ground(store.reader.doc).size, 7, 7)]).toBe(2)
    expect(store.reader.canUndo()).toBe(false)
  })

  it('refuses a mid-stroke edit at an address the stroke already wrote', () => {
    // The collision the previous test does NOT have: same address, two
    // entries. Recorded, they unwind in an order that never happened — the
    // stroke's entry sits ON TOP of the concurrent one but holds the older
    // before-value, so one undo restores a mid-drag state and the next
    // restores the state before the drag began, out of order.
    const store = new EditorStore(createMap(8, 8))
    const stroke = compactingStroke(store, 'Raise')
    stroke.apply(raise(store.reader.doc, ground(store.reader.doc), [[0, 0]], 1))

    store.apply('Collides', raise(store.reader.doc, ground(store.reader.doc), [[0, 0]], 5))
    // Refused whole: not applied, and not an entry.
    expect(ground(store.reader.doc).terrain.height[0]).toBe(3)

    stroke.end()
    expect(store.reader.undoLabel()).toBe('Raise')
    store.undo()
    expect(ground(store.reader.doc).terrain.height[0]).toBe(2)
    expect(store.reader.canUndo()).toBe(false)
  })

  it('refuses the colliding edit whole, never the half of it that does not collide', () => {
    // `removeObject` is two patches — the object and the order — and the
    // stroke owns only the first. Applying the other half would drop the id
    // from `objectOrder` while `objects` kept it: the orphan, arrived at from
    // the other side.
    const store = new EditorStore(createMap(8, 8))
    const object = objectAt('a', 1, 1)
    store.apply('Add object', addObject(store.reader.doc, object))

    const stroke = compactingStroke(store, 'Edit object')
    stroke.apply(updateObject(store.reader.doc, 'a', { position: [4, 0, 4] }))
    store.apply('Delete object', removeObject(store.reader.doc, 'a'))
    expect(store.reader.doc.objectOrder).toEqual(['a'])
    expect(store.reader.doc.objects.a).toBeDefined()

    stroke.end()
    store.undo()
    expect(store.reader.doc.objects.a?.position).toEqual([1, 0, 1])
    expect(store.reader.doc.objectOrder).toEqual(['a'])
  })

  it('refuses a stroke tick with no stroke open, since it addresses a replaced document', () => {
    const store = new EditorStore(createMap(8, 8))
    store.applyStrokeTick(raise(store.reader.doc, ground(store.reader.doc), [[0, 0]], 1))
    expect(ground(store.reader.doc).terrain.height[0]).toBe(2)
    expect(store.reader.canUndo()).toBe(false)
  })

  it('drops a record that arrives after the document was replaced', () => {
    const store = new EditorStore(createMap(8, 8, 'First'))
    const stroke = compactingStroke(store, 'Raise')
    stroke.apply(raise(store.reader.doc, ground(store.reader.doc), [[0, 0]], 1))
    store.replace(createMap(4, 4, 'Second'))
    stroke.end()
    expect(store.reader.canUndo()).toBe(false)
    expect(store.reader.doc.name).toBe('Second')
  })

  it('closes an empty stroke without an entry', () => {
    const store = new EditorStore(createMap(8, 8))
    store.beginStroke('Nothing')
    store.endStroke(null)
    expect(store.reader.canUndo()).toBe(false)
    expect(store.inStroke).toBe(false)
  })

  it('drops no-op patches so idle brushing does not fill the undo stack', () => {
    const store = new EditorStore(createMap(8, 8))
    store.apply('Flatten', flatten(store.reader.doc, ground(store.reader.doc), [[0, 0]], 2))
    expect(store.reader.canUndo()).toBe(false)
  })

  it('marks the neighbouring chunks dirty at a chunk border', () => {
    const store = new EditorStore(createMap(48, 48))
    store.takeDirtyChunks()
    store.apply('Raise', raise(store.reader.doc, ground(store.reader.doc), [[16, 16]], 1))
    const dirty = store.takeDirtyChunks()
    expect(dirty).toContain('ground/1,1')
    expect(dirty).toContain('ground/0,0')
  })
})

describe('paint survives sculpt', () => {
  it('never emits a paint patch from a sculpt op', () => {
    const doc = createMap(8, 8)
    const ops = [
      raise(doc, ground(doc), [[1, 1]], 2),
      flatten(doc, ground(doc), [[1, 1]], 5),
      setRamp(doc, ground(doc), [[1, 1]], 0),
    ]
    for (const patches of ops) {
      expect(patches.some((patch) => patch.t === 'voxelPaint')).toBe(false)
    }
  })

  it('reports dormant paint as a diagnostic', () => {
    const doc = createMap(4, 4)
    ground(doc).paint.top[topKey(1, 1)] = 3
    ground(doc).paint.cliff[cliffKey(9, 9, 0, 0)] = 4
    const counts = countDormant(ground(doc).paint, (kind) => kind === 'top')
    expect(counts.top).toBe(0)
    expect(counts.cliff).toBe(1)
  })
})

describe('autotile', () => {
  it('connects to matching neighbours at the same height', () => {
    const doc = createMap(5, 5)
    expect(autotileMask(ground(doc), 2, 2)).toBe(MASK_NORTH | MASK_EAST | MASK_SOUTH | MASK_WEST)
  })

  it('breaks the connection across a height change', () => {
    const doc = createMap(5, 5)
    setHeight(doc, 3, 2, 6)
    const mask = autotileMask(ground(doc), 2, 2)
    expect(mask & MASK_EAST).toBe(0)
    expect(mask & MASK_WEST).toBe(MASK_WEST)
  })

  it('treats the map border as connected so it does not ring the level in edge tiles', () => {
    const doc = createMap(5, 5)
    expect(autotileMask(ground(doc), 0, 0)).toBe(15)
  })
})

describe('terrain queries', () => {
  it('interpolates a ramp instead of stepping it', () => {
    const doc = createMap(4, 4)
    setHeight(doc, 1, 1, 4)
    ground(doc).terrain.ramp[cellIndex(ground(doc).size, 1, 1)] = 0 // descends east

    const high = groundHeight(doc, 1.01, 1.5)
    const low = groundHeight(doc, 1.99, 1.5)
    const mid = groundHeight(doc, 1.5, 1.5)
    expect(high).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(low)
    expect(mid).toBeCloseTo(1.5, 2)
  })

  it('agrees with the mesher about a flat cell', () => {
    const doc = createMap(4, 4)
    setHeight(doc, 2, 2, 6)
    expect(groundHeight(doc, 2.5, 2.5)).toBeCloseTo(3, 6)
  })
})

describe('object grounding', () => {
  it('carries an anchored object up with the terrain', () => {
    const store = new EditorStore(createMap(8, 8))
    const id = 'obj_test'
    store.apply('Add', [
      {
        t: 'object',
        id,
        value: {
          id,
          name: 'Tree',
          sprite: 'tree',
          position: [2.5, 1, 2.5],
          rotationY: 0,
          scale: 1,
          display: 'auto',
          facing: {
            facings: 1,
            mirror: true,
            back: 'mirror',
            transition: 'flip',
            durationMs: 200,
            hysteresisDeg: 8,
            hinge: 'center',
          },
          anchorCell: [2, 2],
          seed: 0,
          locked: false,
          hidden: false,
        },
      },
      { t: 'objectOrder', value: [id] },
    ])

    store.apply('Raise', raise(store.reader.doc, ground(store.reader.doc), [[2, 2]], 4))
    expect(store.reader.doc.objects[id].position[1]).toBeCloseTo(3, 6)

    store.undo()
    expect(store.reader.doc.objects[id].position[1]).toBeCloseTo(1, 6)
  })

  it('leaves unanchored objects where they are', () => {
    const doc = createMap(8, 8)
    const patches = raise(doc, ground(doc), [[2, 2]], 4)
    expect(patches.some((patch) => patch.t === 'object')).toBe(false)
  })
})

describe('brushes', () => {
  it('sizes a square brush correctly and clips at the map edge', () => {
    const doc = createMap(8, 8)
    expect(brushCells(ground(doc), 4, 4, { size: 3, shape: 'square' })).toHaveLength(9)
    expect(brushCells(ground(doc), 0, 0, { size: 3, shape: 'square' })).toHaveLength(4)
  })

  it('fills a region of matching cells', () => {
    const doc = createMap(8, 8)
    setHeight(doc, 4, 0, 9)
    for (let y = 0; y < 8; y++) setHeight(doc, 4, y, 9)
    const region = fillCells(ground(doc), 0, 0)
    expect(region.length).toBe(32)
  })
})

describe('io', () => {
  it('round-trips a document', () => {
    const store = new EditorStore(createMap(6, 6, 'Test Map'))
    store.apply('Raise', raise(store.reader.doc, ground(store.reader.doc), [[1, 1]], 3))
    store.apply('Paint', paintTop(ground(store.reader.doc), [[1, 1]], 7))

    const restored = deserialize(serialize(store.reader.doc))
    expect(restored.name).toBe('Test Map')
    expect(ground(restored).terrain.height).toEqual(ground(store.reader.doc).terrain.height)
    expect(ground(restored).paint.top).toEqual(ground(store.reader.doc).paint.top)
    expect(restored.formatVersion).toBe(2)
  })

  it('refuses an older format outright: no migrations until data exists', () => {
    const doc = createMap(4, 4)
    const raw = parseOnDisk(doc)
    raw.formatVersion = 1
    expect(() => deserialize(JSON.stringify(raw))).toThrow(/no migration/)
    delete raw.formatVersion
    expect(() => deserialize(JSON.stringify(raw))).toThrow(LoadError)
  })

  it('round-trips a sketch standing on the ground, and refuses a parent the map lacks', () => {
    const doc = createMap(4, 4)
    const sketch = createSketch(ground(doc).id, 'Island')
    sketch.points = [
      { x: 1, z: 1, smooth: true },
      { x: 3, z: 1, smooth: false },
      { x: 2, z: 3, smooth: true },
    ]
    sketch.closed = true
    applyPatches(doc, addStructure(doc, sketch))
    const restored = deserialize(serialize(doc))
    expect(restored.structureOrder).toEqual(doc.structureOrder)
    expect(restored.structures[sketch.id]).toEqual(sketch)

    const raw = parseOnDisk(doc)
    raw.structures[sketch.id].parent = 'nowhere'
    expect(() => deserialize(JSON.stringify(raw))).toThrow(LoadError)
  })

  it('refuses a document from a newer editor', () => {
    const doc = createMap(4, 4)
    const raw = parseOnDisk(doc)
    raw.formatVersion = 99
    expect(() => deserialize(JSON.stringify(raw))).toThrow(LoadError)
  })

  it('rejects a terrain array of the wrong length', () => {
    const doc = createMap(4, 4)
    const raw = parseOnDisk(doc)
    raw.structures[ground(doc).id].terrain.height = [1, 2, 3]
    expect(() => deserialize(JSON.stringify(raw))).toThrow(LoadError)
  })

  it('preserves dormant paint across a save and load', () => {
    const doc = createMap(4, 4)
    ground(doc).paint.cliff[cliffKey(1, 1, 0, 30)] = 5
    ground(doc).terrain.ramp[0] = NO_RAMP
    const restored = deserialize(serialize(doc))
    expect(ground(restored).paint.cliff[cliffKey(1, 1, 0, 30)]).toBe(5)
  })
})

describe('structures', () => {
  const island = (): MapDoc => {
    const doc = createMap(6, 6)
    const sketch = createSketch(ground(doc).id, 'Island', { x: 0, z: 0, yaw: 0 })
    applyPatches(doc, addStructure(doc, sketch))
    for (const p of [
      { x: 1, z: 1, smooth: false },
      { x: 5, z: 1, smooth: false },
      { x: 5, z: 5, smooth: false },
      { x: 1, z: 5, smooth: false },
    ])
      applyPatches(doc, addSketchPoint(doc, sketch.id, p))
    applyPatches(doc, closeSketch(doc, sketch.id))
    return doc
  }
  const sketchId = (doc: MapDoc) => doc.structureOrder[1]

  it('a closed sketch on the ground raises the height under it by its layers', () => {
    const doc = island()
    // Ground is 2 half-tiles (1 unit); the sketch adds 3 layers (1.5 units) on top of the cap it stands on.
    expect(groundHeight(doc, 3, 3)).toBeCloseTo(1 + 1.5, 6)
    expect(groundHeight(doc, 0.5, 0.5)).toBeCloseTo(1, 6)
  })

  it('an open sketch has no height, and closing needs three points', () => {
    const doc = createMap(6, 6)
    const sketch = createSketch(ground(doc).id)
    applyPatches(doc, addStructure(doc, sketch))
    applyPatches(doc, addSketchPoint(doc, sketch.id, { x: 1, z: 1, smooth: true }))
    applyPatches(doc, addSketchPoint(doc, sketch.id, { x: 4, z: 1, smooth: true }))
    expect(closeSketch(doc, sketch.id)).toEqual([])
    expect(groundHeight(doc, 2, 1)).toBeCloseTo(1, 6)
  })

  it("a tier stands on its parent: its base is the parent's cap, its placement relative to it", () => {
    const doc = island()
    const tier = createSketch(sketchId(doc), 'Tier', { x: 2, z: 2, yaw: 0 })
    tier.points = [
      { x: 0, z: 0, smooth: false },
      { x: 2, z: 0, smooth: false },
      { x: 2, z: 2, smooth: false },
      { x: 0, z: 2, smooth: false },
    ]
    tier.closed = true
    tier.layers = 2
    applyPatches(doc, addStructure(doc, tier))
    // World (3, 3) is inside the tier (local 1, 1): ground 1 + island 1.5 + tier 1.
    expect(groundHeight(doc, 3, 3)).toBeCloseTo(3.5, 6)
    // World (1.5, 1.5) is on the island but outside the tier.
    expect(groundHeight(doc, 1.5, 1.5)).toBeCloseTo(2.5, 6)
  })

  it('a quarter turn turns the child with it', () => {
    const doc = island()
    const tier = createSketch(sketchId(doc), 'Tier', { x: 3, z: 3, yaw: 1 })
    // A 2×1 bar along local +x; turned a quarter it lies along world +z.
    tier.points = [
      { x: 0, z: -0.5, smooth: false },
      { x: 2, z: -0.5, smooth: false },
      { x: 2, z: 0.5, smooth: false },
      { x: 0, z: 0.5, smooth: false },
    ]
    tier.closed = true
    tier.layers = 2
    applyPatches(doc, addStructure(doc, tier))
    expect(groundHeight(doc, 3, 4.5)).toBeCloseTo(3.5, 6)
    expect(groundHeight(doc, 4.5, 3)).toBeCloseTo(2.5, 6)
  })

  it('deleting a structure takes everything standing on it, and undo brings all of it back', () => {
    const doc = island()
    const islandId = sketchId(doc)
    const tier = createSketch(islandId, 'Tier')
    applyPatches(doc, addStructure(doc, tier))
    expect(descendantsOf(doc, islandId)).toEqual([tier.id])
    const inverse = applyPatches(doc, removeStructure(doc, islandId))
    expect(doc.structures[islandId]).toBeUndefined()
    expect(doc.structures[tier.id]).toBeUndefined()
    expect(doc.structureOrder).toEqual([ground(doc).id])
    applyPatches(doc, inverse)
    expect(doc.structures[tier.id]?.parent).toBe(islandId)
    expect(childrenOf(doc, islandId).map((s) => s.id)).toEqual([tier.id])
  })

  it('structureAt answers the highest structure under a point, a child over its parent, and leaves out what is excluded', () => {
    const doc = island()
    const islandId = sketchId(doc)
    const tier = createSketch(islandId, 'Tier', { x: 2, z: 2, yaw: 0 })
    tier.points = [
      { x: 0, z: 0, smooth: false },
      { x: 2, z: 0, smooth: false },
      { x: 2, z: 2, smooth: false },
      { x: 0, z: 2, smooth: false },
    ]
    tier.closed = true
    applyPatches(doc, addStructure(doc, tier))

    expect(structureAt(doc, 0.5, 0.5)).toBe('ground')
    expect(structureAt(doc, 1.5, 1.5)).toBe(islandId)
    expect(structureAt(doc, 3, 3)).toBe(tier.id)
    expect(structureAt(doc, 3, 3, new Set([tier.id]))).toBe(islandId)
    expect(structureAt(doc, 3, 3, new Set([tier.id, islandId]))).toBe('ground')
    expect(structureAt(doc, -1, -1)).toBeNull()
  })

  it('placeStructureOnto keeps where a structure is in the world while it changes parent, and re-measures its placement', () => {
    const doc = island()
    const islandId = sketchId(doc)
    applyPatches(doc, [{ t: 'structure.meta', id: islandId, field: 'placement', value: { x: 1, z: 1, yaw: 1 } }])
    const tier = createSketch(islandId, 'Tier', { x: 2, z: 1, yaw: 1 })
    applyPatches(doc, addStructure(doc, tier))
    const before = frameOf(doc, tier.id)

    // Onto the ground at the same world point: a different placement, the same frame (but for the height it stands at).
    applyPatches(doc, placeStructureOnto(doc, tier.id, 'ground', { x: before.x, z: before.z }))
    expect(doc.structures[tier.id]?.parent).toBe('ground')
    expect(doc.structures[tier.id]?.placement).toEqual({ x: before.x, z: before.z, yaw: 2 })
    const after = frameOf(doc, tier.id)
    expect([after.x, after.z, after.yaw]).toEqual([before.x, before.z, before.yaw])

    // Back onto the island, snapped in the island's frame.
    applyPatches(doc, placeStructureOnto(doc, tier.id, islandId, { x: before.x + 0.4, z: before.z }, Math.round))
    expect(doc.structures[tier.id]?.parent).toBe(islandId)
    expect(doc.structures[tier.id]?.placement).toEqual({ x: 2, z: 1, yaw: 1 })

    // Refused for the root, for a cycle, and for a parent that is not there.
    expect(placeStructureOnto(doc, 'ground', null, { x: 0, z: 0 })).toEqual([])
    expect(placeStructureOnto(doc, islandId, tier.id, { x: 0, z: 0 })).toEqual([])
    expect(placeStructureOnto(doc, tier.id, 'nope', { x: 0, z: 0 })).toEqual([])
    // Nothing changes: nothing to write.
    expect(placeStructureOnto(doc, tier.id, islandId, { x: before.x, z: before.z }, Math.round)).toEqual([])
  })

  it('refuses to make a structure its own ancestor', () => {
    const doc = island()
    const islandId = sketchId(doc)
    const tier = createSketch(islandId, 'Tier')
    applyPatches(doc, addStructure(doc, tier))
    expect(reparentStructure(doc, islandId, tier.id)).toEqual([])
    expect(reparentStructure(doc, islandId, islandId)).toEqual([])
    expect(reparentStructure(doc, tier.id, null)).toHaveLength(1)
  })

  it("a sketch edit's inverse is a copy, not the live points", () => {
    const doc = island()
    const id = sketchId(doc)
    const inverse = applyPatches(doc, setSketch(doc, id, { layers: 7 }))
    expect(inverse).toEqual([{ t: 'sketch', id, field: 'layers', value: 3 }])
    const beforePoints = applyPatches(doc, deleteSketchPoint(doc, id, 0))
    // Mutating the document after the fact must not reach into the recorded inverse.
    applyPatches(doc, addSketchPoint(doc, id, { x: 9, z: 9, smooth: true }))
    const kept = beforePoints[0]
    expect(kept.t === 'sketch' && kept.field === 'points' ? kept.value.length : -1).toBe(4)
  })

  it('a closed sketch that loses a point below three opens again', () => {
    const doc = island()
    const id = sketchId(doc)
    applyPatches(doc, deleteSketchPoint(doc, id, 0))
    applyPatches(doc, deleteSketchPoint(doc, id, 0))
    expect((doc.structures[id] as { closed: boolean }).closed).toBe(false)
  })
})
