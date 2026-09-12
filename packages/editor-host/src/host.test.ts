import {
  EditorStore,
  addObject,
  cellIndex,
  createMap,
  defaultFacing,
  paintTint,
  patchAddress,
  raise,
  removeObject,
  type MapObject,
  type Patch,
  type SurfaceAddress,
} from '@map-editor/document'
import { commands, dispose } from '@map-editor/registry'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SimulatedClock, setup as setupMachine, types, type AnyActorRef } from 'xstate'

import { createHost, type Feature, type Host } from './host'
import type { PointerPress } from './gesture'

/**
 * #10's shape: a behavior test dispatches at the root actor and asserts
 * through `reader` and the actor snapshots. No React, no DOM, no GL. Setup
 * may construct documents directly — `createMap` plus the ops verbs, applied
 * through the store — but every assertion about behavior goes through
 * `dispatch`.
 *
 * `dispatched` records every id this file sends, for the enumeration test at
 * the bottom: a command the registry knows and no test here has dispatched
 * fails that test, the same way "declared but unhandled" is a dead letter.
 */
const dispatched = new Set<string>()

function makeHost(features?: readonly Feature[]): { host: Host; store: EditorStore; clock: SimulatedClock; dispatch: Host['dispatch'] } {
  const store = new EditorStore(createMap(8, 8))
  const clock = new SimulatedClock()
  const host = createHost({ store, clock, features })
  const dispatch: Host['dispatch'] = (id, args) => {
    dispatched.add(id)
    return host.dispatch(id, args)
  }
  return { host, store, clock, dispatch }
}

/** One committed edit, so there is something to undo. */
function raiseOnce(store: EditorStore, x: number, y: number, by = 1): void {
  store.apply('Raise', raise(store.reader.doc, [[x, y]], by))
}

describe('the document commands, routed to the document actor', () => {
  it('undoes and redoes what the store recorded, seen through reader', () => {
    const { host, store, dispatch } = makeHost()
    const index = cellIndex(store.reader.doc.size, 2, 2)
    const before = store.reader.doc.terrain.height[index]
    raiseOnce(store, 2, 2, 3)
    expect(store.reader.doc.terrain.height[index]).toBe(before + 3)

    expect(dispatch('undo')).toEqual({ ok: true })
    expect(host.reader.doc.terrain.height[index]).toBe(before)

    expect(dispatch('redo')).toEqual({ ok: true })
    expect(host.reader.doc.terrain.height[index]).toBe(before + 3)
  })

  it('undoes exactly once per dispatch, not twice', () => {
    // Two edits in history, one undo: a doubled write would empty the stack.
    const { store, dispatch } = makeHost()
    raiseOnce(store, 1, 1)
    raiseOnce(store, 2, 2)

    dispatch('undo')

    expect(store.reader.canUndo()).toBe(true)
    expect(store.reader.canRedo()).toBe(true)
  })

  it('is unavailable with nothing to undo, and says which key failed', () => {
    const { dispatch } = makeHost()
    expect(dispatch('undo')).toMatchObject({ ok: false, kind: 'unavailable', reason: expect.stringContaining('document.canUndo') as string })
    expect(dispatch('redo')).toMatchObject({ ok: false, kind: 'unavailable', reason: expect.stringContaining('document.canRedo') as string })
  })

  it('refuses arguments the declaration does not take', () => {
    const { store, dispatch } = makeHost()
    raiseOnce(store, 1, 1)
    expect(dispatch('undo', { steps: 2 })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(store.reader.canUndo()).toBe(true)
  })
})

describe('mode: the host\'s own top-level state', () => {
  it('enters and leaves play, and the mode key follows the live snapshot', () => {
    const { host, dispatch } = makeHost()
    expect(host.actor.getSnapshot().value).toBe('edit')
    expect(host.contextKeys()['host.mode']).toBe('edit')

    expect(dispatch('mode.play')).toEqual({ ok: true })
    expect(host.actor.getSnapshot().value).toBe('play')
    // #8's finding 2: keys are derived per dispatch. A snapshot frozen at
    // construction would still say `edit` here and leave `mode.edit`
    // permanently unavailable.
    expect(host.contextKeys()['host.mode']).toBe('play')

    expect(dispatch('mode.edit')).toEqual({ ok: true })
    expect(host.actor.getSnapshot().value).toBe('edit')
  })

  it('refuses the mode it is already in, with the reason', () => {
    const { dispatch } = makeHost()
    expect(dispatch('mode.edit')).toMatchObject({ ok: false, kind: 'unavailable', reason: expect.stringContaining('host.mode') as string })
    dispatch('mode.play')
    expect(dispatch('mode.play')).toMatchObject({ ok: false, kind: 'unavailable' })
  })

  it('keeps routing to children while playing', () => {
    const { host, dispatch } = makeHost()
    dispatch('mode.play')
    expect(dispatch('view.set', { showGrid: false })).toEqual({ ok: true })
    expect(host.children.view.getSnapshot().context.showGrid).toBe(false)
  })
})

describe('tools: eleven parameters, one command', () => {
  it('patches any subset of the parameters at once', () => {
    const { host, dispatch } = makeHost()
    const before = host.children.tools.getSnapshot().context

    expect(dispatch('tools.set', { brush: { size: 5, shape: 'circle' }, tint: 0xff0000 })).toEqual({ ok: true })

    const after = host.children.tools.getSnapshot().context
    expect(after.brush).toEqual({ size: 5, shape: 'circle' })
    expect(after.tint).toBe(0xff0000)
    expect(after.sculptVerb).toBe(before.sculptVerb)
    expect(after.spriteName).toBe(before.spriteName)
  })

  it('holds terrainMode as a state and the rest as context', () => {
    const { host, dispatch } = makeHost()
    expect(host.children.tools.getSnapshot().value).toBe('sculpt')
    expect(host.contextKeys()['tools.terrainMode']).toBe('sculpt')

    expect(dispatch('tools.set', { terrainMode: 'paint', paintVerb: 'tint' })).toEqual({ ok: true })

    const snapshot = host.children.tools.getSnapshot()
    expect(snapshot.value).toBe('paint')
    expect(snapshot.context.paintVerb).toBe('tint')
    expect('terrainMode' in snapshot.context).toBe(false)
    expect(host.contextKeys()['tools.terrainMode']).toBe('paint')

    expect(dispatch('tools.set', { terrainMode: 'sculpt' })).toEqual({ ok: true })
    expect(host.children.tools.getSnapshot().value).toBe('sculpt')
  })

  it('exposes the active tool as a key', () => {
    const { host, dispatch } = makeHost()
    expect(host.contextKeys()['tools.tool']).toBe('terrain')
    dispatch('tools.set', { tool: 'object' })
    expect(host.contextKeys()['tools.tool']).toBe('object')
  })

  it('rejects an out-of-range value and an unknown parameter, naming the path', () => {
    const { host, dispatch } = makeHost()
    expect(dispatch('tools.set', { brush: { size: 99, shape: 'circle' } })).toMatchObject({
      ok: false,
      kind: 'invalid-args',
      issues: [{ path: ['brush', 'size'] }],
    })
    expect(dispatch('tools.set', { brushSize: 3 })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(dispatch('tools.set')).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(host.children.tools.getSnapshot().context.brush).toEqual({ size: 1, shape: 'square' })
  })

  it('rejects an explicitly undefined parameter instead of writing undefined into context', () => {
    // A key that is present with the value `undefined` is not a partial
    // patch: it is not JSON, and spread into the context it would turn
    // `brush` into `undefined` and the next `brush.size` into a throw. The
    // schema names the key, the same as any other bad argument (#23).
    const { host, dispatch } = makeHost()
    const before = host.children.tools.getSnapshot().context

    expect(dispatch('tools.set', { brush: undefined })).toMatchObject({ ok: false, kind: 'invalid-args', issues: [{ path: ['brush'] }] })
    expect(dispatch('tools.set', { tile: 2, terrainMode: undefined })).toMatchObject({ ok: false, kind: 'invalid-args', issues: [{ path: ['terrainMode'] }] })

    const after = host.children.tools.getSnapshot()
    expect(after.context).toEqual(before)
    expect(after.value).toBe('sculpt')
  })
})

describe('view and selection', () => {
  it('sets the toggles', () => {
    const { host, dispatch } = makeHost()
    expect(dispatch('view.set', { gameCamera: true, inspector: 'outliner' })).toEqual({ ok: true })
    const { context } = host.children.view.getSnapshot()
    expect(context.gameCamera).toBe(true)
    expect(context.inspector).toBe('outliner')
    expect(context.showGrid).toBe(true)
  })

  it('rejects an explicitly undefined toggle and keeps the previous value', () => {
    const { host, dispatch } = makeHost()
    expect(host.children.view.getSnapshot().context.showGrid).toBe(true)

    expect(dispatch('view.set', { showGrid: undefined })).toMatchObject({ ok: false, kind: 'invalid-args', issues: [{ path: ['showGrid'] }] })

    const { context } = host.children.view.getSnapshot()
    expect(context.showGrid).toBe(true)
    expect(Object.values(context)).not.toContain(undefined)
  })

  it('selection by stable id, cleared with null, mirrored by hasSelection', () => {
    const { host, dispatch } = makeHost()
    expect(host.contextKeys()['view.hasSelection']).toBe(false)

    expect(dispatch('selection.set', { id: 'obj-1' })).toEqual({ ok: true })
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBe('obj-1')
    expect(host.contextKeys()['view.hasSelection']).toBe(true)

    expect(dispatch('selection.set', { id: null })).toEqual({ ok: true })
    expect(host.contextKeys()['view.hasSelection']).toBe(false)
  })

  it('refuses a selection that is not an id', () => {
    const { dispatch } = makeHost()
    expect(dispatch('selection.set', { id: 42 })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(dispatch('selection.set', {})).toMatchObject({ ok: false, kind: 'invalid-args' })
  })
})

describe('the ways a dispatch does not happen', () => {
  it('unknown: nobody declared the id', () => {
    const { dispatch } = makeHost()
    expect(dispatch('terrain.melt')).toMatchObject({ ok: false, kind: 'unknown' })
  })

  it('unhandled: declared, but its owner\'s actor was never started', () => {
    commands.declare('test.ghost', { id: 'test.ghost.wave', title: 'Wave' })
    try {
      const { host, dispatch } = makeHost()
      expect(dispatch('test.ghost.wave')).toMatchObject({ ok: false, kind: 'unhandled', reason: expect.stringContaining('never started') as string })
      // No ref means no dead letter: `enq.sendTo(undefined)` is silent, so
      // the dispatcher answers this shape before sending.
      expect(host.deadLetters).toEqual([])
    } finally {
      dispose('test.ghost')
    }
  })
})

// --- pointer input -------------------------------------------------------------

const NO_MODIFIERS = { shift: false, alt: false, ctrl: false }

function topAt(x: number, y: number): SurfaceAddress {
  return { kind: 0, x, y, dir: -1, level: 0 }
}

/** A minimal object to drag; the tests that use it override position and anchor. */
const OBJECT: MapObject = {
  id: 'obj-1',
  name: 'tree',
  sprite: 'tree',
  position: [0, 0, 0],
  rotationY: 0,
  scale: 1,
  display: 'auto',
  facing: defaultFacing(),
  anchorCell: [0, 0],
  seed: 0,
  locked: false,
  hidden: false,
}

function pressAt(x: number, y: number, extra: Partial<PointerPress> = {}): PointerPress {
  return { x: x * 10, y: y * 10, button: 0, modifiers: NO_MODIFIERS, pick: { surface: topAt(x, y), point: { x, z: y }, objectId: null }, ...extra }
}

/**
 * The editor's gestures through `Host.input`, end to end: the arbitration
 * actor, the stroke actor it spawns, the handler the tools actor configures,
 * and the document actor the patches reach — asserted through `reader`.
 */
describe('pointer input through the host', () => {
  it('a left drag sculpts on every tick and lands as one undo entry, one patch per address', () => {
    const { host, store, dispatch } = makeHost()
    dispatch('tools.set', { brush: { size: 3, shape: 'square' } })
    const doc = store.reader.doc
    const before = doc.terrain.height.slice()
    const at = (x: number, y: number) => doc.terrain.height[cellIndex(doc.size, x, y)]
    // What the document actor received, off the system's inspector (v6's
    // `Actor.send` is a getter and cannot be spied on). Matched by the id the
    // host spawns it under: `ActorRefLike`, which is what an inspection event
    // carries, has no typed `sessionId` to compare a child ref against.
    const received: Array<{ type: string } & Record<string, unknown>> = []
    host.actor.system.inspect((event) => {
      if (event.type === '@xstate.transition' && 'id' in event.actorRef && event.actorRef.id === 'document') received.push(event.event)
    })

    expect(host.input.pointerDown(pressAt(3, 3))).toBe('stroke')
    expect(at(3, 3)).toBe(before[cellIndex(doc.size, 3, 3)] + 1)
    for (const [x, y] of [[4, 3], [5, 3], [4, 3], [3, 3]] as const) {
      expect(host.input.pointerMove({ x: x * 10, y: y * 10, modifiers: NO_MODIFIERS })).toBe('stroke')
      const seen = at(x, y)
      host.input.strokeMove({ surface: topAt(x, y), point: null, objectId: null }, NO_MODIFIERS)
      expect(at(x, y)).toBe(seen + 1)
    }
    expect(host.input.strokeOrigin()).toEqual([3, 3])
    host.input.pointerUp({ x: 30, y: 30 })
    expect(host.input.gesture()).toBe('none')
    expect(host.input.strokeOrigin()).toBeNull()

    const patches = received.flatMap((event) => (event.type === 'strokePatch' ? (event.patches as Patch[]) : []))
    const record = received.find((event) => event.type === 'endStroke')
    const unique = new Set(patches.map(patchAddress)).size
    expect(patches.length).toBeGreaterThan(unique)
    expect((record?.patches as Patch[] | undefined)?.length).toBe(unique)

    expect(store.reader.undoLabel()).toBe('Raise')
    expect(dispatch('undo')).toEqual({ ok: true })
    expect(doc.terrain.height).toEqual(before)
  })

  it('records an app write that lands mid-drag, so one undo brings it back', () => {
    // `App`'s Delete keybinding is a `window` keydown listener: pointer
    // capture does not stop it, so `store.apply` is reachable in the middle of
    // an open stroke. Once, that write was applied and recorded by nothing —
    // the store refused it and the stroke's compaction map holds only patches
    // the stroke itself produced.
    const { host, store, dispatch } = makeHost()
    const doc = store.reader.doc
    const height = (x: number, y: number) => doc.terrain.height[cellIndex(doc.size, x, y)]
    const before = doc.terrain.height.slice()

    expect(host.input.pointerDown(pressAt(3, 3))).toBe('stroke')
    store.apply('Elsewhere', raise(doc, [[7, 7]], 1))
    expect(height(7, 7)).toBe(before[cellIndex(doc.size, 7, 7)] + 1)
    host.input.pointerUp({ x: 30, y: 30 })

    expect(dispatch('undo')).toEqual({ ok: true })
    expect(height(3, 3)).toBe(before[cellIndex(doc.size, 3, 3)])
    expect(store.reader.undoLabel()).toBe('Elsewhere')
    expect(dispatch('undo')).toEqual({ ok: true })
    expect(doc.terrain.height).toEqual(before)
  })

  it('refuses a mid-drag delete of the object being dragged, so no orphan survives the undo', () => {
    // Same keydown listener as the test above, but now the write collides:
    // the object tool drags the SELECTED object, and Delete deletes the
    // selection. Recorded independently they unwind backwards — the stroke's
    // entry pops first and writes `doc.objects[A]` while `objectOrder`, which
    // only the delete's entry owns, stays without it. The store refuses the
    // colliding write and `App` skips the branch entirely (`store.inStroke`),
    // so the drag is all that happened and one undo takes it back whole.
    const { host, store, dispatch } = makeHost()
    dispatch('tools.set', { tool: 'object' })
    const object = { ...OBJECT, position: [1, 0, 1] as [number, number, number], anchorCell: [1, 1] as [number, number] }
    store.apply('Add object', addObject(store.reader.doc, object))
    const doc = store.reader.doc

    const onObject = { pick: { surface: topAt(1, 1), point: { x: 1, z: 1 }, objectId: object.id } }
    expect(host.input.pointerDown(pressAt(1, 1, onObject))).toBe('stroke')
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBe(object.id)
    host.input.pointerMove({ x: 50, y: 50, modifiers: NO_MODIFIERS })
    host.input.strokeMove({ surface: topAt(5, 5), point: { x: 5, z: 5 }, objectId: null }, NO_MODIFIERS)
    // Ground level comes from the terrain, so only x and z are the drag's.
    const groundPlane = (id: string) => [doc.objects[id]?.position[0], doc.objects[id]?.position[2]]
    expect(groundPlane(object.id)).toEqual([5, 5])

    expect(store.inStroke).toBe(true)
    store.apply('Delete object', removeObject(doc, object.id))
    expect(doc.objectOrder).toEqual([object.id])

    host.input.pointerUp({ x: 50, y: 50 })
    expect(store.reader.undoLabel()).toBe('Edit object')
    expect(dispatch('undo')).toEqual({ ok: true })
    // The invariant: an id in `objects` is an id in `objectOrder`, and the
    // object is back where the drag began, not where it ended.
    expect(Object.keys(doc.objects)).toEqual(doc.objectOrder)
    expect(groundPlane(object.id)).toEqual([1, 1])
  })

  it('refuses undo and redo while the stroke is open, and says which key failed', () => {
    const { host, store, dispatch } = makeHost()
    raiseOnce(store, 5, 5)
    expect(store.reader.canUndo()).toBe(true)

    host.input.pointerDown(pressAt(3, 3))
    expect(store.reader.canUndo()).toBe(false)
    expect(dispatch('undo')).toMatchObject({ ok: false, kind: 'unavailable' })
    host.input.pointerUp({ x: 30, y: 30 })
    expect(dispatch('undo')).toEqual({ ok: true })
  })

  it('a rect stroke commits nothing until release, then one block from the press cell to the last', () => {
    const { host, store, dispatch } = makeHost()
    dispatch('tools.set', { strokeShape: 'rect' })
    const doc = store.reader.doc
    const before = doc.terrain.height.slice()
    const height = (x: number, y: number) => doc.terrain.height[cellIndex(doc.size, x, y)]

    expect(host.input.pointerDown(pressAt(2, 2))).toBe('stroke')
    // Nothing on the press, and nothing mid-drag: a rectangle is only known
    // once both corners are.
    expect(doc.terrain.height).toEqual(before)
    for (const [x, y] of [[3, 3], [4, 4]] as const) {
      host.input.pointerMove({ x: x * 10, y: y * 10, modifiers: NO_MODIFIERS })
      host.input.strokeMove({ surface: topAt(x, y), point: null, objectId: null }, NO_MODIFIERS)
    }
    expect(doc.terrain.height).toEqual(before)
    // The preview grows from the press cell, which is what `strokeOrigin` is for.
    expect(host.input.strokeOrigin()).toEqual([2, 2])

    host.input.pointerUp({ x: 40, y: 40 })
    for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) expect(height(x, y)).toBe(before[cellIndex(doc.size, x, y)] + 1)
    expect(height(5, 5)).toBe(before[cellIndex(doc.size, 5, 5)])
    expect(height(1, 1)).toBe(before[cellIndex(doc.size, 1, 1)])

    // One entry for the block, not nine.
    expect(store.reader.undoLabel()).toBe('Raise')
    expect(dispatch('undo')).toEqual({ ok: true })
    expect(doc.terrain.height).toEqual(before)
    expect(store.reader.canUndo()).toBe(false)
  })

  it('a fill stroke floods the contiguous plateau under the press and stops at the step', () => {
    const { host, store, dispatch } = makeHost()
    // A wall of raised cells down x = 4 bounds the flood: `fillCells` walks
    // cells of equal height, so the press at (2,2) reaches only its own side.
    for (let y = 0; y < 8; y++) raiseOnce(store, 4, y)
    dispatch('tools.set', { strokeShape: 'fill' })
    const doc = store.reader.doc
    const before = doc.terrain.height.slice()
    const height = (x: number, y: number) => doc.terrain.height[cellIndex(doc.size, x, y)]

    host.input.pointerDown(pressAt(2, 2))
    host.input.pointerUp({ x: 20, y: 20 })

    for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) expect(height(x, y)).toBe(before[cellIndex(doc.size, x, y)] + 1)
    expect(height(5, 5)).toBe(before[cellIndex(doc.size, 5, 5)])
    expect(dispatch('undo')).toEqual({ ok: true })
    expect(doc.terrain.height).toEqual(before)
  })

  it('the flatten verb levels a drag to the height sampled at the press', () => {
    const { host, store, dispatch } = makeHost()
    raiseOnce(store, 0, 0, 3)
    dispatch('tools.set', { sculptVerb: 'flatten', brush: { size: 1, shape: 'square' } })
    const doc = store.reader.doc
    const anchor = doc.terrain.height[cellIndex(doc.size, 0, 0)]

    host.input.pointerDown(pressAt(0, 0))
    for (const [x, y] of [[1, 0], [2, 0]] as const) {
      host.input.pointerMove({ x: x * 10, y: y * 10, modifiers: NO_MODIFIERS })
      host.input.strokeMove({ surface: topAt(x, y), point: null, objectId: null }, NO_MODIFIERS)
      // Flattened to the press height, not to each cell's own.
      expect(doc.terrain.height[cellIndex(doc.size, x, y)]).toBe(anchor)
    }
    host.input.pointerUp({ x: 20, y: 0 })
    expect(store.reader.undoLabel()).toBe('Flatten')
    expect(dispatch('undo')).toEqual({ ok: true })
    expect(doc.terrain.height[cellIndex(doc.size, 1, 0)]).not.toBe(anchor)
  })

  it('the water verb pools at the pressed cell\'s height, and shift removes it', () => {
    const { host, store, dispatch } = makeHost()
    dispatch('tools.set', { sculptVerb: 'water' })
    const doc = store.reader.doc
    const level = doc.terrain.height[cellIndex(doc.size, 3, 3)]

    host.input.pointerDown(pressAt(3, 3))
    host.input.pointerUp({ x: 30, y: 30 })
    expect(doc.terrain.water[cellIndex(doc.size, 3, 3)]).toBe(level)
    expect(store.reader.undoLabel()).toBe('Carve water')

    const shift = { modifiers: { ...NO_MODIFIERS, shift: true } }
    host.input.pointerDown(pressAt(3, 3, shift))
    host.input.pointerUp({ x: 30, y: 30 })
    expect(doc.terrain.water[cellIndex(doc.size, 3, 3)]).toBeLessThan(0)
    expect(store.reader.undoLabel()).toBe('Remove water')

    expect(dispatch('undo')).toEqual({ ok: true })
    expect(doc.terrain.water[cellIndex(doc.size, 3, 3)]).toBe(level)
  })

  it('alt-click runs the eyedropper at the press cell, and a 6 px alt-drag orbits without it', () => {
    const { host, store, dispatch } = makeHost()
    dispatch('tools.set', { terrainMode: 'paint', paintVerb: 'tint' })
    store.apply('Tint', paintTint(store.reader.doc, [[2, 2]], 0xff0000))
    store.apply('Tint', paintTint(store.reader.doc, [[6, 6]], 0x00ff00))
    const alt = { modifiers: { ...NO_MODIFIERS, alt: true } }

    expect(host.input.pointerDown(pressAt(2, 2, alt))).toBe('pending')
    expect(host.input.pointerMove({ x: 21, y: 22, modifiers: alt.modifiers })).toBe('pending')
    host.input.pointerUp({ x: 21, y: 22 })
    expect(host.children.tools.getSnapshot().context.tint).toBe(0xff0000)
    // The eyedropper wrote a tool parameter, never the document.
    expect(store.reader.undoLabel()).toBe('Tint')

    expect(host.input.pointerDown(pressAt(6, 6, alt))).toBe('pending')
    expect(host.input.pointerMove({ x: 66, y: 60, modifiers: alt.modifiers })).toBe('orbit')
    host.input.pointerUp({ x: 66, y: 60 })
    expect(host.children.tools.getSnapshot().context.tint).toBe(0xff0000)
  })

  it('in play mode a left press starts no stroke, while middle and right still orbit and pan', () => {
    const { host, store, dispatch } = makeHost()
    dispatch('mode.play')
    const before = store.reader.doc.terrain.height.slice()

    expect(host.input.pointerDown(pressAt(1, 1))).toBe('none')
    host.input.pointerUp({ x: 10, y: 10 })
    expect(store.reader.doc.terrain.height).toEqual(before)
    expect(store.reader.canUndo()).toBe(false)

    expect(host.input.pointerDown(pressAt(1, 1, { button: 1, pick: null }))).toBe('orbit')
    host.input.pointerUp({ x: 10, y: 10 })
    expect(host.input.pointerDown(pressAt(1, 1, { button: 2, pick: null }))).toBe('pan')
    host.input.pointerUp({ x: 10, y: 10 })

    // Back in edit mode the same press strokes again: `editing` is read per press.
    dispatch('mode.edit')
    expect(host.input.pointerDown(pressAt(1, 1))).toBe('stroke')
    host.input.pointerUp({ x: 10, y: 10 })
    expect(store.reader.canUndo()).toBe(true)
  })

  it('the object tool places on a press, drags what it placed, and selects it through the view actor', () => {
    const { host, store, dispatch } = makeHost()
    dispatch('tools.set', { tool: 'object', spriteName: 'tree' })
    const doc = store.reader.doc
    expect(doc.objectOrder).toHaveLength(0)

    host.input.pointerDown(pressAt(2, 2, { pick: { surface: topAt(2, 2), point: { x: 2.5, z: 2.5 }, objectId: null } }))
    expect(doc.objectOrder).toHaveLength(1)
    const id = doc.objectOrder[0]
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBe(id)
    expect(host.contextKeys()['view.hasSelection']).toBe(true)

    host.input.strokeMove({ surface: topAt(4, 4), point: { x: 4.5, z: 4.5 }, objectId: null }, NO_MODIFIERS)
    expect(doc.objects[id].position[0]).toBeCloseTo(4.5)
    host.input.pointerUp({ x: 40, y: 40 })
    expect(store.reader.undoLabel()).toBe('Edit object')
  })

  it('camera tool: a left press is no gesture at all', () => {
    const { host, dispatch } = makeHost()
    dispatch('tools.set', { tool: 'camera' })
    expect(host.input.pointerDown(pressAt(1, 1))).toBe('none')
  })

  it('held keys round-trip for the play loop', () => {
    const { host } = makeHost()
    host.input.keyDown('w')
    expect(host.input.heldKeys().has('w')).toBe(true)
    host.input.keyUp('w')
    expect(host.input.heldKeys().has('w')).toBe(false)
  })
})

/**
 * A feature whose actor has a lifetime shorter than the host's — the shape
 * #11 gives strokes, play sessions and async jobs. `finish` runs it to a
 * final state; its declarations stand, so the next command routes to a ref
 * that has stopped.
 */
const jobLogic = setupMachine({
  schemas: {
    context: types<{ pokes: number; disposed: boolean }>(),
    events: { command: types<{ id: string; args: unknown }>(), dispose: types<void>() },
  },
}).createMachine({
  id: 'job',
  context: { pokes: 0, disposed: false },
  initial: 'running',
  states: {
    running: {
      on: {
        command: ({ context, event }) => (event.id === 'test.job.finish' ? { target: 'finished' } : { context: { pokes: context.pokes + 1 } }),
        dispose: () => ({ context: { disposed: true } }),
      },
    },
    finished: { type: 'final' },
  },
})

describe('a child with a lifetime: dead letters are observable', () => {
  beforeAll(() => {
    commands.declare('test.job', { id: 'test.job.poke', title: 'Poke' })
    commands.declare('test.job', { id: 'test.job.finish', title: 'Finish' })
  })
  afterAll(() => dispose('test.job'))

  it('routes to the feature while it runs, dead-letters once it has stopped, and the host survives', () => {
    const { host, dispatch } = makeHost([{ owner: 'test.job', logic: jobLogic }])
    const job = host.child('test.job')
    expect(job).toBeDefined()

    expect(dispatch('test.job.poke')).toEqual({ ok: true })
    expect((job?.getSnapshot() as { context: { pokes: number } }).context.pokes).toBe(1)

    expect(dispatch('test.job.finish')).toEqual({ ok: true })
    expect(job?.getSnapshot().status).toBe('done')

    // THE ONE THAT KILLS A v5 ROUTER (#15). The ref is retained in context,
    // so the send reaches a stopped actor and dead-letters instead of
    // disappearing into `sendTo(undefined)`.
    expect(dispatch('test.job.poke')).toMatchObject({ ok: false, kind: 'unhandled', reason: expect.stringContaining('stopped') as string })
    expect(host.deadLetters).toHaveLength(1)
    expect(host.deadLetters[0]).toMatchObject({ reason: 'stopped', target: 'test.job', event: { type: 'command', id: 'test.job.poke' } })
    expect(host.child('test.job')).toBe(job)
    expect(host.actor.getSnapshot().status).toBe('active')

    // And the router still works afterwards — the real proof.
    expect(dispatch('tools.set', { tool: 'camera' })).toEqual({ ok: true })
    expect(host.children.tools.getSnapshot().context.tool).toBe('camera')
  })

  it('dispose(owner): revokes the declarations, sends dispose, stops the ref, keeps the ref', () => {
    commands.declare('test.job2', { id: 'test.job2.poke', title: 'Poke' })
    const { host, dispatch } = makeHost([{ owner: 'test.job2', logic: jobLogic }])
    const job = host.child('test.job2')
    expect(dispatch('test.job2.poke')).toEqual({ ok: true })

    host.dispose('test.job2')

    expect(commands.get('test.job2.poke')).toBeUndefined()
    expect(dispatch('test.job2.poke')).toMatchObject({ ok: false, kind: 'unknown' })
    const last = job?.getSnapshot() as { status: string; context: { disposed: boolean } } | undefined
    expect(last?.status).toBe('stopped')
    expect(last?.context.disposed).toBe(true)
    expect(host.child('test.job2')).toBe(job)
    expect(host.actor.getSnapshot().status).toBe('active')
  })

  it('refuses to dispose a reserved owner, and leaves it running', () => {
    const { host, dispatch } = makeHost()
    expect(() => host.dispose('editor-host.tools')).toThrow(/reserved/)
    expect(dispatch('tools.set', { tile: 3 })).toEqual({ ok: true })
  })
})

/**
 * A feature that dead-letters for reasons of its own: it holds a ref to a
 * child that finished the moment it started, and pokes it on every command.
 * The poke is undelivered, the command was delivered.
 */
const ghostLogic = setupMachine({ schemas: { events: { boo: types<void>() } } }).createMachine({
  id: 'ghost',
  initial: 'gone',
  states: { gone: { type: 'final' } },
})

const noisyLogic = setupMachine({
  schemas: { context: types<{ ghost: AnyActorRef; pokes: number }>(), events: { command: types<{ id: string; args: unknown }>() } },
}).createMachine({
  id: 'noisy',
  context: ({ spawn }) => ({ ghost: spawn(ghostLogic), pokes: 0 }),
  initial: 'running',
  states: {
    running: {
      on: {
        command: ({ context }, enq) => {
          enq.sendTo(context.ghost, { type: 'boo' })
          return { context: { pokes: context.pokes + 1 } }
        },
      },
    },
  },
})

describe('dead-letter attribution', () => {
  beforeAll(() => commands.declare('test.noisy', { id: 'test.noisy.poke', title: 'Poke a ghost' }))
  afterAll(() => dispose('test.noisy'))

  it('reports a delivered command ok even when its handler dead-lettered something else', () => {
    const { host, dispatch } = makeHost([{ owner: 'test.noisy', logic: noisyLogic }])

    expect(dispatch('test.noisy.poke')).toEqual({ ok: true })

    // The noise is still observable — it is a real dead letter — but it is
    // not this command's.
    expect(host.deadLetters).toHaveLength(1)
    expect(host.deadLetters[0]).toMatchObject({ reason: 'stopped', event: { type: 'boo' } })
    expect((host.child('test.noisy')?.getSnapshot() as { context: { pokes: number } }).context.pokes).toBe(1)
  })
})

describe('the host as a whole', () => {
  it('runs on the injected clock', () => {
    const { host, clock } = makeHost()
    expect(host.actor.clock).toBe(clock)
  })

  it('dead-letters every dispatch once stopped, and says so', () => {
    const { host, dispatch } = makeHost()
    host.stop()
    expect(dispatch('tools.set', { tile: 1 })).toMatchObject({ ok: false, kind: 'unhandled' })
    expect(host.deadLetters.at(-1)).toMatchObject({ reason: 'stopped', target: 'host' })
  })

  it('holds the document actor as a child the document commands route to', () => {
    const { host } = makeHost()
    expect(host.child('document')).toBe(host.children.document)
    expect(host.children.document.getSnapshot().status).toBe('active')
  })

  it('holds the gesture actor as a child, keyed under its reserved owner', () => {
    const { host } = makeHost()
    expect(host.child('editor-host.gesture')).toBe(host.children.gesture)
    expect(host.input.gesture()).toBe('none')
    expect(() => host.dispose('editor-host.gesture')).toThrow(/reserved/)
  })
})

/**
 * #10: every declared command must have a test that dispatches it. This runs
 * last in the file (vitest runs a file's tests in order), so `dispatched` is
 * complete by now. A new declaration anywhere in the workspace that no test
 * here exercises turns this red — add the test, not an exemption.
 */
describe('declared but untested', () => {
  it('has dispatched every command the registry knows', () => {
    const untested = commands
      .all()
      .map((command) => command.id)
      .filter((id) => !dispatched.has(id))
    expect(untested, `declared but never dispatched by a test: ${untested.join(', ')}`).toEqual([])
  })
})
