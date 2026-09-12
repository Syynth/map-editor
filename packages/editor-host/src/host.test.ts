import {
  EditorStore,
  addObject,
  cellIndex,
  createMap,
  defaultFacing,
  raise,
  removeObject,
  type MapObject,
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
    dispatch('tools.set', { tool: 'object' })
    raiseOnce(store, 5, 5)
    expect(store.reader.canUndo()).toBe(true)

    host.input.pointerDown(pressAt(3, 3))
    expect(store.reader.canUndo()).toBe(false)
    expect(dispatch('undo')).toMatchObject({ ok: false, kind: 'unavailable' })
    host.input.pointerUp({ x: 30, y: 30 })
    expect(dispatch('undo')).toEqual({ ok: true })
  })

  it('a press with a tool whose feature was never installed starts nothing', () => {
    // The default tool is `terrain`, whose handler belongs to a feature this
    // host was not given. `toolContract` answers `undefined`, so the gesture
    // actor spawns no stroke — the same fall-through a declined press gets,
    // rather than a half-live stroke over a tool nothing implements.
    const { host, store } = makeHost()
    expect(host.contextKeys()['tools.tool']).toBe('terrain')
    expect(host.toolContract('terrain')).toBeUndefined()

    expect(host.input.pointerDown(pressAt(3, 3))).toBe('none')
    host.input.pointerUp({ x: 30, y: 30 })
    expect(store.reader.canUndo()).toBe(false)
  })

  it('in play mode a left press starts no stroke, while middle and right still orbit and pan', () => {
    const { host, store, dispatch } = makeHost()
    dispatch('tools.set', { tool: 'object', spriteName: 'tree' })
    dispatch('mode.play')

    expect(host.input.pointerDown(pressAt(1, 1))).toBe('none')
    host.input.pointerUp({ x: 10, y: 10 })
    expect(store.reader.doc.objectOrder).toEqual([])
    expect(store.reader.canUndo()).toBe(false)

    expect(host.input.pointerDown(pressAt(1, 1, { button: 1, pick: null }))).toBe('orbit')
    host.input.pointerUp({ x: 10, y: 10 })
    expect(host.input.pointerDown(pressAt(1, 1, { button: 2, pick: null }))).toBe('pan')
    host.input.pointerUp({ x: 10, y: 10 })

    // Back in edit mode the same press strokes again: `editing` is read per press.
    dispatch('mode.edit')
    expect(host.input.pointerDown(pressAt(1, 1))).toBe('stroke')
    host.input.pointerUp({ x: 10, y: 10 })
    expect(store.reader.doc.objectOrder).toHaveLength(1)
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
    expect(dispatch('tools.set', { tool: 'camera' })).toEqual({ ok: true })
    expect(host.children.tools.getSnapshot().context.tool).toBe('camera')
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
