/**
 * The document package's public surface.
 *
 * Narrowed with the document actor (#13, #34). The cut is still *above* the
 * verbs (#3) — an op like `raise` returns patches this package applies — but
 * the applying is now the actor's job, so the machinery it hides has left the
 * barrel: `History`, `applyPatches`, `pruneNoops`, `Edit` and the `Patch`
 * family (`Patch`, `DocField`, `TerrainField`, `PaintLayer`) are internal. A
 * consumer never imports `Patch`; it sends the actor whatever an op returned.
 *
 * `createDocumentStore` and `DocumentWriter` are not here either, and that is
 * the whole point: the write handle's only consumer is `actor.ts`, so the
 * package exposes a pre-wired `createDocumentActorLogic` and never a writer.
 * `EditorStore` stays exported for one reason — `App.tsx` constructs it and
 * writes through it directly until #66 step 7 rewires the app onto the host.
 * That is a documented, temporary second write path; the class leaves with it.
 *
 * The list is written out rather than `export *` (#34) so that a narrowing
 * is a visible edit in one file rather than implied by a wildcard.
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

export type { RgbaImage, SpriteAsset } from './image'

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
export type { DocumentReader } from './store'

export { createDocumentActorLogic } from './actor'
export type { DocumentActorLogic, DocumentEvent } from './actor'

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
  groundHeight,
} from './terrain'

export { MASK_EAST, MASK_NORTH, MASK_SOUTH, MASK_WEST, autotileMask } from './autotile'

export { CHUNK_SIZE, allChunkKeys, chunkBounds, chunkKey, parseChunkKey } from './chunks'
export type { ChunkBounds } from './chunks'
