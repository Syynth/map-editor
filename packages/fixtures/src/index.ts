/**
 * The fixtures package's public surface.
 *
 * Dev-only, in the sense that nothing shipped depends on it — but deliberately
 * NOT lint-exempt, because its output is real data the editor loads and has to
 * satisfy the same invariants as anything else (see `eslint.config.js`).
 *
 * Two kinds of fixture live here. The sample map is pure document verbs. The
 * placeholder art generator (#3 parked it here; #47 moved it) draws with a 2D
 * canvas where one exists and hands back raw `RgbaImage`s, so `runtime` never
 * sees the canvas — that is the boundary this package sits on the drawing side
 * of. Where no canvas exists, `baked/` carries the same output pre-rendered as
 * PNG; `pnpm bake` regenerates it.
 *
 * Written out rather than `export *`, matching the other packages.
 */

export { createSampleMap } from './sample'
export { SPRITE_NAMES, generateSprites, generateTerrainSheet } from './textures'
