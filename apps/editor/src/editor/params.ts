/**
 * The parameters the app's own panels read: the host's tool state with every
 * installed feature's slice spread over it. The app is the composition root
 * — it installs the terrain feature and knows its parameter shape — so it
 * is the one place this merged view may be typed.
 */
import type { ToolsSnapshot } from '@papercut/editor-host'
import type { SketchParams } from '@papercut/feature-sketch'
import type { TerrainParams } from '@papercut/feature-terrain'

export type EditorParams = ToolsSnapshot & TerrainParams & SketchParams

/**
 * Spread every feature's slice over the host's fields; a later feature's key
 * shadows an earlier one's, so features namespace their names. The host's
 * own fields go on last, all of them: a panel that reads one the merge
 * forgot sees `undefined` and shows nothing selected.
 */
export function mergeParams(snapshot: ToolsSnapshot): EditorParams {
  const { features, ...own } = snapshot
  return Object.assign({}, ...Object.values(features), own, { features }) as EditorParams
}
