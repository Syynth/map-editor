/**
 * Owners: who declared a thing, so `declare()` can own its teardown (#9, #21).
 *
 * #9's prototype leaked its Outliner's palette entry and panel on uninstall,
 * because nothing made the feature collect the disposables `declare` handed
 * back. The fix is that the registry never hands one back: every surface takes
 * an owner id as its first argument and registers its own teardown against it
 * here, and whoever installs features — the host, through `Host.dispose` —
 * disposes by owner. A feature module therefore never sees a disposable, and
 * a surface package (`viewport-contrib`'s overlays, say) can take part in the
 * same teardown without this package learning what it holds — it calls
 * `onDispose` with whatever release it needs.
 *
 * Built-in owners are RESERVED (#66, carrying #3's handoff into #21): a
 * package such as `document` declares its own commands and is never disposed,
 * so `dispose` refuses a reserved id outright rather than silently emptying
 * the registry under a running actor. Reservation is a set `dispose`
 * consults, not a capability — #21 preferred an unforgeable token, and the
 * id-based shape here is what #66 handed the build; a token can be layered
 * over an id later without changing any `declare` signature, since the id is
 * the only thing this module keys on.
 */

/** An owner's identity: a feature module's id or a reserved built-in id. */
export type OwnerId = string

type Teardown = () => void

const reserved = new Set<OwnerId>()
const teardowns = new Map<OwnerId, Teardown[]>()

/**
 * Mark an owner id as a built-in that must never be disposed. Called once at
 * module scope by the declaring package; a second reservation of the same id
 * throws, because two modules claiming one built-in identity is the same
 * silent-when-wrong failure the duplicate-declaration throw guards against.
 */
export function reserveOwner(id: OwnerId): OwnerId {
  if (reserved.has(id)) throw new Error(`owner "${id}" is already reserved`)
  reserved.add(id)
  return id
}

export function isReservedOwner(id: OwnerId): boolean {
  return reserved.has(id)
}

/**
 * Register a release to run when `owner` is disposed. This is the whole
 * mechanism a surface needs to participate in owner-scoped teardown; the
 * declaration registries use it, and so may any package that holds something
 * on an owner's behalf.
 */
export function onDispose(owner: OwnerId, teardown: Teardown): void {
  const list = teardowns.get(owner)
  if (list) list.push(teardown)
  else teardowns.set(owner, [teardown])
}

/**
 * Release everything registered against `owner`, most recent first, so a
 * later registration that depends on an earlier one is gone before the
 * earlier one is. Disposing an owner nothing was declared under is a no-op:
 * the host disposes on HMR and on a feature toggle, and a feature that
 * declared nothing is not an error there.
 *
 * Only revokes declarations and runs hooks. Sending `dispose` to the owner's
 * actor and stopping its ref is the host's half (#21 §5, `Host.dispose` in
 * `editor-host`), ordered AFTER this so nothing can reach a half-disposed
 * feature through the registry.
 */
export function dispose(owner: OwnerId): void {
  if (reserved.has(owner)) throw new Error(`owner "${owner}" is reserved and cannot be disposed`)
  const list = teardowns.get(owner)
  if (!list) return
  teardowns.delete(owner)
  for (let i = list.length - 1; i >= 0; i -= 1) list[i]()
}
