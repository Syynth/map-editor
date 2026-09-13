import {
  createDocument,
  addObject,
  createMap,
  defaultFacing,
  raise,
  topHeight,
  type MapObject,
  type Patch,
  type MapDoc,
  type ReadonlyMapDoc,
  type VoxelStructure,
} from '@papercut/document'
import { createHost, type Host } from '@papercut/editor-host'
import type { TerrainParams } from '@papercut/feature-terrain'
import { afterEach, describe, expect, it } from 'vitest'

import { features } from '../features'

import { installKeyDispatcher, type KeyTarget } from './keys'

/** The root voxel volume a fresh level has, mutable for setup: `createMap` names it `ground`. */
const ground = (doc: ReadonlyMapDoc | MapDoc): VoxelStructure => doc.structures.ground as VoxelStructure


/**
 * The keyboard, end to end: a synthetic `keydown` on a target the test owns,
 * through the resolver, into `dispatch`, asserted through `reader` and the
 * actor snapshots (#10 — no React, no DOM, no GL).
 *
 * It lives in the app because the app is where the dispatcher lives, and the
 * dispatcher is where it lives because it is the one piece that needs a
 * window — `editor-host` compiles without `DOM` on purpose. The `target`
 * option is what lets that be true and this test still exist.
 */
class FakeKeys implements KeyTarget {
  private readonly listeners = new Map<string, Set<(event: KeyboardEvent) => void>>()
  /** What the dispatcher asked the browser not to do. */
  prevented: string[] = []

  addEventListener(type: 'keydown' | 'keyup', listener: (event: KeyboardEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: 'keydown' | 'keyup', listener: (event: KeyboardEvent) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(type: 'keydown' | 'keyup', key: string, extra: Partial<KeyboardEvent> = {}): void {
    const event = {
      key,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      target: null,
      preventDefault: () => this.prevented.push(key),
      ...extra,
    } as unknown as KeyboardEvent
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((total, set) => total + set.size, 0)
  }
}

const started: Array<{ host: Host; remove: () => void }> = []

function editor(): { host: Host; keys: FakeKeys } {
  const host = createHost({ features, document: createDocument(createMap(8, 8)) })
  const keys = new FakeKeys()
  const remove = installKeyDispatcher(host, { target: keys, platform: 'other' })
  started.push({ host, remove })
  return { host, keys }
}

/** Setup: one labelled edit, at the document actor's own event — there is no writer to reach for (#13). */
function apply(host: Host, label: string, patches: Patch[]): void {
  host.children.document.send({ type: 'patch', label, patches })
}

afterEach(() => {
  for (const { host, remove } of started.splice(0)) {
    remove()
    host.stop()
  }
})

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

describe('the one keyboard dispatcher', () => {
  it('turns the undo chord into a dispatch the reader reflects', () => {
    const { host, keys } = editor()
    const height = () => topHeight(ground(host.reader.doc), 2, 2)
    const before = height()
    apply(host, 'Raise', raise(host.reader.doc, ground(host.reader.doc), [[2, 2]], 3))
    expect(height()).toBe(before + 3)

    keys.send('keydown', 'z', { ctrlKey: true })

    expect(height()).toBe(before)
    // Consumed, so the browser's own undo does not also fire.
    expect(keys.prevented).toEqual(['z'])
  })

  it('undoes once per keypress, not twice', () => {
    const { host, keys } = editor()
    apply(host, 'Raise', raise(host.reader.doc, ground(host.reader.doc), [[1, 1]], 1))
    apply(host, 'Raise', raise(host.reader.doc, ground(host.reader.doc), [[2, 2]], 1))

    keys.send('keydown', 'z', { ctrlKey: true })

    expect(host.reader.canUndo()).toBe(true)
    expect(host.reader.canRedo()).toBe(true)
  })

  it('does not consume a chord whose command is unavailable', () => {
    // Nothing to undo, so the binding falls through and the key reaches the
    // page — #14's rule, seen from the listener rather than the resolver.
    const { keys } = editor()
    keys.send('keydown', 'z', { ctrlKey: true })
    expect(keys.prevented).toEqual([])
  })

  it('switches tools, resizes the brush and toggles the terrain mode', () => {
    const { host, keys } = editor()
    const tools = () => host.children.tools.getSnapshot()
    const terrain = () => tools().context.features.terrain as unknown as TerrainParams

    keys.send('keydown', 'o')
    expect(tools().context.tool).toBe('object')
    keys.send('keydown', 't')
    expect(tools().context.tool).toBe('terrain')

    keys.send('keydown', ']')
    keys.send('keydown', ']')
    expect(terrain().brush.size).toBe(3)
    keys.send('keydown', '[')
    expect(terrain().brush.size).toBe(2)

    keys.send('keydown', 'Tab')
    expect(terrain().terrainMode).toBe('paint')
    keys.send('keydown', 'Tab')
    expect(terrain().terrainMode).toBe('sculpt')
    // Tab must not also move focus, which is what the old handler's bare
    // `preventDefault` was for.
    expect(keys.prevented.filter((key) => key === 'Tab')).toHaveLength(2)
  })

  it('Escape returns to Select from any tool, and falls through when Select is already active', () => {
    const { host, keys } = editor()
    const tool = () => host.children.tools.getSnapshot().context.tool
    expect(tool()).toBe('select')
    // Nothing to return to: the binding's `when` fails, so the key is not
    // consumed and the page sees it — a dialog's own Escape still works.
    keys.send('keydown', 'Escape')
    expect(keys.prevented).toEqual([])
    keys.send('keydown', 't')
    expect(tool()).toBe('terrain')
    keys.send('keydown', 'Escape')
    expect(tool()).toBe('select')
    expect(keys.prevented).toEqual(['t', 'Escape'])
    keys.send('keydown', 'v')
    expect(tool()).toBe('select')
  })

  it('toggles the game camera and play mode from one chord each', () => {
    const { host, keys } = editor()
    keys.send('keydown', 'g')
    expect(host.children.view.getSnapshot().context.gameCamera).toBe(true)
    keys.send('keydown', 'g')
    expect(host.children.view.getSnapshot().context.gameCamera).toBe(false)

    keys.send('keydown', 'p')
    expect(host.actor.getSnapshot().value).toBe('play')
    keys.send('keydown', 'p')
    expect(host.actor.getSnapshot().value).toBe('edit')
  })

  it('deletes the selected object and clears the selection', () => {
    const { host, keys } = editor()
    apply(host, 'Add object', addObject(host.reader.doc, OBJECT))
    host.dispatch('selection.set', { id: OBJECT.id })

    keys.send('keydown', 'Delete')

    expect(host.reader.doc.objects[OBJECT.id]).toBeUndefined()
    expect(host.reader.doc.objectOrder).toEqual([])
    expect(host.children.view.getSnapshot().context.selectedObjectId).toBeNull()
  })

  it('holds keys for the gesture actor even while a text field has focus', () => {
    // The two halves the old code split across two listeners: `App.tsx`
    // ignored everything over an input, `viewport.ts` tracked held keys
    // regardless. WASD in play mode reads that set every frame.
    const { host, keys } = editor()
    apply(host, 'Raise', raise(host.reader.doc, ground(host.reader.doc), [[2, 2]], 1))
    const input = { tagName: 'INPUT' }

    keys.send('keydown', 'w', { target: input as unknown as EventTarget })
    expect([...host.input.heldKeys()]).toEqual(['w'])

    // …and the chord half is suppressed, so typing "z" into a name field with
    // ctrl held does not undo the document.
    keys.send('keydown', 'z', { ctrlKey: true, target: input as unknown as EventTarget })
    expect(host.reader.canUndo()).toBe(true)
    expect(keys.prevented).toEqual([])

    keys.send('keyup', 'w', { target: input as unknown as EventTarget })
    // `z` is still held — every key is, over an input or not; only the chord
    // half cares where the focus is.
    expect([...host.input.heldKeys()]).toEqual(['z'])
  })

  it('removes both listeners when disposed', () => {
    const host = createHost({ features, document: createDocument(createMap(4, 4)) })
    const keys = new FakeKeys()
    const remove = installKeyDispatcher(host, { target: keys, platform: 'other' })
    expect(keys.listenerCount).toBe(2)
    remove()
    expect(keys.listenerCount).toBe(0)
    host.stop()
  })
})
