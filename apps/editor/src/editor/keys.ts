/**
 * The keyboard dispatcher: the editor's ONE `keydown` listener (#14, #66 step 6).
 *
 * There were two, on `window`, in two packages — `App.tsx`'s switch over
 * `event.key` and `viewport.ts`'s held-key set — and neither knew about the
 * other. #14 names that as the reason the Option+drag orbit binding was
 * unreachable on a trackpad: nothing declared what was bound, so nothing
 * could notice. This file is what is left of both. It resolves a chord
 * through the keymap and hands the answer to `Host.dispatch`; it knows no
 * command ids and no key names of its own.
 *
 * It lives in the app rather than in `editor-host` because it is the one
 * piece that needs a window, and `editor-host` compiles without `DOM` on
 * purpose — its tsconfig says so. The bindings themselves are declarations
 * and stay there.
 *
 * Two behaviours are preserved exactly, and both are easy to lose:
 *
 * 1. HELD KEYS ARE FORWARDED UNCONDITIONALLY, including while a text field
 *    has focus, because that is what the viewport's listener did and WASD in
 *    play mode reads that set every frame. Only the CHORD half is suppressed
 *    over an input, which is what `App.tsx`'s listener did.
 * 2. `preventDefault` follows the resolver, not a hardcoded list. A key the
 *    keymap consumed is a key the browser must not also act on — Ctrl+Z's
 *    native undo, Tab's focus move — and a key that fell through (rule 2 of
 *    the resolver: an unavailable binding never swallows) reaches the page
 *    untouched, which is the whole point of falling through.
 */

import type { Host } from '@papercut/editor-host'
import { chordFromEvent, createChordSession, keymap, type Platform } from '@papercut/registry'

/**
 * The slice of `window` this needs. Narrow on purpose: a test drives the
 * dispatcher by handing it a target it wrote itself, with no DOM anywhere.
 */
export interface KeyTarget {
  addEventListener(type: 'keydown' | 'keyup', listener: (event: KeyboardEvent) => void): void
  removeEventListener(type: 'keydown' | 'keyup', listener: (event: KeyboardEvent) => void): void
}

export interface KeyDispatcherOptions {
  readonly target?: KeyTarget
  /** Absent means detected from the user agent; a test passes one so `mod` is not a property of the machine running it. */
  readonly platform?: Platform
}

const TEXT_ENTRY = ['INPUT', 'TEXTAREA', 'SELECT']

export function detectPlatform(): Platform {
  return typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.userAgent) ? 'mac' : 'other'
}

/**
 * `dispatch` never throws (#8) — it answers with a result — so a refusal has
 * to be looked at or it is swallowed. A refusal here means a DECLARED binding
 * named something that could not run, which is a bug in the keymap rather
 * than anything the user did: the resolver already checked availability, so
 * what is left is a bad argument or an actor that is not there.
 */
function report(id: string, result: ReturnType<Host['dispatch']>): void {
  if (result.ok) return
  const why =
    result.kind === 'invalid-args'
      ? result.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      : result.reason
  console.warn(`[editor] keybinding for ${id} refused: ${result.kind} — ${why}`)
}

/** Install the dispatcher. Returns the remover; call it on unmount. */
export function installKeyDispatcher(host: Host, options: KeyDispatcherOptions = {}): () => void {
  const target = options.target ?? window
  const platform = options.platform ?? detectPlatform()
  // The context is read per keypress rather than captured: `contextKeys()`
  // derives from the live actor snapshots, and a held copy is what left
  // `play.stop` permanently unavailable in #8's prototype.
  const session = createChordSession(() => ({ bindings: keymap.all(), snapshot: host.contextKeys(), platform }))

  const onKeyDown = (event: KeyboardEvent): void => {
    const chord = chordFromEvent(event)
    // Not a keypress but a state: the gesture actor holds the set, and what
    // alt means during a drag is its decision, not the keymap's (#14).
    host.input.keyDown(chord.key)

    const element = event.target as HTMLElement | null
    if (element && TEXT_ENTRY.includes(element.tagName)) return

    const resolution = session.press(chord)
    if (resolution.kind === 'none') return
    event.preventDefault()
    if (resolution.kind === 'dispatch') report(resolution.command, host.dispatch(resolution.command, resolution.args))
  }

  const onKeyUp = (event: KeyboardEvent): void => {
    host.input.keyUp(chordFromEvent(event).key)
  }

  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('keyup', onKeyUp)
  return () => {
    target.removeEventListener('keydown', onKeyDown)
    target.removeEventListener('keyup', onKeyUp)
  }
}
