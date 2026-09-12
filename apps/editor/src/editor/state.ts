/**
 * Editor state — the things that are NOT part of the document.
 *
 * Which tool is active, how big the brush is and what is selected are
 * properties of the person editing, not of the map, so none of it is
 * serialized and none of it goes through the command system.
 *
 * The tool model here is deliberately concrete: a union of a few known tools
 * with their own verbs, not a plugin registry. The brief is explicit that the
 * shared framework should be extracted once three or four tools exist, and
 * right now there are three.
 *
 * What is left is the SHAPE the panels take, not a store: since #66 step 4
 * every field is owned by an actor in `editor-host` — eleven by `tools`, four
 * by `view`, and `playing` is the host's own mode — and `App` assembles this
 * object from their snapshots. The initial values went with them, which is
 * why there is no `initialEditorState` here any more.
 */

import type { Brush } from '@map-editor/document'

export type ToolId = 'terrain' | 'object' | 'camera'
export type TerrainMode = 'sculpt' | 'paint'
export type SculptVerb = 'raise' | 'flatten' | 'ramp' | 'water'
export type PaintVerb = 'tile' | 'material' | 'tint'
export type StrokeShape = 'brush' | 'rect' | 'fill'

export interface EditorState {
  tool: ToolId
  terrainMode: TerrainMode
  sculptVerb: SculptVerb
  paintVerb: PaintVerb
  strokeShape: StrokeShape
  brush: Brush
  /** Material whose automatic default the artist is assigning. */
  material: number
  /** Tile id selected from the sheet, for the tile brush. */
  tile: number
  tint: number
  rampDir: number
  spriteName: string
  selectedObjectId: string | null
  showGrid: boolean
  gameCamera: boolean
  playing: boolean
  /** Which right-hand panel is showing. */
  inspector: 'properties' | 'coverage' | 'atmosphere' | 'outliner'
}
