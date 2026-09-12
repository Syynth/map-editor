import { EditorStore, cellIndex, createDocumentActorLogic, createMap, paintTop, patchAddress, type Patch, type SurfaceAddress } from '@map-editor/document'
import { describe, expect, it } from 'vitest'
import { createActor, type InspectionEvent } from 'xstate'

import { strokeLogic, type DocumentRef } from './stroke'
import { createStrokeHandler, type StrokeDeps, type StrokeSample, type ToolsSnapshot } from './strokes'
import type { ToolSettings } from './tools'

/**
 * The stroke actor's two invariants (#11), each asserted through `reader` and
 * the events the document actor received: patches APPLY on every tick, and
 * ONE `Edit` lands on release with one patch per address touched. The second
 * is the regression test `docs/stack.md` asked for — committed patch count
 * equals unique addresses — against the measured 3,780-over-260 baseline.
 */

const SCULPT: ToolsSnapshot = {
  tool: 'terrain',
  terrainMode: 'sculpt',
  sculptVerb: 'raise',
  paintVerb: 'tile',
  strokeShape: 'brush',
  brush: { size: 3, shape: 'square' },
  material: 0,
  tile: 0,
  tint: 0xffffff,
  rampDir: -1,
  spriteName: 'tree',
}

function top(x: number, y: number): SurfaceAddress {
  return { kind: 0, x, y, dir: -1, level: 0 }
}

function sample(x: number, y: number, modifiers: Partial<StrokeSample['modifiers']> = {}): StrokeSample {
  return { pick: { surface: top(x, y), point: { x: x + 0.5, z: y + 0.5 }, objectId: null }, modifiers: { shift: false, alt: false, ctrl: false, ...modifiers } }
}

function rig(tools: ToolsSnapshot = SCULPT) {
  const store = new EditorStore(createMap(16, 16))
  const document = createActor(createDocumentActorLogic(store)).start()
  // What the document actor RECEIVED, off the system's inspector: `send` is a
  // getter on v6's `Actor`, so it cannot be spied on, and this is the honest
  // record anyway — an event the actor took a transition on.
  const received: Array<{ type: string } & Record<string, unknown>> = []
  document.system.inspect((event) => {
    if (event.type === '@xstate.transition' && event.actorRef.sessionId === document.sessionId) received.push(event.event)
  })
  const toolsSet: ToolSettings[] = []
  const deps: StrokeDeps = {
    reader: store.reader,
    tools: () => tools,
    setTools: (settings) => void toolsSet.push(settings),
    select: () => undefined,
  }
  const dead: InspectionEvent[] = []
  const start = (at: StrokeSample) => {
    const handler = createStrokeHandler(deps, at, null)
    if (!handler) throw new Error('the terrain tool always strokes')
    const stroke = createActor(strokeLogic(handler, store.reader, document as DocumentRef), {
      inspect: (event) => void (event.type === '@xstate.deadletter' && dead.push(event)),
    }).start()
    stroke.send({ type: 'begin', sample: at })
    return stroke
  }
  const patchEvents = () => received.filter((event): event is { type: 'strokePatch'; patches: Patch[] } => event.type === 'strokePatch')
  const record = () => {
    const end = received.find((event): event is { type: 'endStroke'; patches: Patch[]; inverse: Patch[] } => event.type === 'endStroke')
    if (!end) throw new Error('no endStroke was sent')
    return end
  }
  return { store, document, deps, start, patchEvents, record, toolsSet, dead }
}

describe('the stroke actor', () => {
  it('applies every tick immediately, then commits one Edit with one patch per address', () => {
    const { store, start, patchEvents, record } = rig()
    const doc = store.reader.doc
    const before = doc.terrain.height.slice()
    const at = (x: number, y: number) => doc.terrain.height[cellIndex(doc.size, x, y)]

    // A size-3 brush dragged right two cells and back again: every tick lands
    // on cells earlier ticks already raised, which is the redundancy measured
    // in docs/stack.md.
    const path: Array<[number, number]> = [[4, 4], [5, 4], [6, 4], [5, 4], [4, 4], [5, 4], [6, 4]]
    const stroke = start(sample(...path[0]))
    expect(at(4, 4), 'the press already deformed the terrain').toBe(before[cellIndex(doc.size, 4, 4)] + 1)
    for (const [x, y] of path.slice(1)) {
      const seen = at(x, y)
      stroke.send({ type: 'move', sample: sample(x, y) })
      expect(at(x, y), 'a mid-drag tick is visible before release').toBe(seen + 1)
    }
    // Not an undo entry yet: the stroke is still open.
    expect(store.reader.canUndo()).toBe(false)

    stroke.send({ type: 'end', sample: sample(6, 4) })

    const sentPatches = patchEvents().flatMap((event) => event.patches)
    const unique = new Set(sentPatches.map(patchAddress))
    expect(sentPatches.length, 'the drag really was redundant').toBeGreaterThan(unique.size * 2)
    const edit = record()
    expect(edit.patches).toHaveLength(unique.size)
    expect(edit.inverse).toHaveLength(unique.size)
    expect(stroke.getSnapshot().status).toBe('done')

    // One Edit, and undoing it restores every cell to before the press.
    expect(store.reader.canUndo()).toBe(true)
    expect(store.reader.undoLabel()).toBe('Raise')
    const after = doc.terrain.height.slice()
    store.undo()
    expect(doc.terrain.height).toEqual(before)
    expect(store.reader.canUndo()).toBe(false)
    // And the compacted forward values reproduce the final state exactly.
    store.redo()
    expect(doc.terrain.height).toEqual(after)
  })

  it('keeps the first inverse and the last value: raise, raise, lower undoes to the start in one step', () => {
    const { store, start, record } = rig({ ...SCULPT, brush: { size: 1, shape: 'square' } })
    const doc = store.reader.doc
    const index = cellIndex(doc.size, 3, 3)
    const before = doc.terrain.height[index]

    const stroke = start(sample(3, 3))
    stroke.send({ type: 'move', sample: sample(4, 3) })
    stroke.send({ type: 'move', sample: sample(3, 3) })
    stroke.send({ type: 'move', sample: sample(4, 3) })
    stroke.send({ type: 'move', sample: sample(3, 3, { shift: true }) })
    // +1, +1, -1 on (3,3): three writes, a net of one.
    expect(doc.terrain.height[index]).toBe(before + 1)
    stroke.send({ type: 'end', sample: sample(3, 3) })

    const edit = record()
    const mine = edit.patches.find((patch) => patch.t === 'terrain' && patch.index === index)
    const inverse = edit.inverse.find((patch) => patch.t === 'terrain' && patch.index === index)
    expect(mine?.value).toBe(before + 1)
    expect(inverse?.value).toBe(before)
    store.undo()
    expect(doc.terrain.height[index]).toBe(before)
  })

  it('drops an address put back where it started, and commits no Edit when nothing remains', () => {
    const { store, start, patchEvents, record } = rig({ ...SCULPT, brush: { size: 1, shape: 'square' } })
    const stroke = start(sample(2, 2))
    stroke.send({ type: 'move', sample: sample(3, 2) })
    stroke.send({ type: 'move', sample: sample(2, 2, { shift: true }) })
    stroke.send({ type: 'move', sample: sample(3, 2, { shift: true }) })
    stroke.send({ type: 'end', sample: sample(3, 2) })

    // Four ticks reached the document…
    expect(patchEvents()).toHaveLength(4)
    // …and the record is empty, so the stroke closed without an entry.
    expect(record().patches).toEqual([])
    expect(store.reader.canUndo()).toBe(false)
  })

  it('runs the eyedropper on an alt press: a tools.set, and nothing sent to the document but the brackets', () => {
    const tools: ToolsSnapshot = { ...SCULPT, terrainMode: 'paint', paintVerb: 'tile' }
    const { store, start, patchEvents, toolsSet, document } = rig(tools)
    store.apply('Paint', paintTop(store.reader.doc, [[5, 5]], 17))

    const stroke = start(sample(5, 5, { alt: true }))
    stroke.send({ type: 'end', sample: sample(5, 5, { alt: true }) })

    expect(toolsSet).toEqual([{ tile: 17 }])
    expect(patchEvents()).toEqual([])
    expect(document.getSnapshot().status).toBe('active')
  })

  it('records where it began, for the rectangle preview', () => {
    const { start } = rig()
    const stroke = start(sample(7, 9))
    expect(stroke.getSnapshot().context.origin).toEqual([7, 9])
  })

  it('stops itself on end, so a late move dead-letters rather than landing', () => {
    const { store, start, dead } = rig({ ...SCULPT, brush: { size: 1, shape: 'square' } })
    const doc = store.reader.doc
    const stroke = start(sample(1, 1))
    stroke.send({ type: 'end', sample: sample(1, 1) })
    const settled = doc.terrain.height.slice()

    stroke.send({ type: 'move', sample: sample(2, 1) })

    expect(doc.terrain.height).toEqual(settled)
    expect(dead).toHaveLength(1)
    expect(dead[0]).toMatchObject({ reason: 'stopped', event: { type: 'move' } })
  })

  it('leaves each tick a Patch the document takes as-is', () => {
    // The handler contract types patches as the document's own `Patch`; a
    // consumer never constructs one, so this only checks the wiring's shape.
    const { start, patchEvents } = rig({ ...SCULPT, brush: { size: 1, shape: 'square' } })
    const stroke = start(sample(0, 0))
    stroke.send({ type: 'end', sample: sample(0, 0) })
    const patch: Patch | undefined = patchEvents()[0]?.patches[0]
    expect(patch).toMatchObject({ t: 'terrain', field: 'height' })
  })
})
