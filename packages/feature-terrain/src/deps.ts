/**
 * The registry's generic seams, with this feature's own types filled in.
 *
 * `registry` is rung 0 and cannot name a document or a patch, so `FeatureDeps`
 * and the tool contract are generic and every consumer binds them. Binding
 * them once, here, is what keeps the rest of the package reading as ordinary
 * terrain code — and it is also where #35 is visible: the types come from
 * `document` and `registry`, never from the host that supplies the values.
 */

import type { Patch, ReadonlyMapDoc } from '@map-editor/document'
import type { FeatureDeps as GenericFeatureDeps } from '@map-editor/registry'

import type { TerrainParams } from './verbs'

export type FeatureDeps = GenericFeatureDeps<ReadonlyMapDoc, Patch, TerrainParams>

export type { StrokeHandler, ToolContract } from '@map-editor/registry'
