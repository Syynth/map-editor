/**
 * Keymap declarations (#14, #5).
 *
 * A binding binds a chord to `(command id, args)` — never to a function, in
 * every editor surveyed (#5) — so the same tuple is a keymap entry, a menu
 * item's payload and a test's invocation. Unlike the other registries this is
 * an ordered LIST, not a map keyed by id: two bindings may carry the same
 * command with different arguments, and nothing about a binding is unique
 * (VS Code: "rules are a flat list"). Order matters because #14's resolver
 * scans it in reverse, user bindings last, and a binding whose `when` is false
 * falls through to the next rather than swallowing the key.
 *
 * Only the declarations live here in this step; the resolver, the chord
 * grammar and unbind-versus-shadow are #14's, built with the keymap step.
 */

import type { Predicate } from './context'
import { onDispose, type OwnerId } from './owners'

export interface KeyBinding {
  /** The chord, as the resolver will parse it — e.g. `'ctrl+z'`. Unparsed here. */
  readonly chord: string
  readonly command: string
  /** Plain serialisable data, validated against the command's schema at dispatch. */
  readonly args?: unknown
  /** Scope: where the binding is active. ANDed with the command's own `when` by the resolver (#3 handoff to #14). */
  readonly when?: Predicate
}

interface Entry {
  readonly owner: OwnerId
  readonly binding: KeyBinding
}

const entries: Entry[] = []

export const keymap = {
  declare(owner: OwnerId, binding: KeyBinding): void {
    const entry: Entry = { owner, binding }
    entries.push(entry)
    onDispose(owner, () => {
      const at = entries.indexOf(entry)
      if (at !== -1) entries.splice(at, 1)
    })
  },
  /** Every live binding, in declaration order. */
  all(): readonly KeyBinding[] {
    return entries.map((entry) => entry.binding)
  },
}
