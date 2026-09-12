/**
 * The host: the root actor and the single dispatch entry point (#8, #11).
 *
 * Bubble-down from one root. A keybinding, a menu item and a test all call
 * `dispatch(id, args)` and nothing else; the host looks the id up in the
 * registry, evaluates its availability against context keys derived from the
 * live actor snapshots, validates the arguments, and routes the command to
 * the actor of the OWNER that declared it — by `ActorRef`, never by string
 * id, which on v6 is unrepresentable rather than forbidden (#15: `enq.sendTo`
 * takes a ref or `undefined`). Every outcome is a return value; nothing here
 * throws on an ordinary user action.
 *
 * The host owns `mode` as its top-level state — `edit` or `play` (#11) — and
 * the lifetimes of its children: the document actor (the one holder of the
 * write path, #13), the long-lived `tools` and `view` actors, and one actor
 * per installed feature. Children are held in context as refs, and a STALE
 * REF IS RETAINED, NEVER NULLED: a send to a stopped ref dead-letters with
 * `reason: 'stopped'` and the router stays `active`, while a send to
 * `undefined` is a silent no-op (#15, measured on alpha.53). Retaining is
 * what makes "declared but nobody is listening" observable as an `unhandled`
 * result instead of vanishing.
 *
 * Three constraints from the map shape the code and are easy to undo by
 * accident:
 *
 * 1. THE STORE ARRIVES BY FACTORY CLOSURE, NEVER BY `input`. `hostLogic`
 *    closes over it; the machine's context holds refs and nothing else, so
 *    nothing the size of a document can reach an inspector (#4).
 * 2. EVERY EFFECT GOES THROUGH `enq`. A v6 transition body re-runs from the
 *    top the moment it touches `enq` (#2), so the routing bodies below are
 *    pure apart from `enq.sendTo` / `enq.stop`, and the dead-letter count the
 *    dispatcher reads is taken outside the machine, after `send` returns.
 * 3. TEARDOWN IS NEVER IN `exit`: exit actions do not run when an actor is
 *    stopped (xstate#4630). `dispose(owner)` orders it explicitly — revoke
 *    declarations, send `dispose`, stop the ref (#21 §5) — and `stop()` is a
 *    method, not a state.
 *
 * Context keys are derived on EVERY dispatch, never held (#8's finding 2:
 * a frozen snapshot left `play.stop` permanently unavailable). The cost is a
 * handful of `getSnapshot` calls per dispatch; a palette rendering every
 * frame would memoise on the revision counter plus the host snapshot instead.
 */

import {
  DOCUMENT_OWNER,
  createDocumentActorLogic,
  documentKeys,
  type DocumentActorLogic,
  type DocumentReader,
  type EditorStore,
} from '@map-editor/document'
import {
  commands,
  dispose as disposeDeclarations,
  defineContextKey,
  reserveOwner,
  resolveCommand,
  type ContextSnapshot,
  type DispatchResult,
  type OwnerId,
} from '@map-editor/registry'
import {
  createActor,
  setup,
  types,
  type Actor,
  type ActorOptions,
  type ActorRefFrom,
  type AnyActorLogic,
  type AnyActorRef,
  type AnyEventObject,
  type InspectionEvent,
} from 'xstate'

import { TOOLS_OWNER, toolKeys, toolsLogic, type ToolsLogic } from './tools'
import { VIEW_OWNER, viewKeys, viewLogic, type ViewLogic } from './view'

export const HOST_OWNER = reserveOwner('editor-host')

export type Mode = 'edit' | 'play'

export const hostKeys = {
  mode: defineContextKey<Mode>('host.mode', 'edit'),
}

commands.declare(HOST_OWNER, { id: 'mode.play', title: 'Enter Play Mode', category: 'Mode', when: hostKeys.mode.is('edit') })
commands.declare(HOST_OWNER, { id: 'mode.edit', title: 'Leave Play Mode', category: 'Mode', when: hostKeys.mode.is('play') })

/**
 * A feature module as the host sees it (#9, #35): the owner id its
 * declarations were registered under and the logic it exports. The host
 * spawns the logic under that id and routes the owner's commands to it; it
 * never imports the feature — an app hands these in.
 */
export interface Feature {
  readonly owner: OwnerId
  readonly logic: AnyActorLogic
}

/** A command on its way down: the routed form of `CommandEvent`, carrying the owner the registry resolved. */
interface RoutedCommand {
  readonly owner: OwnerId
  readonly id: string
  readonly args: unknown
}

interface HostContext {
  /**
   * `AnyActorRef`, not a union of the child logics — #8's accepted cost. A
   * heterogeneous map keyed by a runtime string cannot keep per-child
   * snapshot types; routing needs none, and the typed accessors on `Host`
   * are the helper readers get instead.
   */
  readonly children: Readonly<Record<OwnerId, AnyActorRef>>
}

/** An undelivered event, as the dispatcher saw it. `target` is the actor id the ref pointed at. */
export interface DeadLetter {
  readonly reason: string
  readonly target: string
  readonly event: AnyEventObject
}

/**
 * What v6 exposes for time: `{ now?, setTimeout, clearTimeout }`, the shape
 * `createActor` takes as `clock` and `SimulatedClock` implements. The
 * interface itself is not re-exported from `xstate`'s index on alpha.53, so
 * it is named here off the option that carries it.
 */
export type Clock = NonNullable<ActorOptions<AnyActorLogic>['clock']>

export interface HostOptions {
  readonly store: EditorStore
  /** Time is injected (#10). Absent means xstate's real clock. */
  readonly clock?: Clock
  readonly features?: readonly Feature[]
}

function hostLogic(store: EditorStore, features: readonly Feature[]) {
  const documentLogic = createDocumentActorLogic(store)

  return setup({
    schemas: {
      context: types<HostContext>(),
      events: {
        command: types<RoutedCommand>(),
        dispose: types<{ owner: OwnerId }>(),
      },
    },
  }).createMachine({
    id: 'host',
    // Spawned from the logic values, not from string source keys: on
    // alpha.53 `spawn('key')` inside the initial-context factory reaches a
    // logic with no `initialTransition` and the child starts in `error`.
    context: ({ spawn }) => ({
      children: {
        [DOCUMENT_OWNER]: spawn(documentLogic, { id: 'document' }),
        [TOOLS_OWNER]: spawn(toolsLogic, { id: 'tools' }),
        [VIEW_OWNER]: spawn(viewLogic, { id: 'view' }),
        ...Object.fromEntries(features.map((feature) => [feature.owner, spawn(feature.logic, { id: feature.owner })])),
      },
    }),
    initial: 'edit',
    states: {
      edit: {
        on: {
          command: ({ context, event }, enq) => {
            if (event.owner === HOST_OWNER) return event.id === 'mode.play' ? { target: 'play' } : undefined
            enq.sendTo(context.children[event.owner], { type: 'command', id: event.id, args: event.args })
            return {}
          },
          dispose: ({ context, event }, enq) => {
            const ref = context.children[event.owner]
            enq.sendTo(ref, { type: 'dispose' })
            enq.stop(ref)
            return {}
          },
        },
      },
      play: {
        on: {
          command: ({ context, event }, enq) => {
            if (event.owner === HOST_OWNER) return event.id === 'mode.edit' ? { target: 'edit' } : undefined
            enq.sendTo(context.children[event.owner], { type: 'command', id: event.id, args: event.args })
            return {}
          },
          dispose: ({ context, event }, enq) => {
            const ref = context.children[event.owner]
            enq.sendTo(ref, { type: 'dispose' })
            enq.stop(ref)
            return {}
          },
        },
      },
    },
  })
}

export type HostLogic = ReturnType<typeof hostLogic>
export type HostActor = Actor<HostLogic>

export interface HostChildren {
  readonly document: ActorRefFrom<DocumentActorLogic>
  readonly tools: ActorRefFrom<ToolsLogic>
  readonly view: ActorRefFrom<ViewLogic>
}

export interface Host {
  readonly actor: HostActor
  /** The document's read path (#13): what a panel selects from and what a test asserts through. */
  readonly reader: DocumentReader
  readonly children: HostChildren
  /** Every undelivered event since the host started, oldest first. */
  readonly deadLetters: readonly DeadLetter[]
  /** THE SINGLE ENTRY POINT. Plain serialisable arguments; never throws. */
  dispatch(id: string, args?: unknown): DispatchResult
  /** The live availability vocabulary, derived now — what a palette evaluates every declaration against. */
  contextKeys(): ContextSnapshot
  /** The ref an owner's commands route to, stopped or not; `undefined` if that owner was never installed. */
  child(owner: OwnerId): AnyActorRef | undefined
  /**
   * Tear a feature down (#21 §5): revoke its declarations, then send its
   * actor `dispose`, then stop it — in that order, so nothing reaches a
   * half-disposed feature through the registry. The ref stays in context.
   * Throws for a reserved owner, as the registry does.
   */
  dispose(owner: OwnerId): void
  /** Stop the root and every child. Not `exit`: it would not run. */
  stop(): void
}

export function createHost({ store, clock, features = [] }: HostOptions): Host {
  const deadLetters: DeadLetter[] = []

  const inspect = (event: InspectionEvent): void => {
    if (event.type !== '@xstate.deadletter') return
    // `actorRef` is typed as the location-transparent `ActorRefLike`, which
    // carries only a session id; the co-located actor behind it has the
    // human-readable `id` the ref was spawned under, which is what a log
    // line wants. Fall back to the session id for a remote handle.
    const target = 'id' in event.actorRef && typeof event.actorRef.id === 'string' ? event.actorRef.id : (event.actorRef.sessionId ?? '<unstarted>')
    deadLetters.push({ reason: event.reason, target, event: event.event })
  }

  const actor = createActor(hostLogic(store, features), clock ? { clock, inspect } : { inspect })
  actor.start()

  const { reader } = store
  const initial = actor.getSnapshot().context.children
  const children: HostChildren = {
    document: initial[DOCUMENT_OWNER] as ActorRefFrom<DocumentActorLogic>,
    tools: initial[TOOLS_OWNER] as ActorRefFrom<ToolsLogic>,
    view: initial[VIEW_OWNER] as ActorRefFrom<ViewLogic>,
  }

  function contextKeys(): ContextSnapshot {
    const tools = children.tools.getSnapshot()
    const view = children.view.getSnapshot()
    return {
      [hostKeys.mode.id]: actor.getSnapshot().value,
      [toolKeys.tool.id]: tools.context.tool,
      [toolKeys.terrainMode.id]: tools.value,
      [viewKeys.hasSelection.id]: view.context.selectedObjectId !== null,
      [documentKeys.canUndo.id]: reader.canUndo(),
      [documentKeys.canRedo.id]: reader.canRedo(),
    }
  }

  function child(owner: OwnerId): AnyActorRef | undefined {
    return actor.getSnapshot().context.children[owner]
  }

  function dispatch(id: string, args?: unknown): DispatchResult {
    const resolution = resolveCommand(id, args, contextKeys())
    if (!resolution.ok) return resolution
    // Resolved, so declared, so owned.
    const owner = commands.ownerOf(id) as OwnerId
    // A feature whose logic was never installed has no ref at all, and
    // `enq.sendTo(undefined, …)` would be silent — the one shape retaining
    // stale refs cannot make observable, so it is answered before the send.
    if (owner !== HOST_OWNER && child(owner) === undefined)
      return { ok: false, kind: 'unhandled', reason: `"${id}" is declared by "${owner}", whose actor was never started` }
    const before = deadLetters.length
    actor.send({ type: 'command', owner, id, args: resolution.args })
    if (deadLetters.length > before)
      return { ok: false, kind: 'unhandled', reason: `"${id}" is declared by "${owner}", whose actor has stopped (${deadLetters[before].reason})` }
    return { ok: true }
  }

  function dispose(owner: OwnerId): void {
    disposeDeclarations(owner)
    if (child(owner) !== undefined) actor.send({ type: 'dispose', owner })
  }

  return {
    actor,
    reader,
    children,
    deadLetters,
    dispatch,
    contextKeys,
    child,
    dispose,
    stop: () => void actor.stop(),
  }
}
