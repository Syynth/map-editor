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

export interface PanelDecl<TComponent = unknown> {
  readonly id: string
  readonly title: string
  /** Whether the panel is shown. Absent means always. */
  readonly when?: Predicate
  readonly component: TComponent
}

export const panels = createRegistry<PanelDecl>('panel')
