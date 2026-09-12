/**
 * The geometry package's public surface.
 *
 * Turning a document into vertex buffers, plus the sheet layout that says what
 * a position on a tile sheet means. The two travel together because the mesher
 * is the layout's largest consumer — it asks for a tile id and a UV rectangle
 * per quad — and nothing else in the graph needs one without the other.
 *
 * Written out rather than `export *` for the same reason as `document`'s
 * barrel: the meshing worker that issue #3 draws this boundary for will want a
 * narrower surface than the editor does, and narrowing it should be one visible
 * edit here rather than a wildcard quietly changing shape.
 */

export {
  BLOCK_COLUMNS,
  BLOCK_ROWS,
  CLIFF_BOTTOM,
  CLIFF_MIDDLE,
  CLIFF_ROW,
  CLIFF_TOP,
  RAMP_COLUMN,
  cliffTile,
  defaultTopTile,
  rampTile,
  sheetLayoutFor,
  tileColumnRow,
  tileId,
  tileUv,
} from './template'
export type { CliffBand, SheetLayout } from './template'

export { meshTerrainChunk } from './terrain'
export type { MeshBuffers, TerrainChunkMesh } from './terrain'

export { meshSketch, outlineOf, triangulate } from './sketch'
export type { CapMaterialSpec, EdgeRepeat, EdgeSpec, LipStyle, Outline, Profile, ProfilePoint, SketchMesh, SketchMeshOptions, WallMaterialSpec, WallProfile } from './sketch'
