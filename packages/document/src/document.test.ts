import { describe, expect, it } from 'vitest'

import { autotileMask, MASK_EAST, MASK_NORTH, MASK_SOUTH, MASK_WEST } from './autotile'
import { applyPatches, History, inversePatch, patchAddress, type Patch, type StrokeRecord } from './edits'
import { cellIndex, createMap, defaultFacing, NO_RAMP, type MapDoc, type MapObject } from './document'
import { deserialize, LoadError, serialize } from './io'
import { addObject, brushCells, fillCells, flatten, paintTop, raise, removeObject, setRamp, updateObject } from './ops'
import { cliffKey, countDormant, topKey } from './paint'
import { EditorStore } from './store'
import { groundHeight } from './terrain'

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

function setHeight(doc: MapDoc, x: number, y: number, h: number): void {
  doc.terrain.height[cellIndex(doc.size, x, y)] = h
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
    const before = doc.terrain.height.slice()

    const inverse = applyPatches(doc, [
      { t: 'terrain', field: 'height', index: 5, value: 9 },
      { t: 'terrain', field: 'height', index: 6, value: 7 },
    ])
    expect(doc.terrain.height[5]).toBe(9)

    applyPatches(doc, inverse)
    expect(doc.terrain.height).toEqual(before)
  })

  it('inverts repeated writes to one address in the right order', () => {
    const doc = createMap(4, 4)
    doc.terrain.height[0] = 1

    const inverse = applyPatches(doc, [
      { t: 'terrain', field: 'height', index: 0, value: 2 },
      { t: 'terrain', field: 'height', index: 0, value: 3 },
    ])
    expect(doc.terrain.height[0]).toBe(3)

    applyPatches(doc, inverse)
    expect(doc.terrain.height[0]).toBe(1)
  })

  it('undoes and redoes through the history', () => {
    const doc = createMap(4, 4)
    const history = new History()
    const patches = [{ t: 'terrain' as const, field: 'height' as const, index: 3, value: 11 }]
    history.push({ label: 'Raise', patches, inverse: applyPatches(doc, patches) })

    expect(doc.terrain.height[3]).toBe(11)
    history.undo(doc)
    expect(doc.terrain.height[3]).toBe(2)
    history.redo(doc)
    expect(doc.terrain.height[3]).toBe(11)
  })
})

describe('patch addresses and inverses', () => {
  it('keys a patch by the slot it writes, and nothing else', () => {
    expect(patchAddress({ t: 'terrain', field: 'height', index: 7, value: 1 })).toBe(patchAddress({ t: 'terrain', field: 'height', index: 7, value: 9 }))
    expect(patchAddress({ t: 'terrain', field: 'height', index: 7, value: 1 })).not.toBe(patchAddress({ t: 'terrain', field: 'water', index: 7, value: 1 }))
    expect(patchAddress({ t: 'paint', layer: 'top', key: '1,2', value: 3 })).not.toBe(patchAddress({ t: 'paint', layer: 'cliff', key: '1,2', value: 3 }))
    expect(patchAddress({ t: 'object', id: 'a', value: undefined })).toBe('object:a')
    expect(patchAddress({ t: 'doc', field: 'camera', value: null })).toBe('doc:camera')
  })

  it('reads the before-value the applier would have returned, without writing', () => {
    const doc = createMap(4, 4)
    setHeight(doc, 1, 1, 6)
    const patch: Patch = { t: 'terrain', field: 'height', index: cellIndex(doc.size, 1, 1), value: 9 }
    const before = inversePatch(doc, patch)
    expect(before).toEqual({ ...patch, value: 6 })
    expect(doc.terrain.height[patch.index]).toBe(6)
    // Same answer as the applier, which is what makes the two paths agree.
    expect(applyPatches(doc, [patch])).toEqual([before])
    expect(inversePatch(doc, { t: 'paint', layer: 'top', key: '0,0', value: 1 })).toEqual({ t: 'paint', layer: 'top', key: '0,0', value: undefined })
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
    for (let i = 0; i < 5; i++) stroke.apply(raise(store.reader.doc, [[i, 0]], 1))
    stroke.end()

    expect(store.reader.doc.terrain.height[0]).toBe(3)
    expect(store.reader.undoLabel()).toBe('Raise')
    store.undo()
    for (let i = 0; i < 5; i++) expect(store.reader.doc.terrain.height[i]).toBe(2)
    expect(store.reader.canUndo()).toBe(false)
  })

  it('applies every tick immediately but keeps no history until the record arrives', () => {
    const store = new EditorStore(createMap(8, 8))
    const stroke = compactingStroke(store, 'Raise')
    stroke.apply(raise(store.reader.doc, [[0, 0]], 1))
    // The terrain moved mid-drag, and the drag is not an undo entry yet.
    expect(store.reader.doc.terrain.height[0]).toBe(3)
    expect(store.reader.canUndo()).toBe(false)
    expect(store.inStroke).toBe(true)

    // Undo mid-stroke is refused rather than closing the stroke early: the
    // old close-and-undo left the rest of the drag with no record at all.
    store.undo()
    expect(store.reader.doc.terrain.height[0]).toBe(3)

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
    stroke.apply(raise(store.reader.doc, [[0, 0]], 1))
    store.apply('Elsewhere', raise(store.reader.doc, [[7, 7]], 1))
    expect(store.reader.doc.terrain.height[cellIndex(store.reader.doc.size, 7, 7)]).toBe(3)

    stroke.end()
    // Two entries, innermost last: the mid-stroke edit unwinds on its own undo
    // and the drag unwinds on the next.
    expect(store.reader.undoLabel()).toBe('Raise')
    store.undo()
    expect(store.reader.doc.terrain.height[0]).toBe(2)
    expect(store.reader.undoLabel()).toBe('Elsewhere')
    store.undo()
    expect(store.reader.doc.terrain.height[cellIndex(store.reader.doc.size, 7, 7)]).toBe(2)
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
    stroke.apply(raise(store.reader.doc, [[0, 0]], 1))

    store.apply('Collides', raise(store.reader.doc, [[0, 0]], 5))
    // Refused whole: not applied, and not an entry.
    expect(store.reader.doc.terrain.height[0]).toBe(3)

    stroke.end()
    expect(store.reader.undoLabel()).toBe('Raise')
    store.undo()
    expect(store.reader.doc.terrain.height[0]).toBe(2)
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
    store.applyStrokeTick(raise(store.reader.doc, [[0, 0]], 1))
    expect(store.reader.doc.terrain.height[0]).toBe(2)
    expect(store.reader.canUndo()).toBe(false)
  })

  it('drops a record that arrives after the document was replaced', () => {
    const store = new EditorStore(createMap(8, 8, 'First'))
    const stroke = compactingStroke(store, 'Raise')
    stroke.apply(raise(store.reader.doc, [[0, 0]], 1))
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
    store.apply('Flatten', flatten(store.reader.doc, [[0, 0]], 2))
    expect(store.reader.canUndo()).toBe(false)
  })

  it('marks the neighbouring chunks dirty at a chunk border', () => {
    const store = new EditorStore(createMap(48, 48))
    store.takeDirtyChunks()
    store.apply('Raise', raise(store.reader.doc, [[16, 16]], 1))
    const dirty = store.takeDirtyChunks()
    expect(dirty).toContain('1,1')
    expect(dirty).toContain('0,0')
  })
})

describe('paint survives sculpt', () => {
  it('never emits a paint patch from a sculpt op', () => {
    const doc = createMap(8, 8)
    const ops = [
      raise(doc, [[1, 1]], 2),
      flatten(doc, [[1, 1]], 5),
      setRamp(doc, [[1, 1]], 0),
    ]
    for (const patches of ops) {
      expect(patches.some((patch) => patch.t === 'paint')).toBe(false)
    }
  })

  it('reports dormant paint as a diagnostic', () => {
    const doc = createMap(4, 4)
    doc.paint.top[topKey(1, 1)] = 3
    doc.paint.cliff[cliffKey(9, 9, 0, 0)] = 4
    const counts = countDormant(doc.paint, (kind) => kind === 'top')
    expect(counts.top).toBe(0)
    expect(counts.cliff).toBe(1)
  })
})

describe('autotile', () => {
  it('connects to matching neighbours at the same height', () => {
    const doc = createMap(5, 5)
    expect(autotileMask(doc, 2, 2)).toBe(MASK_NORTH | MASK_EAST | MASK_SOUTH | MASK_WEST)
  })

  it('breaks the connection across a height change', () => {
    const doc = createMap(5, 5)
    setHeight(doc, 3, 2, 6)
    const mask = autotileMask(doc, 2, 2)
    expect(mask & MASK_EAST).toBe(0)
    expect(mask & MASK_WEST).toBe(MASK_WEST)
  })

  it('treats the map border as connected so it does not ring the level in edge tiles', () => {
    const doc = createMap(5, 5)
    expect(autotileMask(doc, 0, 0)).toBe(15)
  })
})

describe('terrain queries', () => {
  it('interpolates a ramp instead of stepping it', () => {
    const doc = createMap(4, 4)
    setHeight(doc, 1, 1, 4)
    doc.terrain.ramp[cellIndex(doc.size, 1, 1)] = 0 // descends east

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

    store.apply('Raise', raise(store.reader.doc, [[2, 2]], 4))
    expect(store.reader.doc.objects[id].position[1]).toBeCloseTo(3, 6)

    store.undo()
    expect(store.reader.doc.objects[id].position[1]).toBeCloseTo(1, 6)
  })

  it('leaves unanchored objects where they are', () => {
    const doc = createMap(8, 8)
    const patches = raise(doc, [[2, 2]], 4)
    expect(patches.some((patch) => patch.t === 'object')).toBe(false)
  })
})

describe('brushes', () => {
  it('sizes a square brush correctly and clips at the map edge', () => {
    const doc = createMap(8, 8)
    expect(brushCells(doc, 4, 4, { size: 3, shape: 'square' })).toHaveLength(9)
    expect(brushCells(doc, 0, 0, { size: 3, shape: 'square' })).toHaveLength(4)
  })

  it('fills a region of matching cells', () => {
    const doc = createMap(8, 8)
    setHeight(doc, 4, 0, 9)
    for (let y = 0; y < 8; y++) setHeight(doc, 4, y, 9)
    const region = fillCells(doc, 0, 0)
    expect(region.length).toBe(32)
  })
})

describe('io', () => {
  it('round-trips a document', () => {
    const store = new EditorStore(createMap(6, 6, 'Test Map'))
    store.apply('Raise', raise(store.reader.doc, [[1, 1]], 3))
    store.apply('Paint', paintTop(store.reader.doc, [[1, 1]], 7))

    const restored = deserialize(serialize(store.reader.doc))
    expect(restored.name).toBe('Test Map')
    expect(restored.terrain.height).toEqual(store.reader.doc.terrain.height)
    expect(restored.paint.top).toEqual(store.reader.doc.paint.top)
    expect(restored.formatVersion).toBe(1)
  })

  it('migrates an unversioned document forward', () => {
    const doc = createMap(4, 4)
    const raw = parseOnDisk(doc)
    delete raw.formatVersion
    const restored = deserialize(JSON.stringify(raw))
    expect(restored.formatVersion).toBe(1)
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
    raw.terrain.height = [1, 2, 3]
    expect(() => deserialize(JSON.stringify(raw))).toThrow(LoadError)
  })

  it('preserves dormant paint across a save and load', () => {
    const doc = createMap(4, 4)
    doc.paint.cliff[cliffKey(1, 1, 0, 30)] = 5
    doc.terrain.ramp[0] = NO_RAMP
    const restored = deserialize(serialize(doc))
    expect(restored.paint.cliff[cliffKey(1, 1, 0, 30)]).toBe(5)
  })
})
