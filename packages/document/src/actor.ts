/**
 * The document actor: the one holder of the write path (#13).
 *
 * Everything that changes the document — a stroke tick, an inspector edit,
 * undo — arrives here as an event and leaves as exactly one call on `writer`.
 * Nothing else in the workspace can obtain a `writer` (it is not in the
 * barrel, and `EditorStore.doc` is private), so "one write path" is a fact
 * about the type graph rather than a rule someone has to remember. Undo
 * granularity lands here for the same reason: `beginStroke`/`endStroke` are
 * events, so the actor is the one place that decides when an `Edit` closes.
 *
 * Two constraints from the map (#2) shape the code and are easy to undo by
 * accident, so they are spelled out:
 *
 * 1. THE STORE ARRIVES BY FACTORY CLOSURE, NEVER BY `input`. `input` rides
 *    the `xstate.init` event and reaches an inspector even when kept out of
 *    context — measured at 100,089 bytes for a 50k-entry store against 22 for
 *    a closure (#4). `documentLogic(writer)` closes over the handle; the
 *    machine's context is empty and stays that way.
 *
 * 2. EVERY WRITE IS `enq(() => writer.…)`, NEVER INLINE. On `6.0.0-alpha.53` a
 *    transition body is its own guard: v6 runs it once with a stub `enq`
 *    whose methods throw an internal signal, and if the body touched `enq` it
 *    is replayed with the real one. So a statement above the first `enq` call
 *    runs twice, one below it runs once, and one on a path that returns
 *    `undefined` — "not enabled" — runs anyway even though no transition is
 *    taken. An inline `writer.apply` raising a cell by +3 moves it by 6 with
 *    no error (#8 hit exactly this). `actor.test.ts` holds the standing guard
 *    #22 asked for: N patch events are N applications, and a refused event is
 *    zero. It goes red the moment a write moves inline; leave it standing.
 *
 * Teardown is not in `exit`: exit actions do not run when an actor is stopped
 * (xstate#4630). The actor owns nothing that needs releasing — the store
 * outlives it by design — so there is nothing to tear down here either.
 */

import type { CommandEvent } from '@map-editor/registry'
import { setup, types } from 'xstate'

// Imported for its side effect as much as its exports: the module declares
// `undo` and `redo` at import, and the actor is what makes them handled.
import './commands'
import type { Patch } from './edits'
import { writerOf, type DocumentWriter, type EditorStore } from './store'

/**
 * What the actor accepts. Plain data throughout — a `Patch` addresses its
 * target by index, key or id, never by reference — which is what keeps a
 * recorded session replayable (#2's argument convention).
 *
 * `command` is the host's route in (#8): the same `undo`/`redo` the raw
 * events carry, arriving as a dispatched command so a keybinding, a menu and
 * a test reach the write handle by one path. The raw events stay for callers
 * that hold the ref directly — the stroke actor (#66 step 4) will send
 * `patch` per tick without a command in between.
 */
export type DocumentEvent =
  | { type: 'patch'; label: string; patches: Patch[] }
  | { type: 'beginStroke'; label: string }
  | { type: 'endStroke' }
  | { type: 'undo' }
  | { type: 'redo' }
  | CommandEvent

/**
 * The machine, closed over a writer. Internal: the barrel exports only the
 * pre-wired `createDocumentActorLogic`, so the parameter type — the write
 * handle — is never namable outside this package.
 */
export function documentLogic(writer: DocumentWriter) {
  return setup({
    schemas: {
      events: {
        patch: types<{ label: string; patches: Patch[] }>(),
        beginStroke: types<{ label: string }>(),
        endStroke: types<void>(),
        undo: types<void>(),
        redo: types<void>(),
        command: types<{ id: string; args: unknown }>(),
      },
    },
  }).createMachine({
    id: 'document',
    initial: 'ready',
    states: {
      ready: {
        on: {
          patch: ({ event }, enq) => {
            // An empty patch list is refused, not applied: returning
            // `undefined` here is the v6 "not enabled" shape, and the
            // `pruneNoops` inside `apply` would make it a no-op anyway. It is
            // also the not-taken path the guard test drives — the third
            // failure mode is an inline effect firing on exactly this branch.
            if (event.patches.length === 0) return undefined
            enq(() => writer.apply(event.label, event.patches))
            return {}
          },
          beginStroke: ({ event }, enq) => {
            enq(() => writer.beginStroke(event.label))
            return {}
          },
          endStroke: (_, enq) => {
            enq(() => writer.endStroke())
            return {}
          },
          undo: (_, enq) => {
            enq(() => writer.undo())
            return {}
          },
          redo: (_, enq) => {
            enq(() => writer.redo())
            return {}
          },
          command: ({ event }, enq) => {
            // Only the ids `commands.ts` declared can arrive here: the host
            // routes by declaring owner, and this owner declared two. Anything
            // else is refused with the `undefined` guard shape rather than
            // dropped inside `enq`, so it takes no transition at all.
            if (event.id === 'undo') enq(() => writer.undo())
            else if (event.id === 'redo') enq(() => writer.redo())
            else return undefined
            return {}
          },
        },
      },
    },
  })
}

/**
 * The pre-wired logic the host spawns (#13): hand it the store the app holds
 * and get back a machine that writes it. This is the only public route to a
 * document actor, and it takes a store rather than a writer so the writer
 * type never crosses the package boundary.
 */
export function createDocumentActorLogic(store: EditorStore) {
  return documentLogic(writerOf(store))
}

export type DocumentActorLogic = ReturnType<typeof createDocumentActorLogic>
