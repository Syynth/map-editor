/**
 * The document package's public surface. Everything here is either data, a
 * pure function over data, or the actor that owns the one write path.
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
  createVoxel,
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
  DeepReadonly,
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
  ReadonlyMapDoc,
  TerrainData,
} from './document'
export { ancestorsOf, childrenOf, descendantsOf, outlineOf, pointInOutline, rootVoxel, structureOf } from './structure'
export type {
  LipStyle,
  Outline,
  Placement,
  Profile,
  ProfilePoint,
  QuarterTurn,
  ReadonlySketch,
  ReadonlyStructure,
  ReadonlyStructureTree,
  ReadonlyVoxel,
  SketchStructure,
  Structure,
  StructureBase,
  StructureKind,
  StructureTree,
  VoxelStructure,
  WallProfile,
  WallProfilePoint,
} from './structure'
export type { RgbaImage, SpriteAsset } from './image'
export {
  DEFAULT_WALL_PROFILE,
  MAX_HEIGHT,
  MIN_HEIGHT,
  addObject,
  addSketchPoint,
  addStructure,
  brushCells,
  closeSketch,
  createSketch,
  deleteSketchPoint,
  fillCells,
  flatten,
  groundedPosition,
  heightToWorld,
  paintCliff,
  paintTint,
  paintTop,
  placeStructure,
  raise,
  rectCells,
  regroundObjects,
  removeObject,
  removeStructure,
  renameStructure,
  reparentStructure,
  setMaterial,
  setRamp,
  setSketch,
  setWater,
  updateObject,
  updateSketchPoint,
} from './ops'
export type { Brush, BrushShape, Cell, SketchChanges } from './ops'
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
export type { DocumentReader } from './store'
export { inversePatch, patchAddress } from './edits'
export type { Patch, SketchField, SketchPatch, StrokeRecord, StructureMetaPatch } from './edits'
export { createDocument } from './actor'
export type { DocumentActorLogic, DocumentEvent, DocumentSource } from './actor'
export { DOCUMENT_OWNER, documentKeys } from './commands'
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
  frameOf,
  groundHeight,
  toLocal,
  toWorld,
  voxelTop,
} from './terrain'
export type { Frame } from './terrain'
export { MASK_EAST, MASK_NORTH, MASK_SOUTH, MASK_WEST, autotileMask } from './autotile'
export { CHUNK_SIZE, allChunkKeys, chunkBounds, chunkKey, parseChunkKey } from './chunks'
export type { ChunkBounds } from './chunks'
