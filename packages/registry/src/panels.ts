/**
 * Panel declarations (#9, #12, #3).
 *
 * `panels.declare` takes a COMPONENT, not a descriptor (#12), which is why
 * `feature-*` may depend on `ui` and never on Mantine. But a component type is
 * React's, and this is the lowest package in the graph, so the registry is
 * generic over it (#3): it stores an opaque `component` and never learns what
 * a panel is. `ui` and the host narrow `TComponent` on the way out.
 */

import type { Predicate } from './context'
import { createRegistry } from './registry'

/**
 * Where a panel renders. The frame has two places a tool's controls go: the
 * context bar under the top bar, which shows the ACTIVE tool's mode switch,
 * verbs and parameters in one row, and the inspector on the right, a stack of
 * collapsible sections. A feature says which by slot; the frame decides what a
 * slot looks like.
 */
export type PanelSlot = 'bar' | 'inspector'

export interface PanelDecl<TComponent = unknown> {
  readonly id: string
  readonly title: string
  /** Whether the panel is shown. Absent means always. */
  readonly when?: Predicate
  /** Absent means `inspector`. */
  readonly slot?: PanelSlot
  readonly component: TComponent
}

export const panels = createRegistry<PanelDecl>('panel')
