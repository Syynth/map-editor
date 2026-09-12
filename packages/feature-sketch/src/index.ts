/**
 * The Sketch feature: the tool that draws a closed outline on a structure
 * and extrudes it (ruling of 2026-09-12, "Sketch workflow"). Its
 * declarations run at import under an owner it mints itself; the module
 * value is what an app hands the host.
 */

import type { Patch } from '@map-editor/document'
import { defineFeature, provideFeature, tools, type FeatureInstance, type HotHandle } from '@map-editor/registry'

import { declareSketchCommands } from './commands'
import type { FeatureDeps } from './deps'
import { defineSketchKeys, sketchKeys } from './keys'
import { sketchLogic, type SketchLogic } from './logic'
import { SKETCH_DEFAULTS } from './params'
import { declareSketchPanels } from './panels'
import { sketchContract, type SketchSample } from './stroke'

const hot = (import.meta as ImportMeta & { readonly hot?: HotHandle }).hot

export const SKETCH = defineFeature('sketch', hot)

defineSketchKeys(SKETCH)
declareSketchCommands(SKETCH)
declareSketchPanels(SKETCH)
tools.declare(SKETCH, { id: 'sketch', title: 'Sketch', icon: 'sketch' })

export const sketchFeature = provideFeature({
  owner: SKETCH,
  params: SKETCH_DEFAULTS,
  create(deps: FeatureDeps): FeatureInstance<SketchLogic, SketchSample, Patch> {
    return {
      logic: sketchLogic(deps),
      tools: { sketch: sketchContract(deps) },
      keys: () => ({ [sketchKeys.mode.id]: deps.params().sketchMode, [sketchKeys.drawing.id]: deps.params().drawing !== null }),
    }
  },
})

export { currentSketch } from './panels'
export type { SketchPanelProps } from './panels'
export type { SketchParams } from './params'
export { sketchPointHeight } from './stroke'
