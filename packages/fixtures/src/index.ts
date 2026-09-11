/**
 * The fixtures package's public surface.
 *
 * Dev-only, in the sense that nothing shipped depends on it — but deliberately
 * NOT lint-exempt, because its output is real data the editor loads and has to
 * satisfy the same invariants as anything else (see `eslint.config.js`).
 *
 * Issue #3 also parks procedural texture generation here. That half has not
 * moved: `packages/runtime` still generates its own placeholder sheet and
 * sprites, and prising them out means changing what crosses the boundary from
 * a canvas to raw pixels — a reshape, not a move.
 *
 * Written out rather than `export *`, matching the other packages.
 */

export { createSampleMap } from './sample'
