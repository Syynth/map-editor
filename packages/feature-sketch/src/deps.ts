/**
 * What the feature is handed by the host, typed for this feature: the
 * document, its own parameter slice, the write path, and selection.
 */

import type { Patch, ReadonlyMapDoc } from '@papercut/document'
import type { FeatureDeps as GenericFeatureDeps } from '@papercut/registry'

import type { SketchParams } from './params'

export type FeatureDeps = GenericFeatureDeps<ReadonlyMapDoc, Patch, SketchParams>

export type { StrokeHandler, ToolContract } from '@papercut/registry'
