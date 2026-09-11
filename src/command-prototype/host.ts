/**
 * PROTOTYPE — throwaway. See issue #8.
 *
 * The host: a root actor that spawns each feature's `logic` and routes every
 * command to exactly one of them. This is the single dispatch entry point the
 * charting decision chose bubble-down for.
 *
 * Three map constraints are load-bearing here:
 *
 * 1. Children are addressed by `ActorRef`. On v6 there is no string form of
 *    `enq.sendTo`, so the v5 dead-router footgun is unrepresentable.
 * 2. Teardown is explicit, never in `exit` — `exit` does not run when an actor
 *    is stopped (xstate#4630).
 * 3. The store reaches the terrain feature by factory closure, not `input`.
 */

import { setup, types, createActor, type AnyActorRef } from 'xstate'
import type { EditorStore } from '../core/store'
import { terrainLogic, toolsLogic, playLogic, TERRAIN, TOOLS, PLAY, HOST, type Invocation, type Reply } from './features'
import { lookup, evaluate, explain, validateArgs, type ContextKeys, type FeatureId } from './registry'

/** Why a dispatch did not reach a handler. All three are legal outcomes. */
export type DispatchResult =
  | { status: 'ok'; id: string }
  | { status: 'unknown'; id: string; why: string }
  | { status: 'unavailable'; id: string; why: string }
  | { status: 'invalid'; id: string; why: string }
  | { status: 'unhandled'; id: string; why: string }

export interface DeadLetter { id: string; feature: FeatureId; reason: string }

/**
 * Ambient facts the host cannot derive on its own. In the real editor these
 * would come from other features; here they are just supplied.
 */
export interface AmbientKeys {
  documentOpen: boolean
  hasSelection: boolean
}

export function createHost(store: EditorStore, ambient: AmbientKeys) {
  const terrain = terrainLogic(store)

  const hostMachine = setup({
    schemas: { events: { command: types<Invocation & { feature: FeatureId }>() } },
    actors: { terrain, tools: toolsLogic, play: playLogic },
  }).createMachine({
    id: 'host',
    /**
     * The child map is `AnyActorRef`, not a union of the three logics.
     *
     * This is a real cost, not laziness: a heterogeneous child map keyed by a
     * runtime string cannot keep per-feature snapshot types without a helper,
     * and #4 predicted exactly this ("expect actor-system typing to fight you
     * at scale"). Routing is by runtime string anyway, so precise per-child
     * types would buy nothing at the send site — but readers of
     * `features[id].getSnapshot()` lose their types, which is where the cost
     * actually lands.
     */
    context: ({ spawn }) => ({
      features: {
        [TERRAIN]: spawn(terrain, { id: 'terrain' }),
        [TOOLS]: spawn(toolsLogic, { id: 'tools' }),
      } as Record<FeatureId, AnyActorRef | undefined>,
      mode: 'edit' as 'edit' | 'play',
    }),
    initial: 'ready',
    states: {
      ready: {
        on: {
          command: ({ context, event }, enq) => {
            // --- host lifecycle: the router owns child lifetimes ---
            if (event.feature === HOST) {
              if (event.id === 'play.start') {
                const play = enq.spawn(playLogic, { id: `play:${Date.now()}` })
                return { context: { ...context, features: { ...context.features, [PLAY]: play }, mode: 'play' as const } }
              }
              if (event.id === 'play.stop') {
                // Explicit teardown BEFORE the stop — `exit` would not run.
                enq.stop(context.features[PLAY])
                // The stale ref is deliberately RETAINED rather than nulled:
                // `enq.sendTo(undefined, …)` is a silent no-op, but a send to a
                // stopped ref dead-letters. Keeping it is what makes "declared
                // but unhandled" observable instead of vanishing.
                return { context: { ...context, mode: 'edit' as const } }
              }
              return {}
            }

            // --- everything else bubbles down to the declaring feature ---
            // On v5 this is the line that kills the router when the child is
            // gone. On v6 it dead-letters and the router survives.
            enq.sendTo(context.features[event.feature], { type: 'command', id: event.id, args: event.args })
            return {}
          },
        },
      },
    },
  })

  const replies: Reply[] = []
  const deadLetters: DeadLetter[] = []

  const actor = createActor(hostMachine, {
    inspect: (ev) => {
      if (ev.type === '@xstate.deadletter') {
        const e = ev.event as { id?: string }
        deadLetters.push({ id: e.id ?? ev.event.type, feature: 'unknown', reason: ev.reason })
      }
    },
  })

  // Feature replies are emitted, so outcomes never enter anyone's context.
  for (const id of [TERRAIN, TOOLS]) {
    const ref = actor.getSnapshot().context.features[id]
    ref?.on('reply', (r: unknown) => replies.push(r as Reply))
  }

  actor.start()

  /**
   * Context keys are DERIVED on every dispatch, never held.
   *
   * The first version of this prototype passed a frozen `ContextKeys` in at
   * construction, and `play.stop` — gated on `mode: 'play'` — was permanently
   * unavailable because the snapshot still said `edit`. That is #4's "decide
   * where guards read from" arriving as a bug rather than a note: availability
   * reads live state or it is wrong.
   *
   * Recomputing per dispatch is affordable (#4 measured 0.184 ms for a
   * 200-command sweep). A palette rendering every frame would memoise on the
   * store's revision counter plus the host snapshot instead.
   */
  function currentKeys(): ContextKeys {
    const snap = actor.getSnapshot()
    const toolsRef = snap.context.features[TOOLS]
    return {
      documentOpen: ambient.documentOpen,
      hasSelection: ambient.hasSelection,
      mode: snap.context.mode,
      tool: ((toolsRef?.getSnapshot().context as { tool?: ContextKeys['tool'] } | undefined)?.tool) ?? 'select',
      canUndo: store.history.canUndo(),
      canRedo: store.history.canRedo(),
    }
  }

  /**
   * THE SINGLE ENTRY POINT. A keybinding, a menu item and a test all call this
   * and nothing else. Arguments are plain serialisable data.
   */
  function dispatch(id: string, args: Record<string, unknown> = {}): DispatchResult {
    const decl = lookup(id)
    if (!decl) return { status: 'unknown', id, why: 'no such command is declared' }

    const keys = currentKeys()
    if (!evaluate(decl.when, keys)) {
      return { status: 'unavailable', id, why: explain(decl.when, keys) ?? 'unavailable' }
    }

    const issues = validateArgs(decl.args, args)
    if (issues.length) {
      return { status: 'invalid', id, why: issues.map((i) => `${i.path}: ${i.message}`).join('; ') }
    }

    const before = deadLetters.length
    actor.send({ type: 'command', id, feature: decl.feature, args })

    if (deadLetters.length > before) {
      deadLetters[deadLetters.length - 1].feature = decl.feature
      return { status: 'unhandled', id, why: `${decl.feature} declared it but is not running` }
    }
    // A feature with no live actor at all: the ref was never spawned, so the
    // send was a silent no-op rather than a dead letter.
    if (!actor.getSnapshot().context.features[decl.feature] && decl.feature !== HOST) {
      return { status: 'unhandled', id, why: `${decl.feature} has never been started` }
    }
    return { status: 'ok', id }
  }

  return {
    dispatch,
    currentKeys,
    actor,
    replies,
    deadLetters,
    mode: () => actor.getSnapshot().context.mode,
    tool: () => {
      const ref = actor.getSnapshot().context.features[TOOLS]
      return (ref?.getSnapshot().context as { tool?: string } | undefined)?.tool
    },
    playFrame: () => {
      const ref = actor.getSnapshot().context.features[PLAY]
      return (ref?.getSnapshot().context as { frame?: number } | undefined)?.frame
    },
  }
}
