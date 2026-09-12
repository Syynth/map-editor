import { describe, expect, it } from 'vitest'

import { autotileMask, MASK_EAST, MASK_NORTH, MASK_SOUTH, MASK_WEST } from './autotile'
import { applyPatches, History } from './edits'
import { cellIndex, createMap, NO_RAMP, type MapDoc } from './document'
import { deserialize, LoadError, serialize } from './io'
import { brushCells, fillCells, flatten, paintTop, raise, setRamp } from './ops'
import { cliffKey, countDormant, topKey } from './paint'
import { EditorStore } from './store'
import { groundHeight } from './terrain'

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

describe('store', () => {
  it('coalesces a stroke into one undo entry', () => {
    const store = new EditorStore(createMap(8, 8))
    store.beginStroke('Raise')
    for (let i = 0; i < 5; i++) {
      store.apply('Raise', raise(store.doc, [[i, 0]], 1))
    }
    store.endStroke()

    expect(store.doc.terrain.height[0]).toBe(3)
    store.undo()
    for (let i = 0; i < 5; i++) expect(store.doc.terrain.height[i]).toBe(2)
    expect(store.history.canUndo()).toBe(false)
  })

  it('drops no-op patches so idle brushing does not fill the undo stack', () => {
    const store = new EditorStore(createMap(8, 8))
    store.apply('Flatten', flatten(store.doc, [[0, 0]], 2))
    expect(store.history.canUndo()).toBe(false)
  })

  it('marks the neighbouring chunks dirty at a chunk border', () => {
    const store = new EditorStore(createMap(48, 48))
    store.takeDirtyChunks()
    store.apply('Raise', raise(store.doc, [[16, 16]], 1))
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

    store.apply('Raise', raise(store.doc, [[2, 2]], 4))
    expect(store.doc.objects[id].position[1]).toBeCloseTo(3, 6)

    store.undo()
    expect(store.doc.objects[id].position[1]).toBeCloseTo(1, 6)
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
    store.apply('Raise', raise(store.doc, [[1, 1]], 3))
    store.apply('Paint', paintTop(store.doc, [[1, 1]], 7))

    const restored = deserialize(serialize(store.doc))
    expect(restored.name).toBe('Test Map')
    expect(restored.terrain.height).toEqual(store.doc.terrain.height)
    expect(restored.paint.top).toEqual(store.doc.paint.top)
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
