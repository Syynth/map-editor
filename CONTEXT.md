# Context

The vocabulary of `map-editor`. A glossary, not a spec: no implementation
details, no decisions. Decisions live in
[`docs/decision-log.md`](docs/decision-log.md) and on the wayfinder maps it
links to.

## Command

A named, enumerable, remappable **intent**: `terrain.raise`, `tool.select`,
`undo`. A command is what a keybinding fires, what a menu item exposes, and
what a test invokes — all three dispatch the same thing.

A command's **declaration** is enumerable independently of whether anything is
currently able to handle it, because a keybinding UI and a command palette need
the full list before any interaction is underway. Its **invocation** is a
message delivered to the actor that handles it, so commands are distributed
across the codebase alongside those actors rather than gathered in one place.

Not to be confused with [Edit](#edit), which is what this word used to mean in
`core`.

## Edit

One entry on the undo stack: a completed change to the document together with
its exact inverse. An edit is the **output** of an interaction, where a
[Command](#command) is the input to one.

A whole brush stroke is a single edit, however many ticks it spanned.

## Feature module

A self-contained unit of editor functionality — a tool, a panel, a viewport
overlay — that attaches through a declared API rather than by reaching into
other parts of the editor. Contributes commands, panels and actors.

Feature modules live in-tree today. The term exists to name the seam, which is
what makes a future plugin possible: a plugin is a feature module that happens
to live outside the repository.

## Map

The level being edited: terrain, paint, objects, and the settings that describe
how they are lit and viewed. "Map" is the artist's word and the document's
word; it is unrelated to a wayfinder map, which is a planning artifact on the
issue tracker.

## Half-tile

The unit of terrain height. Heights are integers counted in half-tiles, never
fractions, so terrain snaps and cliff faces have exact integer extents.

One tile is one world unit, always.

## Cliff face

The vertical surface exposed where two adjacent cells differ in height. A cliff
face is addressed by the cell it belongs to, the side it faces, and the
absolute half-tile level it occupies — never by a triangle or a mesh face.

This is what lets paint survive sculpting: raising the terrain beneath a
painted face does not move the paint, because the paint was never attached to
the geometry.

## Stroke

One continuous interaction with a tool, from press to release. A stroke may
span many frames and touch a cell many times, but it produces exactly one
[Edit](#edit).

## Sheet

The terrain texture atlas: a grid of square tiles laid out material-by-material, where position on the sheet defines what a tile is, the way RPG Maker autotile sheets work. Each material owns a block 4 tiles wide and 5 tiles tall — the top 4 rows hold the 16 autotile variants (chosen by a mask of which neighbours share the material), and row 5 holds cliff edges and ramps.

The sheet is generated as a placeholder or supplied by the artist. Its layout is documented in `packages/geometry/src/template.ts` and is what lets the artist never tag tiles by hand.

## Sprite

A named asset in the sprite library: a visual object placed on the [Map](#map) — trees, NPCs, signs, props. A sprite's definition includes its [facings](#facing), the footprint the runtime sizes the quad from, and whether it emits light. One sprite is one object instance; the term does not refer to individual images or frames.

A sprite's key is stored in the [Map](#map) and resolved at runtime to fetch its images and metadata. This naming lives in the document package so that fixtures and the runtime can communicate through the same type without importing each other.

## Facing

One directional image variant of a [Sprite](#sprite): a single [RgbaImage](#rgbaimage) rendered when the object is viewed from a particular yaw. A sprite may have 1, 2, 4, or 8 facings depending on how much directional art the artist supplied. The runtime picks the facing to display based on camera angle, with optional mirroring, transitions, and hysteresis to prevent flicker.

Index 0 always faces the camera at the default yaw (the artist's front).

## RgbaImage

Raw pixel data crossing the texture and render boundary: width, height, and a single `Uint8ClampedArray` buffer of row-major RGBA bytes, four per pixel.

Everything that draws — the placeholder generator in fixtures, the artist's sheet or sprite loader in the editor — produces this type, and everything that uploads or encodes — the runtime's textures, glTF export — accepts it. This type lives in `packages/document` because it is data, not rendering, the way [Sprite](#sprite) asset keys are; the package stays free of DOM APIs so the runtime compiles without them and headless callers can supply pixels from anywhere.
