# Prototype plan

Companion to `level-editor-design-brief.md`. The brief says what we want; this
says what is being built, in what order, and which of its open questions have
been closed along the way.

Status key: **done** / **in progress** / **not started**.

## Decisions taken up front

These are the expensive-to-reverse ones. Everything else is deliberately left
open.

| Decision | Choice | Where |
|---|---|---|
| Document model | Normalised, serializable, mutated in place behind a revision counter | `src/core/document.ts`, `src/core/store.ts` |
| Undo | Patches with an automatically derived inverse; tools never write `undo()` | `src/core/commands.ts` |
| Paint addressing | Stable grid coordinates; cliff faces keyed by **absolute half-tile level** | `src/core/paint.ts` |
| Height units | Integer half-tiles (`height: 3` is 1.5 tiles) | `src/core/document.ts` |
| World scale | One tile is one world unit, always; texel density is texture detail only | `src/core/document.ts` |
| File format | Versioned JSON, single file, migrations from v0 | `src/core/io.ts` |

## Decisions deliberately deferred

- **Electron vs Tauri.** Not picked. The prototype is a plain Vite web app, which
  keeps HMR and defers the choice until there is a heavy scene to smoke-test
  both with — which is what the brief says should decide it.
- **Meshing in a worker.** Not done. The mesher is a pure function with no
  three.js imports, so moving it is wiring, not a rewrite. Benchmarked instead
  (see below).
- **WebGL2 vs WebGPU.** WebGL2. Nothing in the slice needs compute.
- **Terrain as a voxel view** (brief §7). Closed as "no, not now". Blocks are not
  in the slice and coupling the heightfield to a voxel grid without evidence is
  an expensive decision made blind. Terrain stays a heightfield.

## Layering

```
src/core/     document, commands, meshers, ops  — no three.js, no React
src/runtime/  three.js scene, billboards, camera — no React
src/editor/   React panels and viewport
```

`core <- runtime <- editor`, never backwards, enforced by
`scripts/check-boundaries.mjs` in `npm test`. Promote to workspace packages when
the headless exporter CLI needs to import core on its own.

The runtime package is carved out from the moment billboard behaviour exists,
not at play mode, so "what you see is what ships" is true by construction rather
than retrofitted.

## Milestones

- [ ] **Spikes** — pixel art in perspective, meshing throughput
- [ ] **M0** Skeleton: Vite + React + three.js, terrain rendered from data
- [x] **M1** Spine: document, commands, undo, versioned save/load
- [ ] **M2** Terrain sculpt: picking to `(surface, cell)`, strokes, dirty chunks
- [ ] **M3** Terrain paint: autotiling, cliff paint, tint
- [ ] **M4** Image objects, display modes, facing and flip
- [ ] **M5** Camera rig, bounds, coverage readout
- [ ] **M6** Play mode on the runtime package
- [ ] **M7** glTF export with the extras spec

M1 landed first because the meshers and ops need somewhere to write to. M0's
viewport follows immediately.

## Questions the prototype was built to answer

Recorded in `FINDINGS.md` as they get answered.
