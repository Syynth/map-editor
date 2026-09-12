import { EditorStore, createDocumentActorLogic, createMap, type SurfaceAddress } from '@map-editor/document'
import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'

import { ORBIT_DRAG_THRESHOLD, gestureLogic, type PointerPress } from './gesture'
import type { DocumentRef } from './stroke'
import type { EditorStrokeHandler, StrokeSample } from './strokes'

/**
 * #10's shape for gesture semantics: synthetic pointer sequences into the
 * arbitration actor, no DOM. The Playwright tour proves the DOM wiring only;
 * "4 px means drag" is asserted here and nowhere else.
 *
 * The handler is a recorder, so what the stroke actor was told — and at which
 * sample — is the assertion. The document actor is real, so the brackets it
 * receives are real sends, but nothing here needs to write.
 */

function top(x: number, y: number): SurfaceAddress {
  return { kind: 0, x, y, dir: -1, level: 0 }
}

const NO_MODIFIERS = { shift: false, alt: false, ctrl: false }

function press(x: number, y: number, extra: Partial<PointerPress> = {}): PointerPress {
  return { x, y, button: 0, modifiers: NO_MODIFIERS, pick: { surface: top(x, y), point: { x, z: y }, objectId: null }, ...extra }
}

function rig(options: { editing?: boolean; strokes?: boolean } = {}) {
  const editing = options.editing ?? true
  const store = new EditorStore(createMap(8, 8))
  const document = createActor(createDocumentActorLogic(store)).start() as DocumentRef
  const begun: StrokeSample[] = []
  const moved: StrokeSample[] = []
  const ended: StrokeSample[] = []
  let asked = 0
  const handler: EditorStrokeHandler = {
    label: 'Recorded',
    begin: (sample) => {
      begun.push(sample)
      return []
    },
    move: (sample) => {
      moved.push(sample)
      return []
    },
    end: (sample) => {
      ended.push(sample)
      return []
    },
  }
  const gesture = createActor(
    gestureLogic({
      reader: store.reader,
      document,
      strokeFor: () => {
        asked += 1
        return options.strokes === false ? undefined : handler
      },
    }),
  ).start()
  const down = (p: PointerPress) => {
    gesture.send({ type: 'pointer.down', ...p, editing })
    return gesture.getSnapshot().value
  }
  const move = (x: number, y: number) => {
    gesture.send({ type: 'pointer.move', x, y, modifiers: NO_MODIFIERS })
    return gesture.getSnapshot().value
  }
  const up = (x: number, y: number) => {
    gesture.send({ type: 'pointer.up', x, y })
    return gesture.getSnapshot().value
  }
  return { gesture, store, down, move, up, begun, moved, ended, asked: () => asked }
}

const ALT = { modifiers: { ...NO_MODIFIERS, alt: true } }

describe('the alt+left press: eyedropper click or orbit drag', () => {
  it('down, move 2 px, up: the click replays at the PRESS sample, and no orbit began', () => {
    const { down, move, up, begun, ended, moved } = rig()
    expect(down(press(10, 10, ALT))).toBe('pending')
    expect(move(11, 11)).toBe('pending')
    expect(up(11, 11)).toBe('none')

    expect(begun).toHaveLength(1)
    expect(begun[0].pick.surface).toEqual(top(10, 10))
    expect(begun[0].modifiers.alt).toBe(true)
    expect(ended).toHaveLength(1)
    expect(moved).toEqual([])
  })

  it('down, move 6 px: an orbit, and no click on release', () => {
    const { down, move, up, asked } = rig()
    expect(down(press(10, 10, ALT))).toBe('pending')
    expect(move(14, 14)).toBe('orbit')
    expect(up(14, 14)).toBe('none')
    expect(asked()).toBe(0)
  })

  it(`declares itself at exactly ${ORBIT_DRAG_THRESHOLD} px, measured from the press, not the last move`, () => {
    const { down, move } = rig()
    down(press(0, 0, ALT))
    expect(move(ORBIT_DRAG_THRESHOLD - 1, 0)).toBe('pending')
    // Only 1 px since the last move; 4 from the press.
    expect(move(ORBIT_DRAG_THRESHOLD, 0)).toBe('orbit')
  })

  it('stays pending through moves that jitter under the threshold, then clicks', () => {
    const { down, move, up, begun } = rig()
    down(press(5, 5, ALT))
    for (const [x, y] of [[6, 5], [5, 6], [4, 5], [5, 4], [7, 7]] as const) expect(move(x, y)).toBe('pending')
    up(7, 7)
    expect(begun).toHaveLength(1)
    expect(begun[0].pick.surface).toEqual(top(5, 5))
  })
})

describe('buttons', () => {
  it('middle orbits, right pans, and neither asks the tool for a stroke', () => {
    const { down, up, asked } = rig()
    expect(down(press(0, 0, { button: 1, pick: null }))).toBe('orbit')
    expect(up(3, 3)).toBe('none')
    expect(down(press(0, 0, { button: 2, pick: null }))).toBe('pan')
    expect(up(3, 3)).toBe('none')
    expect(asked()).toBe(0)
  })

  it('a second button during a gesture is ignored rather than switching mid-drag', () => {
    const { down, move, up, begun, ended } = rig()
    expect(down(press(0, 0))).toBe('stroke')
    expect(down(press(0, 0, { button: 1, pick: null }))).toBe('stroke')
    expect(move(2, 2)).toBe('stroke')
    expect(up(2, 2)).toBe('none')
    expect(begun).toHaveLength(1)
    expect(ended).toHaveLength(1)
  })
})

describe('play mode', () => {
  it('refuses strokes and the pending click, but still orbits and pans', () => {
    const { down, move, up, asked } = rig({ editing: false })
    expect(down(press(0, 0))).toBe('none')
    expect(down(press(0, 0, ALT))).toBe('pending')
    expect(up(1, 1)).toBe('none')
    expect(asked()).toBe(0)

    expect(down(press(0, 0, ALT))).toBe('pending')
    expect(move(9, 9)).toBe('orbit')
    expect(up(9, 9)).toBe('none')
    expect(down(press(0, 0, { button: 1, pick: null }))).toBe('orbit')
    expect(up(0, 0)).toBe('none')
    expect(down(press(0, 0, { button: 2, pick: null }))).toBe('pan')
    expect(asked()).toBe(0)
  })
})

describe('a stroke', () => {
  it('spawns on the press, forwards each sample, ends with the last one, and the child stops', () => {
    const { gesture, down, up, begun, moved, ended } = rig()
    expect(down(press(1, 1))).toBe('stroke')
    const stroke = gesture.getSnapshot().context.stroke
    expect(stroke?.getSnapshot().status).toBe('active')

    const b: StrokeSample = { pick: { surface: top(2, 1), point: null, objectId: null }, modifiers: NO_MODIFIERS }
    gesture.send({ type: 'stroke.move', sample: b })
    expect(up(2, 1)).toBe('none')

    expect(begun.map((s) => s.pick.surface)).toEqual([top(1, 1)])
    expect(moved).toEqual([b])
    expect(ended).toEqual([b])
    expect(stroke?.getSnapshot().status).toBe('done')
  })

  it('ends at the press sample when the pointer never moved', () => {
    const { down, up, ended } = rig()
    down(press(3, 3))
    up(3, 3)
    expect(ended[0].pick.surface).toEqual(top(3, 3))
  })

  it('retains the finished stroke\'s ref and replaces it with the next press', () => {
    const { gesture, down, up } = rig()
    down(press(0, 0))
    const first = gesture.getSnapshot().context.stroke
    up(0, 0)
    expect(gesture.getSnapshot().context.stroke).toBe(first)
    down(press(1, 1))
    expect(gesture.getSnapshot().context.stroke).not.toBe(first)
    up(1, 1)
  })

  it('starts nothing when the tool declines, and the press falls through to none', () => {
    const { down, up, asked, begun } = rig({ strokes: false })
    expect(down(press(0, 0))).toBe('none')
    expect(asked()).toBe(1)
    expect(begun).toEqual([])
    expect(up(0, 0)).toBe('none')
  })

  it('brackets the document actor with beginStroke and endStroke under the handler\'s label', () => {
    const { store, down, up } = rig()
    down(press(0, 0))
    expect(store.inStroke).toBe(true)
    expect(store.reader.canUndo()).toBe(false)
    up(0, 0)
    expect(store.inStroke).toBe(false)
  })
})

describe('held keys', () => {
  it('tracks key.down and key.up as a set the play loop reads', () => {
    const { gesture } = rig()
    gesture.send({ type: 'key.down', key: 'w' })
    gesture.send({ type: 'key.down', key: 'w' })
    gesture.send({ type: 'key.down', key: 'a' })
    expect([...gesture.getSnapshot().context.held].sort()).toEqual(['a', 'w'])
    gesture.send({ type: 'key.up', key: 'w' })
    gesture.send({ type: 'key.up', key: 'w' })
    expect([...gesture.getSnapshot().context.held]).toEqual(['a'])
  })

  it('keeps them across gestures', () => {
    const { gesture, down, up } = rig()
    gesture.send({ type: 'key.down', key: 'shift' })
    down(press(0, 0, { button: 1, pick: null }))
    up(0, 0)
    expect(gesture.getSnapshot().context.held.has('shift')).toBe(true)
  })
})
