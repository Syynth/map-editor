/**
 * `performance.now()` is the one host global this package reads. It is not in
 * any ECMAScript lib — it is W3C High Resolution Time — but it is a global in
 * every browser and in Node since 16, which is why `RuntimeScene` can time a
 * meshing pass with it in both. `lib` here deliberately has no `DOM` and
 * `types` is empty (#47), so the name has to be declared somewhere: this is
 * exactly the slice used, and nothing else about either environment.
 *
 * Only this package's own tsconfig includes this file. The consumers that
 * compile the same sources with `DOM` in `lib` never see it, so there is no
 * second declaration for `lib.dom.d.ts`'s to collide with.
 */
declare const performance: { now(): number }
