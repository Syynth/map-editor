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

## Owner

Whoever declared a thing: the identity a [Feature module](#feature-module) or
a built-in package presents when it registers a [Command](#command), a panel,
a tool or a keybinding, and the unit those registrations are torn down by —
all of an owner's at once, none of anyone else's. A feature module is one kind
of owner; a built-in package is the other, and a built-in is never torn down.

The word is owner rather than feature so that a package which is not a feature
— the document, say — can declare its own commands.

## Host

The root of the editor's running behaviour: the one place every
[Command](#command) is dispatched to, and the owner of the lifetimes of the
actors that handle them. A command goes *down* from the host to the actor of
the [Owner](#owner) that declared it, never sideways between actors, so a
keypress that does nothing has exactly one place to be looked for.

The host also holds the editor's **mode**: editing, or playing the level.

## Context key

A named fact about the editor's current state — which mode it is in, whether
anything is selected, whether there is something to undo — that a
[Command](#command)'s availability may be conditioned on. The vocabulary is
declared, so a condition can only ever mention a key that exists, and a
disabled control can say which key is the reason.

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

The terrain texture atlas: a grid of square tiles laid out
material-by-material, where position on the sheet defines what a tile is,
the way RPG Maker autotile sheets work. The current terrain template gives
each material a block of autotile variants plus a row of cliff and ramp
tiles; exact sheet layouts are still open and expected to change as the
artist works with them.

The sheet is generated as a placeholder or supplied by the artist, and is
what lets the artist never tag tiles by hand.

## Sprite

A named asset in the sprite library: the visual definition of a tree, an
NPC, a sign, or a prop. This is the brief's "Image object" — a visual
placed with a full transform, outside the voxel grid. A sprite declares its
[facings](#facing), the footprint used to size its quad, and whether it
emits light.

Placing a sprite creates an object on the [Map](#map): the object stores
which sprite it references, plus its own position, scale, and facing state.
Many objects can reference the same sprite, and painted background scenery
does too.

## Facing

One directional image of a [Sprite](#sprite), shown when the object is
viewed from a particular yaw. A sprite may have 1, 2, 4, or 8 facings
depending on how much directional art the artist supplied; the first always
faces the camera at the default yaw.

A second sense, the facing configuration, is the object's behaviour around
its facings: mirroring the right-hand images for the left side, how it
flips or transitions between facings, and how much overlap it tolerates
before switching back, to stop flicker.

## RgbaImage

Raw pixel data crossing the texture boundary: width, height, and a buffer
of row-major RGBA bytes, four per pixel.

Everything that draws — the placeholder generator, the artist's sheet or
sprite loader — produces this, and everything that uploads or encodes — the
runtime's textures, glTF export — accepts it, so pixels can move between
them without either side depending on a canvas.
