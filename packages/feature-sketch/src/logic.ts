/**
 * The feature's actor: its commands, each an event at the tools actor or a
 * labelled edit at the document, never a write of its own.
 */

import { closeSketch, removeStructure, structureOf } from '@papercut/document'
import { setup, types } from 'xstate'

import type { SketchParamsChange } from './commands'
import type { FeatureDeps } from './deps'

export function sketchLogic(deps: FeatureDeps) {
  return setup({
    schemas: {
      events: {
        command: types<{ id: string; args: unknown }>(),
        dispose: types<void>(),
      },
    },
  }).createMachine({
    id: 'sketch',
    initial: 'ready',
    states: {
      ready: {
        on: {
          command: ({ event }, enq) => {
            if (event.id === 'sketch.params') {
              enq(() => deps.setParams(event.args as SketchParamsChange))
              return {}
            }
            const drawing = deps.params().drawing
            if (event.id === 'sketch.finish') {
              // An outline with three points closes; fewer is not an outline and goes away.
              if (drawing === null) return undefined
              const doc = deps.doc()
              const sketch = structureOf(doc, drawing, 'sketch')
              const patches = sketch && sketch.points.length >= 3 ? closeSketch(doc, drawing) : removeStructure(doc, drawing)
              enq(() => {
                if (patches.length > 0) deps.apply(sketch && sketch.points.length >= 3 ? 'Close sketch' : 'Discard sketch', patches)
                deps.setParams({ drawing: null })
              })
              return {}
            }
            if (event.id === 'sketch.cancel') {
              if (drawing === null) return undefined
              const patches = removeStructure(deps.doc(), drawing)
              enq(() => {
                if (patches.length > 0) deps.apply('Discard sketch', patches)
                deps.setParams({ drawing: null })
                deps.select(null)
              })
              return {}
            }
            return undefined
          },
          dispose: () => ({}),
        },
      },
    },
  })
}

export type SketchLogic = ReturnType<typeof sketchLogic>
