/**
 * The parameters the app's own panels read: the host's tool state with every
 * installed feature's slice spread over it. The app is the composition root
 * — it installs the terrain feature and knows its parameter shape — so it
 * is the one place this merged view may be typed.
 */
import type { ToolsSnapshot } from '@map-editor/editor-host'
import type { TerrainParams } from '@map-editor/feature-terrain'

export type EditorParams = ToolsSnapshot & TerrainParams

/** Spread every feature's slice over the host's fields; a later feature's key shadows an earlier one's, so features namespace their names. */
export function mergeParams(snapshot: ToolsSnapshot): EditorParams {
  return Object.assign({}, ...Object.values(snapshot.features), { tool: snapshot.tool, spriteName: snapshot.spriteName, features: snapshot.features }) as EditorParams
}
