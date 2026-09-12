/**
 * The document package's public surface.
 *
 * Everything the map data and its verbs export today is republished here,
 * deliberately: the cut is *above* the verbs (issue #3), so `ops.ts` producing
 * `Patch`es that `store.ts` applies is one unit, and a consumer that can reach
 * `raise` but not `applyPatches` could not undo what it did.
 *
 * The list is written out rather than `export *` because narrowing it is a real
 * decision this package will have to make once the document actor lands — at
 * which point `EditorStore`'s write handle stops being public and the deletion
 * has to be visible in one file rather than implied by a wildcard.
 */

export {
  ATMOSPHERE_PRESETS,
  DEFAULT_MATERIALS,
  DIR_NAMES,
  DIR_VECTORS,
  DISPLAY_MODES,
  FORMAT_VERSION,
  HALF,
  NO_RAMP,
  NO_WATER,
  PRESET_REFERENCE_SPAN,
  cellIndex,
  createMap,
  defaultCameraRig,
  defaultFacing,
  heightAt,
  inBounds,
  makeAtmosphere,
  materialAt,
  newId,
  worldHeight,
} from './document'
export type {
  Atmosphere,
  BackdropCard,
  BackSide,
  CameraBounds,
  CameraRig,
  Direction,
  DisplayMode,
  FacingConfig,
  FacingTransition,
  Hinge,
  MapDoc,
  MapObject,
  MapSize,
  MaterialDef,
  PaintLayers,
  TerrainData,
} from './document'

export type { RgbaImage, SpriteAsset } from './image'

export { History, applyPatches, pruneNoops } from './edits'
export type { DocField, Edit, PaintLayer, Patch, TerrainField } from './edits'

export {
  MAX_HEIGHT,
  MIN_HEIGHT,
  addObject,
  brushCells,
  fillCells,
  flatten,
  groundedPosition,
  heightToWorld,
  paintCliff,
  paintTint,
  paintTop,
  raise,
  rectCells,
  regroundObjects,
  removeObject,
  setMaterial,
  setRamp,
  setWater,
  updateObject,
} from './ops'
export type { Brush, BrushShape, Cell } from './ops'

export {
  cliffKey,
  cliffPaint,
  countDormant,
  parseCliffKey,
  tintKey,
  tintPaint,
  topKey,
  topPaint,
} from './paint'

export { EditorStore } from './store'

export { LoadError, deserialize, serialize } from './io'

export {
  SURFACE_CLIFF,
  SURFACE_TOP,
  SURFACE_WATER,
  decodeExtra,
  describeSurface,
  encodeExtra,
  readAddress,
  sameSurface,
} from './surface'
export type { SurfaceAddress, SurfaceKind } from './surface'

export {
  CORNER_OFFSETS,
  RAMP_DROP,
  RAMP_LOW_CORNERS,
  cellCentreWorld,
  cornerHeights,
  groundHeight,
} from './terrain'

export { MASK_EAST, MASK_NORTH, MASK_SOUTH, MASK_WEST, autotileMask } from './autotile'

export { CHUNK_SIZE, allChunkKeys, chunkBounds, chunkKey, parseChunkKey } from './chunks'
export type { ChunkBounds } from './chunks'
