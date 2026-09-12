import { EditorStore, cellIndex, createMap, raise } from '@map-editor/document'
import { commands, dispose } from '@map-editor/registry'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SimulatedClock, setup as setupMachine, types } from 'xstate'

import { createHost, type Feature, type Host } from './host'

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
