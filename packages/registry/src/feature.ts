/**
 * What a feature module is, from below (#9, #21, #35).
 *
 * A feature sits BESIDE the host and neither imports the other, so everything
 * the two have to agree on lives here: the identity a `declare` call is made
 * against, the things the host hands a feature when it spawns it, and what the
 * feature hands back. An app is the only thing that sees both halves.
 *
 * Nothing here imports XState or React. The logic a feature builds is opaque
 * (`TLogic`), exactly as a panel's component is opaque to `panels` — the
 * registry keeps the value and the host supplies the typing on the way out.
 *
 * Two shapes are load-bearing and easy to undo by accident:
 *
 * 1. `create` IS A METHOD, on both sides. TypeScript compares a method's
 *    parameters bivariantly and a function-typed property's contravariantly,
 *    and this seam depends on the former: the host's deps name its own tool
 *    parameters (eleven fields), a feature's name the handful it actually
 *    reads, and the two only meet because `create(deps: …)` is written as a
 *    method. Rewriting it as `create: (deps: …) => …` makes every feature
 *    whose parameter type is narrower than the host's stop assigning.
 * 2. THE DEPS ARRIVE BY FACTORY CLOSURE, NEVER BY `input` (#4). `input` rides
 *    the `xstate.init` event and reaches an inspector even when it is kept out
 *    of context, and `doc()` alone would hand it the whole document. `create`
 *    is called at spawn time and the logic it returns closes over what it was
 *    given.
 */

import { dispose, type OwnerId } from './owners'
import type { ContextSnapshot } from './context'
import type { ToolContract } from './tools'

/**
 * Vite's `import.meta.hot`, typed structurally so this package keeps its
 * zero-runtime-dependency property (#21 §4). `import.meta.hot` is `undefined`
 * in a production build, which is why the argument is optional rather than the
 * call being conditional.
 */
export interface HotHandle {
  accept(): void
  dispose(callback: () => void): void
}

/**
 * What the host hands a feature at spawn: the document's read path, the one
 * write door (#13 — patches reach the document actor as events; nobody else
 * holds a writer), and the owner's tool parameters.
 *
 * Generic in all three because this is rung 0 of the ladder and may not name
 * the document's types. The host fills them in; a feature names the narrowest
 * shape it reads, and structural typing makes the two meet.
 */
export interface FeatureDeps<TDoc, TPatch, TParams> {
  /** The document, live. Read per call, never captured: it is mutated in place. */
  doc(): TDoc
  /** The tool parameters, live, for the same reason. */
  params(): TParams
  /** Write tool parameters back — what an eyedropper picks up. */
  setParams(changes: Partial<TParams>): void
  /** One labelled edit, applied and recorded by the document actor. */
  apply(label: string, patches: readonly TPatch[]): void
}

/**
 * What `create` answers with: the actor the host spawns under the owner, the
 * contract behind each tool the owner declared, and the owner's contribution
 * to the availability vocabulary.
 *
 * `tools` is the join #9's two-registry split left open: a `ToolDecl` says a
 * tool EXISTS and is enumerable before any actor, while the contract says what
 * a stroke with it DOES and cannot exist before the deps do. They are joined
 * by the tool's id and nothing else, the same way a command is joined to its
 * handler.
 *
 * `keys` is called per dispatch and never held (#8's finding 2: a snapshot
 * frozen at construction left a command permanently unavailable).
 */
export interface FeatureInstance<TLogic, TSample, TPatch> {
  readonly logic: TLogic
  readonly tools?: Readonly<Record<string, ToolContract<TSample, TPatch>>>
  keys?(): ContextSnapshot
}

/**
 * A feature module as everything outside it sees it: an owner and the factory
 * that builds its half. `TCreate` is left to the consumer for the same reason
 * `PanelDecl`'s component is — the registry stores it and never learns what it
 * is; the host names the concrete signature on the way out.
 */
export interface FeatureModule<TCreate = unknown> {
  readonly owner: OwnerId
  readonly create: TCreate
}

export interface FeatureChangeHooks<TCreate> {
  /** A feature arrived: spawn its logic under its owner. */
  install(module: FeatureModule<TCreate>): void
  /** A feature is going away: send its actor `dispose` and stop the ref (#21 §5). */
  uninstall(owner: OwnerId): void
}

/**
 * Every registered hook, with the module type erased. `unknown` rather than a
 * union: `install` is a method, so its parameter is compared bivariantly, and
 * a `FeatureChangeHooks<SomeCreate>` is therefore storable here without the
 * set learning what any feature's factory looks like.
 */
const hooks = new Set<FeatureChangeHooks<unknown>>()

/**
 * Mint a feature's identity, and wire the hot update that will replace it
 * (#21 §4). The `import.meta.hot` handle is a required-in-practice second
 * argument because Vite will not let anyone else do this: its disposer is
 * looked up by the path of the module that CHANGED, so a central
 * `features/index.ts` that accepted the update would never have its disposer
 * consulted, and the re-imported module's own `defineFeature` would throw on
 * the duplicate before anything had been revoked.
 *
 * The disposer runs before the new module is imported, so by the time the new
 * incarnation mints the same id the old one's declarations, keys and actor are
 * gone. The order is #21 §5's and is load-bearing: revoke first, so nothing
 * can reach a half-disposed feature through the registry while its actor is
 * still being drained.
 */
export function defineFeature(id: OwnerId, hot?: HotHandle): OwnerId {
  hot?.accept()
  hot?.dispose(() => {
    dispose(id)
    for (const hook of [...hooks]) hook.uninstall(id)
  })
  return id
}

/**
 * Publish the module, and tell whoever is listening. On first load nobody is:
 * the app imports its features and hands them to `createHost`, which is #9's
 * discovery story and stays explicit. On a hot re-import the host IS listening,
 * which is the whole reason this call exists rather than the module just
 * exporting an object (#21 §6): the re-imported module exports a NEW `create`
 * the host has never spawned, and nothing else would tell it so.
 */
export function provideFeature<T extends FeatureModule<unknown>>(module: T): T {
  for (const hook of [...hooks]) hook.install(module)
  return module
}

/**
 * Register the install hook, once, from the host. Returns a release, because
 * a host that has stopped must not be re-installed into.
 */
export function onFeatureChange<TCreate>(on: FeatureChangeHooks<TCreate>): () => void {
  hooks.add(on)
  return () => void hooks.delete(on)
}
