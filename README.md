# Level editor — prototype

An exploratory prototype for the editor described in
[`level-editor-design-brief.md`](level-editor-design-brief.md): a desktop editor
for building 3D levels in a Paper Mario / HD-2D style, where the artist never
models anything in 3D.

This is the first prototype slice, built to answer questions rather than to be
kept. See [`FINDINGS.md`](FINDINGS.md) for what it measured, [`CONTEXT.md`](CONTEXT.md)
for the vocabulary, and [`docs/decision-log.md`](docs/decision-log.md) for the
decisions and their reasoning.

```bash
pnpm install
pnpm dev           # http://localhost:5173
pnpm test          # layer boundaries + unit tests
pnpm lint          # type-aware ESLint; no inline suppressions exist
pnpm bench         # mesher throughput
pnpm shoot         # drive it headless and save screenshots to shots/
pnpm tour          # capture the 25-step guided walkthrough to shots/tour/
pnpm probe         # measure whether post-processing survives on this GPU
```

## What works

- **Terrain sculpt** — raise, lower, flatten, ramps, water. Brush, rectangle and
  flood-fill strokes, any brush size, square or round.
- **Terrain paint** — tile painting with autotiling, cliff faces painted band by
  band, per-cell tint, and a material brush that changes what the template picks
  automatically.
- **Image objects** — six display modes including the extruded paper-cutout
  slab, one to eight facings, mirroring, and the Paper Mario flip with
  hysteresis and a configurable hinge.
- **Camera rig** — yaw, pitch and zoom bounds, detent snapping, a sweep preview,
  free orbit that tints the viewport when it leaves the game's envelope, and a
  coverage readout that prices camera rotation in images the artist would have
  to draw.
- **Atmosphere** — presets that move fog, sky, lighting and post-processing
  together, plus painted backdrop cards for distant scenery.
- **Play mode** — walk the map with WASD, using the same runtime code the
  viewport renders through.
- **Save and load** — versioned JSON, with migrations and validation.
- **glTF export** — `.glb` with everything glTF cannot express in `extras`,
  documented in [`docs/extras-spec.md`](docs/extras-spec.md).

## Keys

| | |
|---|---|
| `1` `2` `3` | Terrain, Objects, Camera |
| `Tab` | Sculpt / Paint |
| `[` `]` | Brush size |
| `Shift` | Erase, or invert (lower instead of raise) |
| `Alt` click | Eyedropper |
| `Ctrl` | Reach through objects to the terrain |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `G` | Clamp to the game's camera bounds |
| `P` | Play mode |
| `Delete` | Remove the selected object |
| `Alt` drag / middle drag | Orbit |
| Right drag | Pan |
| Scroll / pinch | Zoom |

## Layout

```
src/core/     document, commands, undo, meshers, ops  — no three.js, no React
src/runtime/  the reference runtime: scene, billboards, camera, export
src/editor/   React panels and the imperative viewport
```

The import direction `core <- runtime <- editor` is enforced by
`scripts/check-boundaries.mjs`, which runs as part of `pnpm test`. The runtime is
the package a game would consume; the editor renders through it, so the preview
and the game cannot drift apart.

## Two things worth knowing before reading the code

**Paint is addressed in stable grid coordinates.** Cliff faces are keyed by
cell, side and *absolute half-tile level* — never by mesh face, and never by a
row index into a swept profile. Sculpt operations never write to the paint
layers, which is the entire mechanism behind painted work surviving geometry
edits. `src/core/paint.ts` explains it properly, and there is a test that lowers
a cliff and raises it back.

**Assets are generated, not vendored.** The placeholder tile sheet and sprites
are drawn procedurally at runtime, so nothing in this repository carries a
licence. The autotile sheet draws a rim on exactly the sides where a tile is not
connected to its neighbour, which makes it its own guide layer. Load a real
sheet with the Load PNG button; the editor checks its dimensions against the
template layout and says so when the texel density does not match.
