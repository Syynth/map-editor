import {
  addObject,
  cellIndex,
  createDocument,
  createMap,
  groundHeight,
  defaultFacing,
  raise,
  removeObject,
  serialize,
  type MapObject,
  type Patch,
  type SurfaceAddress,
} from '@map-editor/document'
import { commands, defineFeature, dispose, provideFeature, type HotHandle } from '@map-editor/registry'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SimulatedClock, setup as setupMachine, types, type AnyActorRef } from 'xstate'

import { createHost, type Feature, type Host } from './host'
import type { PointerPress } from './gesture'

/**
 * #10's shape: a behavior test dispatches at the root actor and asserts
 * through `reader` and the actor snapshots. No React, no DOM, no GL. Setup
 * may construct documents directly — `createMap` plus the ops verbs, sent at
 * the document actor with `apply` below — but every assertion about behavior
 * goes through `dispatch`.
 *
 * `dispatched` records every id this file sends, for the enumeration test at
 * the bottom: a command the registry knows and no test here has dispatched
 * fails that test, the same way "declared but unhandled" is a dead letter.
 */
const dispatched = new Set<string>()

function makeHost(features?: readonly Feature[]): { host: Host; clock: SimulatedClock; dispatch: Host['dispatch'] } {
  const clock = new SimulatedClock()
  const host = createHost({ document: createDocument(createMap(8, 8)), clock, features })
  const dispatch: Host['dispatch'] = (id, args) => {
    dispatched.add(id)
    return host.dispatch(id, args)
  }
  return { host, clock, dispatch }
}

/**
 * Setup: one labelled edit, at the document actor's own event rather than
 * through a command. A test holds the ref the same way the stroke actor does
 * — there is no writer to reach for, which is the point (#13).
 */
function apply(host: Host, label: string, patches: Patch[]): void {
  host.children.document.send({ type: 'patch', label, patches })
}

/** One committed edit, so there is something to undo. */
function raiseOnce(host: Host, x: number, y: number, by = 1): void {
  apply(host, 'Raise', raise(host.reader.doc, [[x, y]], by))
}

describe('the document commands, routed to the document actor', () => {
  it('undoes and redoes what the write path recorded, seen through reader', () => {
    const { host, dispatch } = makeHost()
    const index = cellIndex(host.reader.doc.size, 2, 2)
    const before = host.reader.doc.terrain.height[index]
    raiseOnce(host, 2, 2, 3)
    expect(host.reader.doc.terrain.height[index]).toBe(before + 3)

    expect(dispatch('undo')).toEqual({ ok: true })
    expect(host.reader.doc.terrain.height[index]).toBe(before)

    expect(dispatch('redo')).toEqual({ ok: true })
    expect(host.reader.doc.terrain.height[index]).toBe(before + 3)
  })

  it('undoes exactly once per dispatch, not twice', () => {
    // Two edits in history, one undo: a doubled write would empty the stack.
    const { host, dispatch } = makeHost()
    raiseOnce(host, 1, 1)
    raiseOnce(host, 2, 2)

    dispatch('undo')

    expect(host.reader.canUndo()).toBe(true)
    expect(host.reader.canRedo()).toBe(true)
  })

  it('is unavailable with nothing to undo, and says which key failed', () => {
    const { dispatch } = makeHost()
    expect(dispatch('undo')).toMatchObject({ ok: false, kind: 'unavailable', reason: expect.stringContaining('document.canUndo') as string })
    expect(dispatch('redo')).toMatchObject({ ok: false, kind: 'unavailable', reason: expect.stringContaining('document.canRedo') as string })
  })

  it('refuses arguments the declaration does not take', () => {
    const { host, dispatch } = makeHost()
    raiseOnce(host, 1, 1)
    expect(dispatch('undo', { steps: 2 })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(host.reader.canUndo()).toBe(true)
  })

  /**
   * The writes `App.tsx` made through `store.apply` until #66 step 7. Each is
   * one labelled entry, addressed by stable id or by the document field it
   * owns — there is no store to call any more, so these are the whole of what
   * the inspector, the camera panel and the atmosphere panel can do.
   */
  it('edits an object by id, as one undoable entry', () => {
    const { host, dispatch } = makeHost()
    apply(host, 'Add object', addObject(host.reader.doc, OBJECT))
    expect(dispatch('objects.update', { id: OBJECT.id, changes: { name: 'Renamed', display: 'billboardY' } })).toEqual({ ok: true })

    expect(host.reader.doc.objects[OBJECT.id].name).toBe('Renamed')
    expect(host.reader.doc.objects[OBJECT.id].display).toBe('billboardY')
    // Untouched fields survive: the handler merges onto the object it read.
    expect(host.reader.doc.objects[OBJECT.id].sprite).toBe(OBJECT.sprite)
    expect(host.reader.undoLabel()).toBe('Edit object')

    dispatch('undo')
    expect(host.reader.doc.objects[OBJECT.id].name).toBe(OBJECT.name)
  })

  it('records nothing for an object id the document does not hold', () => {
    const { host, dispatch } = makeHost()
    expect(dispatch('objects.update', { id: 'nobody', changes: { name: 'x' } })).toEqual({ ok: true })
    expect(host.reader.canUndo()).toBe(false)
  })

  it('refuses an object change the schema does not name, rather than writing it', () => {
    const { host, dispatch } = makeHost()
    apply(host, 'Add object', addObject(host.reader.doc, OBJECT))
    // `id` is identity, not an edit; `seed` is what makes an export
    // reproducible. Both are absent from the schema, so `.strict()` refuses.
    expect(dispatch('objects.update', { id: OBJECT.id, changes: { seed: 9 } })).toMatchObject({ ok: false, kind: 'invalid-args' })
    // Nothing was written: the top of the stack is still the setup's entry.
    expect(host.reader.undoLabel()).toBe('Add object')
  })

  it('merges the camera rig and the atmosphere, one entry each', () => {
    const { host, dispatch } = makeHost()
    const fov = host.reader.doc.camera.fov
    expect(dispatch('camera.set', { yawSnapDeg: 90 })).toEqual({ ok: true })
    expect(host.reader.doc.camera.yawSnapDeg).toBe(90)
    expect(host.reader.doc.camera.fov).toBe(fov)
    expect(host.reader.undoLabel()).toBe('Camera rig')

    expect(dispatch('atmosphere.set', { bloom: 1.25 })).toEqual({ ok: true })
    expect(host.reader.doc.atmosphere.bloom).toBe(1.25)
    expect(host.reader.doc.atmosphere.preset).toBe('Clear noon')
    expect(host.reader.undoLabel()).toBe('Atmosphere')

    dispatch('undo')
    expect(host.reader.doc.atmosphere.bloom).not.toBe(1.25)
    expect(host.reader.doc.camera.yawSnapDeg).toBe(90)
  })

  it('opens a map from its text, clearing the history the replaced document owned', () => {
    const { host, dispatch } = makeHost()
    raiseOnce(host, 1, 1)
    expect(host.reader.canUndo()).toBe(true)

    const other = createMap(6, 6, 'Other')
    expect(dispatch('document.load', { json: serialize(other) })).toEqual({ ok: true })
    expect(host.reader.doc.name).toBe('Other')
    expect(host.reader.doc.size).toEqual({ width: 6, height: 6 })
    // Nothing on the stack addresses a document that is gone.
    expect(host.reader.canUndo()).toBe(false)
  })

  it('refuses a malformed map as invalid-args carrying the load error, and leaves the document alone', () => {
    // The parse lives in the schema so a refusal is a RESULT (#8) rather than
    // a throw inside the enqueued write. A transition that never ran is what
    // keeps the open document open.
    const { host, dispatch } = makeHost()
    const name = host.reader.doc.name
    expect(dispatch('document.load', { json: '{ "formatVersion": 1 }' })).toMatchObject({
      ok: false,
      kind: 'invalid-args',
      issues: [{ path: ['json'], message: expect.stringContaining('no size') as string }],
    })
    expect(host.reader.doc.name).toBe(name)
  })

  it('starts a blank map at the size asked for', () => {
    const { host, dispatch } = makeHost()
    raiseOnce(host, 1, 1)
    expect(dispatch('document.new', { width: 4, height: 4, name: 'Fresh' })).toEqual({ ok: true })
    expect(host.reader.doc.size).toEqual({ width: 4, height: 4 })
    expect(host.reader.doc.name).toBe('Fresh')
    expect(host.reader.canUndo()).toBe(false)
    expect(dispatch('document.new', { width: 0, height: 4 })).toMatchObject({ ok: false, kind: 'invalid-args' })
  })

  it('moves the reader generation on a replace and on nothing else, so a renderer re-points itself', () => {
    // The renderer caches the document BY REFERENCE (`RuntimeScene`), and no
    // patch and no dirty chunk says "that object is not the document any
    // more". `generation` is that announcement, and it is on the read path
    // the viewport already drains every frame — which is what makes these two
    // commands dispatchable from anywhere rather than only from the one App
    // callback that used to call `viewport.reset()` by hand beside them.
    const { host, dispatch } = makeHost()
    const start = host.reader.generation

    raiseOnce(host, 1, 1)
    dispatch('camera.set', { yaw: 10 })
    expect(host.reader.revision).toBeGreaterThan(0)
    expect(host.reader.generation).toBe(start)

    expect(dispatch('document.new', { width: 4, height: 4, name: 'Fresh' })).toEqual({ ok: true })
    expect(host.reader.generation).toBe(start + 1)

    expect(dispatch('document.load', { json: serialize(createMap(6, 6, 'Other')) })).toEqual({ ok: true })
    expect(host.reader.generation).toBe(start + 2)

    // A refused load replaced nothing, so it announces nothing.
    expect(dispatch('document.load', { json: '{ "formatVersion": 1 }' })).toMatchObject({ ok: false })
    expect(host.reader.generation).toBe(start + 2)
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

  it('spawns a play session that knows where the character stands up, and stops it on the way out', () => {
    // #11: the session is an actor with the session's lifetime, not a flag.
    // What it holds is read from the document once, at spawn — the middle of
    // the map, on the ground under that point — which is what the viewport's
    // `togglePlay` used to compute for itself.
    const { host, dispatch } = makeHost()
    expect(host.playSession()).toBeNull()

    apply(host, 'Raise', raise(host.reader.doc, [[4, 4]], 6))
    dispatch('mode.play')
    const session = host.playSession()
    expect(session?.start).toEqual([4, groundHeight(host.reader.doc, 4, 4), 4])
    expect(host.actor.getSnapshot().context.play?.getSnapshot().status).toBe('active')

    // Stopped through `enq`, and the ref is retained: what says the session is
    // over is the mode, so `playSession` answers null while the stopped child
    // is still addressable.
    const ref = host.actor.getSnapshot().context.play
    dispatch('mode.edit')
    expect(host.playSession()).toBeNull()
    expect(ref?.getSnapshot().status).toBe('stopped')
    expect(host.actor.getSnapshot().context.play).toBe(ref)
  })

  it('reads the ground again for the NEXT session, not for the one already walking', () => {
    const { host, dispatch } = makeHost()
    dispatch('mode.play')
    const first = host.playSession()?.start
    apply(host, 'Raise', raise(host.reader.doc, [[4, 4]], 4))
    expect(host.playSession()?.start).toEqual(first)

    dispatch('mode.edit')
    dispatch('mode.play')
    expect(host.playSession()?.start).toEqual([4, groundHeight(host.reader.doc, 4, 4), 4])
    expect(host.playSession()?.start).not.toEqual(first)
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
    expect(host.contextKeys()['tools.tool']).toBe('select')
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
 * The editor's gestures through `Host.input`: the arbitration actor, the
 * stroke actor it spawns, and the document actor the patches reach — asserted
 * through `reader`.
 *
 * Every press below is the OBJECT tool's, which is the only tool whose handler
 * this package still owns. The terrain tool's is `feature-terrain`'s, reached
 * through the contract its owner contributed, and a host built here installs
 * no features — so a terrain press finds no contract and starts nothing. The
 * same gestures over the real terrain contract are in `apps/editor`, which is
 * the only place the two halves may be seen at once (#35).
 */
describe('pointer input through the host', () => {
  it('refuses a mid-drag delete of the object being dragged, so no orphan survives the undo', () => {
    // Same keyboard path as the test above, but now the write collides: the
    // object tool drags the SELECTED object, and Delete deletes the
    // selection. Recorded independently they unwind backwards — the stroke's
    // entry pops first and writes `doc.objects[A]` while `objectOrder`, which
    // only the delete's entry owns, stays without it. The store refuses the
    // colliding write, and `selection.delete` is unavailable mid-drag — the
    // open-stroke check `App.tsx` used to make against the store, now a
    // predicate that says why — so the drag is all that happened and one undo
    // takes it back whole.
    const { host, dispatch } = makeHost()
    dispatch('tools.set', { tool: 'object' })
    const object = { ...OBJECT, position: [1, 0, 1] as [number, number, number], anchorCell: [1, 1] as [number, number] }
    apply(host, 'Add object', addObject(host.reader.doc, object))
    const doc = host.reader.doc

    const onObject = { pick: { surface: topAt(1, 1), point: { x: 1, z: 1 }, objectId: object.id } }
    expect(host.input.pointerDown(pressAt(1, 1, onObject))).toBe('stroke')
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBe(object.id)
    host.input.pointerMove({ x: 50, y: 50, modifiers: NO_MODIFIERS })
    host.input.strokeMove({ surface: topAt(5, 5), point: { x: 5, z: 5 }, objectId: null }, NO_MODIFIERS)
    // Ground level comes from the terrain, so only x and z are the drag's.
    const groundPlane = (id: string) => [doc.objects[id]?.position[0], doc.objects[id]?.position[2]]
    expect(groundPlane(object.id)).toEqual([5, 5])

    expect(host.contextKeys()['host.stroking']).toBe(true)
    expect(dispatch('selection.delete')).toMatchObject({
      ok: false,
      kind: 'unavailable',
      reason: expect.stringContaining('host.stroking') as string,
    })
    // And the store would have refused it even if the predicate had not.
    apply(host, 'Delete object', removeObject(doc, object.id))
    expect(doc.objectOrder).toEqual([object.id])

    host.input.pointerUp({ x: 50, y: 50 })
    expect(host.reader.undoLabel()).toBe('Edit object')
    expect(dispatch('undo')).toEqual({ ok: true })
    // The invariant: an id in `objects` is an id in `objectOrder`, and the
    // object is back where the drag began, not where it ended.
    expect(Object.keys(doc.objects)).toEqual(doc.objectOrder)
    expect(groundPlane(object.id)).toEqual([1, 1])
  })

  it('refuses undo and redo while the stroke is open, and says which key failed', () => {
    const { host, dispatch } = makeHost()
    dispatch('tools.set', { tool: 'object' })
    raiseOnce(host, 5, 5)
    expect(host.reader.canUndo()).toBe(true)

    host.input.pointerDown(pressAt(3, 3))
    expect(host.reader.canUndo()).toBe(false)
    expect(dispatch('undo')).toMatchObject({ ok: false, kind: 'unavailable' })
    host.input.pointerUp({ x: 30, y: 30 })
    expect(dispatch('undo')).toEqual({ ok: true })
  })

  it('a press with a tool whose feature was never installed starts nothing', () => {
    // `terrain`'s handler belongs to a feature this host was not given.
    // `toolContract` answers `undefined`, so the gesture actor spawns no
    // stroke — the same fall-through a declined press gets, rather than a
    // half-live stroke over a tool nothing implements.
    const { host, dispatch } = makeHost()
    dispatch('tools.set', { tool: 'terrain' })
    expect(host.contextKeys()['tools.tool']).toBe('terrain')
    expect(host.toolContract('terrain')).toBeUndefined()

    expect(host.input.pointerDown(pressAt(3, 3))).toBe('none')
    host.input.pointerUp({ x: 30, y: 30 })
    expect(host.reader.canUndo()).toBe(false)
  })

  it('in play mode a left press starts no stroke, while middle and right still orbit and pan', () => {
    const { host, dispatch } = makeHost()
    dispatch('tools.set', { tool: 'object', spriteName: 'tree' })
    dispatch('mode.play')

    expect(host.input.pointerDown(pressAt(1, 1))).toBe('none')
    host.input.pointerUp({ x: 10, y: 10 })
    expect(host.reader.doc.objectOrder).toEqual([])
    expect(host.reader.canUndo()).toBe(false)

    expect(host.input.pointerDown(pressAt(1, 1, { button: 1, pick: null }))).toBe('orbit')
    host.input.pointerUp({ x: 10, y: 10 })
    expect(host.input.pointerDown(pressAt(1, 1, { button: 2, pick: null }))).toBe('pan')
    host.input.pointerUp({ x: 10, y: 10 })

    // Back in edit mode the same press strokes again: `editing` is read per press.
    dispatch('mode.edit')
    expect(host.input.pointerDown(pressAt(1, 1))).toBe('stroke')
    host.input.pointerUp({ x: 10, y: 10 })
    expect(host.reader.doc.objectOrder).toHaveLength(1)
    expect(host.reader.canUndo()).toBe(true)
  })

  it('the object tool places on a press, drags what it placed, and selects it through the view actor', () => {
    const { host, dispatch } = makeHost()
    dispatch('tools.set', { tool: 'object', spriteName: 'tree' })
    const doc = host.reader.doc
    expect(doc.objectOrder).toHaveLength(0)

    host.input.pointerDown(pressAt(2, 2, { pick: { surface: topAt(2, 2), point: { x: 2.5, z: 2.5 }, objectId: null } }))
    expect(doc.objectOrder).toHaveLength(1)
    const id = doc.objectOrder[0]
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBe(id)
    expect(host.contextKeys()['view.hasSelection']).toBe(true)

    host.input.strokeMove({ surface: topAt(4, 4), point: { x: 4.5, z: 4.5 }, objectId: null }, NO_MODIFIERS)
    expect(doc.objects[id].position[0]).toBeCloseTo(4.5)
    host.input.pointerUp({ x: 40, y: 40 })
    expect(host.reader.undoLabel()).toBe('Edit object')
  })

  it('the select tool selects what it presses, clears on empty ground unless shift is held, and never places', () => {
    const { host, dispatch } = makeHost()
    dispatch('tools.set', { tool: 'object', spriteName: 'tree' })
    host.input.pointerDown(pressAt(2, 2, { pick: { surface: topAt(2, 2), point: { x: 2.5, z: 2.5 }, objectId: null } }))
    host.input.pointerUp({ x: 20, y: 20 })
    const doc = host.reader.doc
    const id = doc.objectOrder[0]
    expect(id).toBeDefined()

    // The default tool. Pressing empty ground with something selected clears it and adds nothing.
    dispatch('tools.set', { tool: 'select' })
    host.input.pointerDown(pressAt(5, 5, { pick: { surface: topAt(5, 5), point: { x: 5.5, z: 5.5 }, objectId: null } }))
    host.input.pointerUp({ x: 50, y: 50 })
    expect(doc.objectOrder).toHaveLength(1)
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBeNull()

    // Pressing the object selects it, and the rest of the drag moves it.
    host.input.pointerDown(pressAt(2, 2, { pick: { surface: topAt(2, 2), point: { x: 2.5, z: 2.5 }, objectId: id } }))
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBe(id)
    host.input.strokeMove({ surface: topAt(4, 4), point: { x: 4.5, z: 4.5 }, objectId: null }, NO_MODIFIERS)
    expect(doc.objects[id].position[0]).toBeCloseTo(4.5)
    host.input.pointerUp({ x: 40, y: 40 })
    expect(host.reader.undoLabel()).toBe('Move object')

    // Shift on empty ground keeps the selection.
    host.input.pointerDown(pressAt(6, 6, { pick: { surface: topAt(6, 6), point: { x: 6.5, z: 6.5 }, objectId: null }, modifiers: { ...NO_MODIFIERS, shift: true } }))
    host.input.pointerUp({ x: 60, y: 60 })
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBe(id)
    expect(doc.objectOrder).toHaveLength(1)
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
    const { host, dispatch } = makeHost([{ owner: 'test.job', create: () => ({ logic: jobLogic }) }])
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
    expect(dispatch('tools.set', { tool: 'object' })).toEqual({ ok: true })
    expect(host.children.tools.getSnapshot().context.tool).toBe('object')
  })

  it('dispose(owner): revokes the declarations, sends dispose, stops the ref, keeps the ref', () => {
    commands.declare('test.job2', { id: 'test.job2.poke', title: 'Poke' })
    const { host, dispatch } = makeHost([{ owner: 'test.job2', create: () => ({ logic: jobLogic }) }])
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
 * Vite's half of a hot update, as a stub: it records the disposer so a test
 * can fire it in Vite's own order — the changed module's disposer runs and is
 * awaited, and only THEN is the new module imported (#21 §4 read that out of
 * `vite/dist/client/client.mjs`). No Vite here, and none needed: what the host
 * has to get right is what happens on either side of that call.
 */
function fakeHot(): HotHandle & { fire(): void } {
  let disposer: (() => void) | null = null
  return {
    accept: () => undefined,
    dispose: (callback) => void (disposer = callback),
    fire: () => disposer?.(),
  }
}

function pokesOf(ref: AnyActorRef | undefined): number {
  return (ref?.getSnapshot() as { context: { pokes: number } } | undefined)?.context.pokes ?? -1
}

describe('a hot re-import: the install hook (#21 §6)', () => {
  it('replaces the owner\'s actor with the re-minted logic, and keeps routing to the address', () => {
    const hot = fakeHot()
    const owner = defineFeature('test.hmr', hot)
    commands.declare(owner, { id: 'test.hmr.poke', title: 'Poke' })
    // Published before the host exists, exactly as an app's `features/index.ts`
    // does it: nobody is listening yet, and the module value is handed in.
    const { host, dispatch } = makeHost([provideFeature({ owner, create: () => ({ logic: jobLogic }) })])
    const first = host.child(owner)
    expect(dispatch('test.hmr.poke')).toEqual({ ok: true })
    expect(pokesOf(first)).toBe(1)

    hot.fire()

    // The registry revoked, the host drained and stopped. Both halves, and in
    // that order: a command that arrives now is `unknown`, not `unhandled`.
    expect(commands.get('test.hmr.poke')).toBeUndefined()
    expect(first?.getSnapshot().status).toBe('stopped')
    expect(dispatch('test.hmr.poke')).toMatchObject({ ok: false, kind: 'unknown' })

    // The module re-executes: same owner, new declarations, NEW logic the host
    // has never spawned. Nothing hands it in this time — the install hook is
    // the only thing that tells the host at all.
    const remint = defineFeature('test.hmr', hot)
    commands.declare(remint, { id: 'test.hmr.poke', title: 'Poke' })
    provideFeature({ owner: remint, create: () => ({ logic: jobLogic }) })

    const second = host.child(owner)
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    expect(second?.getSnapshot().status).toBe('active')
    expect(dispatch('test.hmr.poke')).toEqual({ ok: true })
    // A fresh actor, not the old one's state: the count restarts.
    expect(pokesOf(second)).toBe(1)

    host.dispose(owner)
    host.stop()
  })

  it('stops installing into a host that has stopped', () => {
    const hot = fakeHot()
    const owner = defineFeature('test.hmr2', hot)
    const { host } = makeHost([provideFeature({ owner, create: () => ({ logic: jobLogic }) })])
    host.stop()

    hot.fire()
    defineFeature('test.hmr2', hot)
    provideFeature({ owner, create: () => ({ logic: jobLogic }) })

    // Nothing was sent at the stopped root, so nothing dead-lettered: the hook
    // is released by `stop`, not left to fire at a corpse.
    expect(host.deadLetters).toEqual([])
    dispose('test.hmr2')
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
    const { host, dispatch } = makeHost([{ owner: 'test.noisy', create: () => ({ logic: noisyLogic }) }])

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

describe('the relative and composite commands the keymap needs', () => {
  it('resizes the brush by a delta, clamped at both ends', () => {
    const { host, dispatch } = makeHost()
    const size = () => host.children.tools.getSnapshot().context.brush.size
    expect(size()).toBe(1)

    expect(dispatch('brush.resize', { by: 4 })).toEqual({ ok: true })
    expect(size()).toBe(5)
    expect(dispatch('brush.resize', { by: -1 })).toEqual({ ok: true })
    expect(size()).toBe(4)

    // The clamp the `[` and `]` keydown handler used to carry, moved to the
    // actor that owns the parameter: holding either key runs off neither end.
    for (let i = 0; i < 20; i++) dispatch('brush.resize', { by: -1 })
    expect(size()).toBe(1)
    for (let i = 0; i < 20; i++) dispatch('brush.resize', { by: 1 })
    expect(size()).toBe(12)
  })

  it('refuses a brush delta that is not an integer in range', () => {
    const { dispatch } = makeHost()
    expect(dispatch('brush.resize', { by: 99 })).toMatchObject({ ok: false, kind: 'invalid-args', issues: [{ path: ['by'] }] })
    expect(dispatch('brush.resize', {})).toMatchObject({ ok: false, kind: 'invalid-args' })
  })

  it('runs a composite in order, across owners', () => {
    // The `3` binding: one chord, two owners' commands. A binding carries one
    // `(id, args)`, so the composite is the argument.
    const { host, dispatch } = makeHost()
    expect(
      dispatch('commands.run', {
        commands: [
          { id: 'tools.set', args: { tool: 'object' } },
          { id: 'view.set', args: { inspector: 'coverage' } },
        ],
      }),
    ).toEqual({ ok: true })
    expect(host.children.tools.getSnapshot().context.tool).toBe('object')
    expect(host.children.view.getSnapshot().context.inspector).toBe('coverage')
  })

  it('stops a composite at the first step that refuses, and answers with that refusal', () => {
    const { host, dispatch } = makeHost()
    expect(
      dispatch('commands.run', {
        commands: [
          { id: 'view.set', args: { showGrid: false } },
          { id: 'view.set', args: { inspector: 'nonsense' } },
          { id: 'tools.set', args: { tool: 'object' } },
        ],
      }),
    ).toMatchObject({ ok: false, kind: 'invalid-args' })
    // The first step landed and the third never ran: a composite is a
    // sequence of dispatches, not a transaction.
    expect(host.children.view.getSnapshot().context.showGrid).toBe(false)
    expect(host.children.tools.getSnapshot().context.tool).toBe('select')
  })

  it('refuses a composite that recurses instead of looping forever', () => {
    const { dispatch } = makeHost()
    const loop: { commands: { id: string; args: unknown }[] } = { commands: [] }
    loop.commands.push({ id: 'commands.run', args: loop })
    expect(dispatch('commands.run', loop)).toMatchObject({ ok: false, kind: 'unhandled', reason: expect.stringContaining('refers to itself') as string })
  })
})

describe('deleting objects', () => {
  function withObject(): ReturnType<typeof makeHost> & { object: MapObject } {
    const made = makeHost()
    apply(made.host, 'Add object', addObject(made.host.reader.doc, OBJECT))
    return { ...made, object: OBJECT }
  }

  it('deletes by stable id, leaving objects and objectOrder agreeing', () => {
    const { host, dispatch, object } = withObject()
    expect(host.reader.doc.objectOrder).toEqual([object.id])

    expect(dispatch('objects.delete', { ids: [object.id] })).toEqual({ ok: true })

    expect(host.reader.doc.objects[object.id]).toBeUndefined()
    expect(host.reader.doc.objectOrder).toEqual([])
    expect(Object.keys(host.reader.doc.objects)).toEqual(host.reader.doc.objectOrder)
  })

  it('deletes several at once without one restoring another', () => {
    // `removeObject` rebuilds the WHOLE order per call against a document
    // that has not been written yet, so mapping it over two ids would have
    // the second list still holding the first — and the last patch to land
    // would put it back.
    const { host, dispatch } = makeHost()
    const second = { ...OBJECT, id: 'obj-2' }
    apply(host, 'Add object', addObject(host.reader.doc, OBJECT))
    apply(host, 'Add object', addObject(host.reader.doc, second))

    expect(dispatch('objects.delete', { ids: [OBJECT.id, second.id] })).toEqual({ ok: true })
    expect(host.reader.doc.objectOrder).toEqual([])
    expect(Object.keys(host.reader.doc.objects)).toEqual([])
  })

  it('leaves the document alone when no id names anything', () => {
    const { host, dispatch } = withObject()
    const revision = host.reader.revision
    expect(dispatch('objects.delete', { ids: ['nobody'] })).toEqual({ ok: true })
    expect(host.reader.revision).toBe(revision)
    // No entry pushed either: the top of the stack is still what put the
    // object there, so an undo does not have a no-op to eat first.
    expect(host.reader.undoLabel()).toBe('Add object')
  })

  it('refuses an empty or malformed id list', () => {
    const { dispatch } = makeHost()
    expect(dispatch('objects.delete', { ids: [] })).toMatchObject({ ok: false, kind: 'invalid-args' })
    expect(dispatch('objects.delete', { id: 'obj-1' })).toMatchObject({ ok: false, kind: 'invalid-args' })
  })

  it('selection.delete fills the ids in from the selection and then clears it', () => {
    // The whole point of the composite: what reaches a handler is
    // `objects.delete({ ids })`. No actor learns what was selected (#11), and
    // the expansion happens in `dispatch`, outside every machine.
    const { host, dispatch, object } = withObject()
    dispatch('selection.set', { id: object.id })

    expect(dispatch('selection.delete')).toEqual({ ok: true })

    expect(host.reader.doc.objects[object.id]).toBeUndefined()
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBeNull()
    expect(host.contextKeys()['view.hasSelection']).toBe(false)
  })

  it('selection.delete is unavailable with nothing selected, and says so', () => {
    const { dispatch } = makeHost()
    expect(dispatch('selection.delete')).toMatchObject({
      ok: false,
      kind: 'unavailable',
      reason: expect.stringContaining('view.hasSelection') as string,
    })
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
