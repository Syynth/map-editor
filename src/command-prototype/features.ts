/**
 * PROTOTYPE — throwaway. See issue #8.
 *
 * Three feature modules in the shape #9 settled on: each declares its commands
 * at import (static data), and exports a `logic` actor carrying the handlers.
 * The host spawns the logic and holds the `ActorRef`; the feature never does.
 *
 * The tiers are deliberately unlike each other, to test whether the split is
 * honest: `terrain` writes the document, `tools` never touches it, and `play`
 * has a lifetime shorter than the session.
 */

import { setup, types } from 'xstate'
import type { EditorStore } from '../core/store'
import { raise as raiseOp, flatten as flattenOp, type Cell } from '../core/ops'
import { declare, and, is, always, type Predicate } from './registry'

/** What a command invocation looks like on the wire: plain, serialisable. */
export interface Invocation {
  id: string
  args: Record<string, unknown>
}

/** Reported back so outcomes never have to enter anyone's context. */
export interface Reply {
  ok: boolean
  id: string
  note: string
}

const schemas = {
  events: { command: types<Invocation>() },
  emitted: { reply: types<Reply>() },
}

const editing: Predicate = and(is('documentOpen', true), is('mode', 'edit'))

// ---------------------------------------------------------------------------
// Feature: terrain (core tier — the only one holding the store write handle)
// ---------------------------------------------------------------------------

export const TERRAIN = 'terrain'

declare({
  id: 'terrain.raise', title: 'Raise Terrain', category: 'Terrain', feature: TERRAIN,
  when: and(editing, is('tool', 'raise')),
  args: { cells: { t: 'cells' }, delta: { t: 'int', min: -8, max: 8 } },
})
declare({
  id: 'terrain.flatten', title: 'Flatten Terrain', category: 'Terrain', feature: TERRAIN,
  when: and(editing, is('tool', 'raise')),
  args: { cells: { t: 'cells' }, height: { t: 'int', min: 0, max: 40 } },
})
declare({
  id: 'edit.undo', title: 'Undo', category: 'Edit', feature: TERRAIN,
  when: and(editing, is('canUndo', true)),
})
declare({
  id: 'edit.redo', title: 'Redo', category: 'Edit', feature: TERRAIN,
  when: and(editing, is('canRedo', true)),
})

/**
 * The store arrives by FACTORY CLOSURE, never in `context` and never as
 * `input` — `input` rides the `xstate.init` event and reaches an inspector
 * even when kept out of context (measured: 100,089 bytes vs 22).
 *
 * NOTE THE `enq(() => …)` WRAPPERS, which are not decoration.
 *
 * Measured on v6 alpha.53: a transition function is invoked TWICE per event —
 * once to compute the next state, once to execute effects. Context advances
 * once and `enq(fn)` runs once, but a side effect written inline in the body
 * runs twice. The first draft of this file called `store.apply(...)` directly
 * and every edit landed twice: a raise of +3 moved the cell by 6, silently.
 *
 * On the document's single write path that is precisely the bug class the
 * map's constraints exist to prevent, and v6 makes it easy to hit. It is a
 * strong candidate for a mechanical check (#20): no store writes in a
 * transition body; every effect goes through `enq`.
 */
export function terrainLogic(store: EditorStore) {
  return setup({ schemas }).createMachine({
    id: 'terrain',
    initial: 'ready',
    context: { handled: 0 },
    states: {
      ready: {
        on: {
          command: ({ context, event }, enq) => {
            const { id, args } = event
            if (id === 'terrain.raise') {
              enq(() => store.apply('Raise Terrain', raiseOp(store.doc, args.cells as Cell[], args.delta as number)))
            } else if (id === 'terrain.flatten') {
              enq(() => store.apply('Flatten Terrain', flattenOp(store.doc, args.cells as Cell[], args.height as number)))
            } else if (id === 'edit.undo') {
              enq(() => store.undo())
            } else if (id === 'edit.redo') {
              enq(() => store.redo())
            } else {
              enq.emit({ type: 'reply', ok: false, id, note: 'terrain declared it but has no handler' })
              return {}
            }
            enq(() => {})
            enq.emit({ type: 'reply', ok: true, id, note: `handled by ${TERRAIN}` })
            return { context: { handled: context.handled + 1 } }
          },
        },
      },
    },
  })
}

// ---------------------------------------------------------------------------
// Feature: tools (editor tier — never touches the document)
// ---------------------------------------------------------------------------

export const TOOLS = 'tools'

declare({
  id: 'tool.select', title: 'Choose Tool', category: 'Tools', feature: TOOLS,
  // Not gated on `tool`: one command with an arg, not three commands.
  when: is('documentOpen', true),
  args: { name: { t: 'string', oneOf: ['select', 'raise', 'paint'] } },
})

export const toolsLogic = setup({ schemas }).createMachine({
  id: 'tools',
  initial: 'ready',
  context: { tool: 'select' as 'select' | 'raise' | 'paint' },
  states: {
    ready: {
      on: {
        command: ({ context, event }, enq) => {
          if (event.id !== 'tool.select') {
            enq.emit({ type: 'reply', ok: false, id: event.id, note: 'tools has no handler for this' })
            return {}
          }
          const name = event.args.name as 'select' | 'raise' | 'paint'
          enq.emit({ type: 'reply', ok: true, id: event.id, note: `tool is now ${name}` })
          return { context: { ...context, tool: name } }
        },
      },
    },
  },
})

// ---------------------------------------------------------------------------
// Feature: play (lifetime shorter than the session — the interesting one)
// ---------------------------------------------------------------------------

export const PLAY = 'play'

/**
 * Declared always, handled only while the play actor is alive. `when` is
 * deliberately NOT gated on mode: availability and handled-ness are different
 * questions, and conflating them would hide the exact thing this prototype is
 * here to test.
 */
declare({
  id: 'play.step', title: 'Step One Frame', category: 'Play', feature: PLAY,
  when: always,
  args: { frames: { t: 'int', min: 1, max: 60 } },
})

export const playLogic = setup({ schemas }).createMachine({
  id: 'play',
  initial: 'running',
  context: { frame: 0 },
  states: {
    running: {
      on: {
        command: ({ context, event }, enq) => {
          if (event.id !== 'play.step') {
            enq.emit({ type: 'reply', ok: false, id: event.id, note: 'play has no handler for this' })
            return {}
          }
          const frame = context.frame + (event.args.frames as number)
          enq.emit({ type: 'reply', ok: true, id: event.id, note: `at frame ${frame}` })
          return { context: { frame } }
        },
      },
    },
  },
})

// ---------------------------------------------------------------------------
// Feature: host lifecycle. Declared by the host itself, handled by the router.
// ---------------------------------------------------------------------------

export const HOST = 'host'

declare({
  id: 'play.start', title: 'Enter Play Mode', category: 'Play', feature: HOST,
  when: and(is('documentOpen', true), is('mode', 'edit')),
})
declare({
  id: 'play.stop', title: 'Leave Play Mode', category: 'Play', feature: HOST,
  when: is('mode', 'play'),
})
