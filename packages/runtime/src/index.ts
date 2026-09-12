/**
 * The runtime package's public surface.
 *
 * The three.js reference runtime: the scene the editor previews and play mode
 * drives, plus the camera rig, the billboard/flip machinery, the sky, picking
 * and the coverage analysis. Creating a `WebGLRenderer` is not in here — issue
 * #3 measured that and the export CLI depends on it staying true.
 *
 * glTF export is deliberately NOT re-exported: it is `@map-editor/runtime/export`,
 * so a consumer that only previews a map does not pull `GLTFExporter` in with
 * the scene. That subpath is the package's second entry point and the only one.
 *
 * Written out rather than `export *`, matching `document` and `geometry`: when
 * `textures.ts` leaves for `packages/fixtures` the three symbols that go with
 * it should disappear from one visible list.
 */

export { ObjectView, canvasTexture, pickFacing, resolveDisplayMode } from './billboard'
export type { ObjectViewContext } from './billboard'

export {
  applyRig,
  clampToBounds,
  createCamera,
  rigPosition,
  samplePitchEnvelope,
  sampleYawEnvelope,
  updateCameraProjection,
  withinBounds,
  wrapDegrees,
  yawIsFree,
  yawWithinBounds,
} from './camera'
export type { RigState } from './camera'

export { Character } from './character'
export type { CharacterInput } from './character'

export { EDGE_ON_THRESHOLD_DEG, FACING_ERROR_BUDGET_DEG, analyseCoverage } from './coverage'
export type { CoverageReport, HiddenSurfaces, ObjectCoverage } from './coverage'

export { Picker } from './picking'
export type { PickResult } from './picking'

export { RuntimeScene } from './scene'
// `MapObject` is `document`'s type; `scene.ts` re-exports it and this barrel is
// the union of what the modules export, so it comes back out here too.
export type { MapObject, SceneStats } from './scene'

export { Sky, sunDirection } from './sky'

export { SPRITE_NAMES, generateSprites, generateTerrainSheet } from './textures'
export type { SpriteAsset } from './textures'
