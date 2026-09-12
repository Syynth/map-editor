/**
 * The generic declaration registry: static module-level data, populated at
 * import, enumerable before any actor exists (#5, #9).
 *
 * This is the DECLARATION half of the two-registry split. The HANDLER half
 * rides on an actor a feature exports and the host spawns (#9; the host is
 * `editor-host`, the first feature is #66 step 5); the two are joined by the
 * declaration's string id and nothing else, which is what lets a palette or a
 * keybinding editor list every command while nothing is running.
 * Declared-but-unhandled is therefore a legal state, not an error.
 *
 * Generic over the declaration type so `panels` can store a component this
 * package never learns the type of (#3): the registry keeps an opaque value
 * and the host supplies the typing on the way out.
 */

import { onDispose, type OwnerId } from './owners'

export interface Declaration {
  readonly id: string
}

export interface DeclarationRegistry<T extends Declaration> {
  /**
   * Register a declaration under `owner`. Returns nothing: teardown is the
   * registry's job, not the caller's (#9's amendment).
   *
   * A duplicate id THROWS, whoever owns the other copy (#21 §3). VS Code
   * shadows instead, but shadowing exists so an extension can override a
   * built-in — third-party extensions are out of scope here — and it turns
   * owner-scoped teardown into a per-id stack, where disposing one owner has
   * to restore another's shadowed entry. An import-time throw fails at
   * startup rather than at first use, which is the cheaper place.
   */
  declare(owner: OwnerId, declaration: T): void
  get(id: string): T | undefined
  /** Every live declaration, in declaration order. */
  all(): readonly T[]
  /** The owner that declared `id` — what the host routes a command by, never an id prefix (#8). */
  ownerOf(id: string): OwnerId | undefined
}

interface Entry<T> {
  readonly owner: OwnerId
  readonly declaration: T
}

/**
 * `check` runs before anything is stored, so a rejected declaration leaves no
 * trace — the command registry uses it to refuse an async validator (#23).
 */
export function createRegistry<T extends Declaration>(kind: string, check?: (declaration: T) => void): DeclarationRegistry<T> {
  const entries = new Map<string, Entry<T>>()

  return {
    declare(owner, declaration) {
      const existing = entries.get(declaration.id)
      if (existing)
        throw new Error(`${kind} "${declaration.id}" is already declared by owner "${existing.owner}" (redeclared by "${owner}")`)
      check?.(declaration)
      const entry: Entry<T> = { owner, declaration }
      entries.set(declaration.id, entry)
      // Delete only if the slot still holds THIS entry: a reserved owner's
      // teardown never runs, but an ordinary owner's could race a re-declare
      // of the same id by a later owner, and must not take that one down.
      onDispose(owner, () => {
        if (entries.get(declaration.id) === entry) entries.delete(declaration.id)
      })
    },
    get: (id) => entries.get(id)?.declaration,
    all: () => [...entries.values()].map((entry) => entry.declaration),
    ownerOf: (id) => entries.get(id)?.owner,
  }
}
