/**
 * Tool declarations and the tool/stroke contract (#9, #11, #35).
 *
 * A feature sits BESIDE the host, and neither may import the other — only an
 * app composes them (#35). So the interfaces a feature implements and the host
 * runs have to live below both, here. The stroke FRAMEWORK (the actor spawned
 * per pointer-down that owns the compaction map, applies patches immediately
 * and commits one `Edit` on release — #11) is host code; what is here is only
 * the CONTRACT it runs against, kept structural and minimal so a feature
 * module is writable against nothing but this package.
 *
 * `feature-terrain` implements this for the `terrain` tool, and the host finds
 * it through `FeatureInstance.tools` (`feature.ts`) keyed by the tool's id —
 * the join a `ToolDecl` cannot carry, since a declaration is enumerable before
 * any actor and a contract cannot exist before the deps do. The host's stroke
 * actor runs what it finds there, so the terrain verbs have exactly one
 * implementation and it is the feature's.
 *
 * Nothing here imports XState. An actor-facing shape is written structurally
 * (`{ send(event): void }`) so the declaration half stays free of the actor
 * library, which is what makes the two-registry split real rather than
 * nominal.
 */

import type { Predicate } from './context'
import { createRegistry } from './registry'

export interface ToolDecl {
  readonly id: string
  readonly title: string
  /**
   * The name of the glyph the rail draws for it, from the design
   * vocabulary's icon set — a string rather than a component because this
   * package sits below React, and a name is as storable as the rest of the
   * declaration. Absent means the rail shows the title's initial.
   *
   * No key here: the chord that selects a tool is a keymap binding on
   * `tools.set`, and the rail's tooltip reads it from there, so a preset that
   * rebinds `V` changes what the tooltip says without touching the tool.
   */
  readonly icon?: string
  /** Whether the tool can be selected. Absent means always. */
  readonly when?: Predicate
}

export const tools = createRegistry<ToolDecl>('tool')

/**
 * The event the host will send an owner's actor for a command it routed
 * there. `args` are the schema-validated arguments, already checked by
 * `resolveCommand`, so a handler may trust their shape.
 */
export interface CommandEvent {
  readonly type: 'command'
  readonly id: string
  readonly args: unknown
}

/** An actor the host can route a command to, seen only by the one method routing needs. */
export interface CommandTarget {
  send(event: CommandEvent): void
}

/**
 * One stroke, pointer-down to pointer-up. A feature returns a fresh handler per
 * stroke from `ToolContract.stroke`, so whatever a stroke accumulates lives on
 * the handler and dies with it — not on the tool, and not in an actor's
 * context. Each phase returns the patches the host should apply NOW; the host
 * forwards them to the document actor, compacts them, and labels the single
 * undo entry with `label` on release. A cancelled stroke (its owner disposed
 * mid-drag, #21 §5) is rolled back by the host from what it applied; the
 * handler is not consulted, which is why there is no `cancel` here.
 *
 * `TSample` is whatever the host picks under the pointer and `TPatch` is what
 * the document takes; both are the caller's types, so this package learns
 * neither the viewport's pick shape nor the document's patch vocabulary.
 */
export interface StrokeHandler<TSample, TPatch> {
  readonly label: string
  begin(sample: TSample): readonly TPatch[]
  move(sample: TSample): readonly TPatch[]
  end(sample: TSample): readonly TPatch[]
}

export interface ToolContract<TSample, TPatch> {
  /**
   * Start a stroke at `sample`, or decline (`undefined`) when the tool has
   * nothing to do there — a pick that missed the terrain, say — in which case
   * the host spawns no stroke actor and the pointer-down falls through to
   * arbitration as a click or an orbit.
   */
  stroke(sample: TSample): StrokeHandler<TSample, TPatch> | undefined
}
