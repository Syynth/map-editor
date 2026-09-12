/**
 * The terrain feature's actor — the handler half the host routes commands to
 * (#9's two-registry split).
 *
 * Built by `create` from the deps the host supplies, so the document's read
 * path and its write door arrive BY FACTORY CLOSURE and never as `input` (#4):
 * `input` rides the `xstate.init` event and would put the whole document in
 * reach of an inspector.
 *
 * EVERY WRITE IS `enq(() => …)`, NEVER INLINE. On `6.0.0-alpha.53` a
 * transition body runs once with a stub `enq` and is replayed with the real
 * one if it touched it, so a statement above the first `enq` call runs twice
 * and an inline effect fires even on a path that returns `undefined` — the
 * "not enabled" shape. `terrainEdit` is pure, which is what makes it safe to
 * call before the `enq`; the apply is inside it. The document actor holds the
 * writer and this send is the only way this package reaches it (#13).
 *
 * An unknown id returns `undefined` rather than being dropped inside the
 * effect, so a command this owner never declared takes no transition at all.
 * It cannot happen through `dispatch` — the host routes by declaring owner —
 * but the actor is the one thing that would silently apply an empty edit.
 */

import { setup, types } from 'xstate'

import { terrainEdit, type TerrainParamsChange } from './commands'
import type { FeatureDeps } from './deps'

export function terrainLogic(deps: FeatureDeps) {
  return setup({
    schemas: {
      events: {
        command: types<{ id: string; args: unknown }>(),
        dispose: types<void>(),
      },
    },
  }).createMachine({
    id: 'terrain',
    initial: 'ready',
    states: {
      ready: {
        on: {
          command: ({ event }, enq) => {
            // The feature's parameters: set whole, or the brush nudged — each an event at the tools actor through `setParams`.
            if (event.id === 'terrain.params') {
              enq(() => deps.setParams(event.args as TerrainParamsChange))
              return {}
            }
            if (event.id === 'terrain.brush.resize') {
              const brush = deps.params().brush
              const size = Math.min(12, Math.max(1, brush.size + (event.args as { by: number }).by))
              if (size === brush.size) return undefined
              enq(() => deps.setParams({ brush: { ...brush, size } }))
              return {}
            }
            const edit = terrainEdit(deps.doc(), event.id, event.args)
            // An edit that touches nothing is refused rather than applied: the
            // document actor prunes an empty patch list anyway, and letting it
            // through would put an undoable "Toggle ramp" on the stack for a
            // ramp direction nobody chose.
            if (!edit || edit.patches.length === 0) return undefined
            enq(() => deps.apply(edit.label, edit.patches))
            return {}
          },
          // Nothing is in flight: a terrain command is applied within the
          // transition that received it, and a stroke's state lives on the
          // handler the stroke actor holds. #21 §5's drain has nothing to
          // drain here, which is the property that makes `enq.stop` safe.
          dispose: () => ({}),
        },
      },
    },
  })
}

export type TerrainLogic = ReturnType<typeof terrainLogic>
