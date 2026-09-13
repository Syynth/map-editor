/**
 * The play session actor (#11).
 *
 * `mode` is a state of the host, but a play SESSION is a thing with a
 * lifetime: it begins when `mode.play` is dispatched, it ends when `mode.edit`
 * is, and everything it knows is true only in between. So the host spawns one
 * of these on the way into `play` and stops it on the way out, rather than
 * keeping session state in its own context where it would outlive the session
 * and have to be cleared by hand.
 *
 * What the session knows today is where the character stands up: the middle of
 * the map, on the ground under that point. Read ONCE, at spawn, from the
 * document — which is what the viewport did in its `togglePlay`, and moving it
 * here is the point of the actor rather than an incidental tidy. A session
 * started, the terrain sculpted, and the session restarted puts the character
 * on the new ground; a session already running keeps the ground it started on,
 * because the character has been walking since.
 *
 * What it deliberately does NOT own is the per-frame simulation. The character
 * moves sixty times a second against held keys and a delta, and that loop
 * stays in the viewport where the clock and the scene graph are (#4: an actor
 * round trip is ~3 µs, which is nothing once per session and everything in a
 * frame budget). The actor owns the session; the viewport owns the frame.
 *
 * The store arrives by factory closure, never by `input` (#2, #4): `playLogic`
 * closes over the reader and the machine's context holds three numbers.
 */

import {
  type DocumentReader,
  levelCentre,
} from '@papercut/document'
import { setup, types } from 'xstate'

/** Where the character is put down, in world units. */
export interface PlayContext {
  readonly start: readonly [number, number, number]
}

function startPosition(reader: DocumentReader): readonly [number, number, number] {
  const { doc } = reader
  return levelCentre(doc)
}

export function playLogic(reader: DocumentReader) {
  return setup({ schemas: { context: types<PlayContext>() } }).createMachine({
    id: 'play',
    // A factory, so the document is read when the session starts rather than
    // when the logic is built — the logic is built once, at `createHost`.
    context: () => ({ start: startPosition(reader) }),
    initial: 'running',
    states: { running: {} },
  })
}

export type PlayLogic = ReturnType<typeof playLogic>
