# Level Editor: Design Brief (Draft)

*Working name TBD. Status: exploratory prototype. Drafted September 2026.*

## Read this first

This document is the output of a brainstorm, not a specification. Apart from the short list of firm requirements, every design here is a hypothesis to be tested, and some of them will turn out to be wrong. Treat the tentative sections as a map of the problem and one plausible route through it, not as a set of instructions.

Guidance for implementation:

- Build the smallest thing that lets us learn something, then stop and show it.
- Don't build general abstractions (plugin APIs, generic tool frameworks, extensible registries) until two or three concrete cases actually need them. Hardcode first, extract later.
- If a design here looks wrong once you're in the code, say so and propose an alternative instead of forcing it.
- Prefer choices that are cheap to reverse. Where a decision is expensive to undo (file formats, the document model), keep it minimal and versioned.
- State the assumptions you make, so they can be checked.

> **Superseded, 2026-09-11.** The guidance above on *when to abstract* — hardcode first,
> no plugin APIs or registries before two or three concrete cases — was written for the
> exploratory prototype, and the prototype is finished. The foundation now being built
> deliberately does the opposite, for reasons recorded in
> [`docs/decision-log.md`](docs/decision-log.md) under *"The brief's 'hardcode first'
> guidance is superseded"*. Everything else in this section, and the vision and firm
> requirements below, still stand.

Labels used throughout:

- **Firm**: a requirement from the project owner.
- **Tentative**: the current best idea, pending experimentation.
- **Open**: undecided; the prototype should help answer it.

## Vision (Firm)

An extremely approachable desktop editor for building 3D levels in a "Paper Mario" or HD-2D style (2D art placed in a 3D space with depth, lighting, and atmosphere) without the artist ever doing 3D modeling.

The closest reference is the P2D map editor shown for RPG Maker U2U (announced 2026): fixed-perspective maps, terrain shaped by combining blocks, and objects dressed with ordinary 2D map tiles. The primary user is an artist, not a programmer. When "streamlined and friendly" conflicts with "powerful and general," friendly wins.

## Firm requirements

- A desktop app built on web tech: React for UI, three.js for rendering, packaged with Electron or Tauri (not yet decided).
- Artists never have to model in 3D. All geometry comes from 2D art applied to generated shapes, or optionally from imported glTF.
- Export is engine-agnostic glTF. The first consumer is a three.js game.
- Engines can define custom types (roughly JSON Schema), and the editor generates editing forms from them.
- Authoring is organized around curated, named tools ("Terrain tool", "Building tool", "Fence tool"), each with its own focused interactions, even if they share underlying capabilities.
- Terrain and buildings support **sculpt** operations (change geometry) and **paint** operations (RPG Maker–style tile and tint painting).
- Reusable models and prefabs.
- A Minecraft-style voxel/block fallback for anything the higher-level tools can't express.
- Freely placed objects (images and billboards, glTF models, custom shapes) that don't occupy voxel space.
- A sky system.
- Any texture resolution, including high-res, chosen per map (or at a similar scope).
- Camera bounds (rotation, height/pitch) that the artist can configure. Whether the target games allow rotation at all is something this prototype will be used to decide.
- Billboard objects can be configured with a Paper Mario–style rotation/flip behavior.

## Guiding principles (Tentative, but expected to outlast specific designs)

**Modeling is never required.** Every feature should be usable with only 2D images. glTF import is an escape hatch, not a dependency.

**The level is data; geometry is derived.** The project file stores intent: cells, heights, paint, shapes, objects, settings. Meshes are regenerated from that by deterministic meshers. This keeps files small and diffable, makes undo simple, and keeps the editor engine-agnostic.

**What you see is what ships.** The editor preview should run the same runtime code the game uses (lighting, post-processing, billboard behaviors), so there's no "it looks different in game" gap.

**Curated tools on a shared core.** Artists see named tools with a handful of verbs. Underneath, tools share picking, strokes, commands, and meshing. The shared core should emerge from building concrete tools, not be designed up front.

**There's always an escape hatch.** When a smart tool can't do something, the artist can drop down a level (convert to blocks, place a free object, import a glTF) instead of getting stuck.

**Paint survives sculpt.** Editing geometry should never scramble or destroy painted work.

**Defaults look decent.** Unpainted surfaces get a reasonable look from their template, so painting refines a map rather than starting from blank.

**Grid first.** Most things snap to a tile grid, which keeps both the data model and the UI simple. Free placement is the exception, not the rule.

---

## Design areas

Everything below is **Tentative**. Each area lists the current thinking and what's still open.

### 1. App shell and stack

React owns the panels, palettes, forms, and outliner. The 3D viewport is managed imperatively in three.js, for example by a chunk manager that rebuilds only dirty chunks. react-three-fiber may be fine for gizmos and overlays, but it probably shouldn't manage bulk terrain geometry that changes on every brush stroke. Meshing runs in a Web Worker, in TypeScript; move it to Rust/WASM only if profiling shows a need.

On Electron vs Tauri: Electron ships one consistent Chromium, so WebGL behavior and performance match across platforms. Tauri is lighter but renders through each OS's webview (WebView2, WKWebView, WebKitGTK), where WebGL behavior varies, especially on Linux. Since export is glTF and meshing is TypeScript, there's no strong need for a Rust backend. The current lean is Electron, but a quick smoke test of a heavy three.js scene in both, on the target platforms, should decide it.

Open: WebGL2 or WebGPU renderer. Single-file or folder-based projects.

### 2. Document model, commands, and undo

All editor state lives in a normalized, serializable document. Every edit is a reversible command applied to that document (reducer-style), which gives every tool undo and redo for free. Entities get stable IDs at creation that never change; prefab overrides depend on this later.

The native project format is plain data (JSON or similar), versioned from day one. glTF is strictly a build output: don't try to round-trip it back into editable data.

Open: how assets are referenced (relative paths or asset IDs); whether the document is one file or several.

### 3. Tool framework

Tools compose a small set of shared capabilities:

- **Surfaces**: addressable 2D tile grids laid onto geometry, such as a terrain top, a cliff band, a wall strip, or a roof plane.
- **Picking**: a raycast that resolves to a surface and a cell on it, not just a point in space.
- **Strokes**: point, drag, rectangle, and fill input, converted into cell edits, with a hover preview.
- **Commands**: as in section 2.
- **Meshers**: turn a tool's data plus its template into geometry.

A tool bundles modes, a toolbar, viewport handlers, overlays, a data type, a mesher, a template, and a properties schema. Don't formalize this as a plugin API until three or four tools exist.

Terrain and buildings share a sculpt/paint mode switch with the same keys and brush controls, so learning one teaches the other. Other tools don't need to fit that pattern (a fence tool is probably "draw a path, pick a style"), but the shared verbs (brush size, eyedropper, erase, undo) should behave identically everywhere.

**Paint surviving sculpt (probably the most important data decision).** Store paint in stable grid coordinates, not per mesh face: terrain tops by cell, cliff faces by edge and height level, walls by facade segment, position, and row. When geometry shrinks, paint beyond the new edge goes dormant instead of being deleted, so extending the geometry again brings it back. Paint stacks in layers: the template's automatic default, then painted overrides, then fixtures on top.

### 4. Templates and styles

A template kind (terrain, building, and later fence, path, bridge, ...) consists of three things: a **sheet layout** the artist paints into, a **parameter schema**, and a **mesher**. Position on the sheet defines what each tile means, the same way RPG Maker's autotile sheets work, so the artist never tags tiles by hand. Each template ships as a PNG with a labeled guide layer.

A **style** is a named bundle of a sheet, parameters, and default paint rules, like "Tudor cottage": timber walls, thatch roof, a window every third tile, a centered door. A style applies to any shape. Styles are the reusable form of the automatic default paint layer.

Open: exact sheet layouts, which should come from working with the artist rather than being designed in advance. Whether sheets support variants and random selection.

### 5. Terrain tool

Data: per-cell height (possibly in half-tile steps), per-cell top material, edge type (cliff or ramp), water, and tint.

- **Sculpt**: raise and lower, flatten to a height, toggle an edge between cliff and ramp, carve water.
- **Paint**: tile brushing with autotiling on tops and cliff faces, plus a tint brush.

Ideas to test:

- **Profile strip.** The template includes a silhouette whose alpha defines the cliff's cross-section (straight, rounded, overhanging, stepped), and the mesher sweeps it along every cliff edge. This lets the artist change geometry by painting a 2D shape. The owner described the terrain template as letting the artist "edit the geometry"; this is one interpretation, and it needs confirming.
- **Tint** stored per cell or sub-cell, quantized to the pixel grid, and baked into vertex colors together with ambient occlusion. Avoid smooth splat blending between materials, which looks mushy next to pixel art; authored transition tiles look better.

### 6. Building tool

A building is a volume: one or more grid-snapped footprints (overlapping footprints merge into L and T shapes), a floor count, and roof parameters (gable, hip, flat, or shed; pitch; overhang).

- **Sculpt**: drag footprints, push and pull wall segments, add floors, adjust the roof with handles.
- **Paint**: walls are grids that wrap continuously around corners. The building sheet supplies wall fill, base and top trim rows, corners, roof slope, ridge, eave, and gable end, like RPG Maker's A3 building tiles but richer.

**Fixtures** (windows, doors, signs, vents) snap to the wall grid. A fixture can be a flat decal, an inset, or an opening cut through the wall, and windows can have an emissive layer that glows at night. One idea is that a door is a fixture that also carries an engine type from section 13 (for example `Door { target, locked }`). Doors may end up needing their own system; that's open.

On slopes, a building either extends its walls down to the ground using the base trim, or flattens the terrain under its footprint as a single undoable action. Roofs and foreground occluders get tagged in the export so the runtime can fade them when they block the view.

### 7. Blocks (voxel fallback)

Blocks share the tile grid with everything else: one block per tile, plus half-height slabs.

A block type is a shape plus face tiles, defined as data. Face-assignment presets cover the common cases (the same tile on every face, or separate top, side, and bottom tiles), with per-face assignment available.

Built-in shapes: cube, slab, stairs, wedge slope, inner and outer corner slopes, pillar, thin pane, and crossed planes for plants. Custom shapes are lists of boxes with coordinates in sixteenths of a block and per-face UVs, the same approach as Minecraft's block models. Blockbench already edits this kind of model and exports glTF, so it may be able to serve as the custom-shape editor instead of building one.

The mesher culls faces hidden between neighbors and bakes ambient occlusion into vertex colors, so blocks match the look of the terrain.

- **Sculpt**: place, remove, box-fill, replace.
- **Paint**: retile individual faces.

**Convert to blocks.** Terrain and buildings get a "convert to blocks" action for any region, like rasterizing a smart layer in Photoshop. When a template can't express something, the artist converts that corner and hand-edits it. Start with one-way conversion that discards the parametric source; keeping the source with blocks as an override layer is harder, and can come later if needed.

Open: whether terrain columns are internally just a smart view onto the block grid, which would make conversion trivial.

### 8. Free objects

Free objects sit outside the voxel grid with a full transform. Snapping is optional: to the grid, the half-grid, or the texel grid.

**Image objects** have a display mode:

- fixed-facing plane (likely the default under a fixed camera)
- billboard rotating around Y only
- full billboard
- crossed planes
- extruded slab: the alpha silhouette extruded into a thin mesh, for the paper-cutout look and correct shadows
- auto: chosen from the map's camera bounds (section 11)

The pivot defaults to bottom-center, and size comes from the map's texel density unless overridden.

**glTF objects** are referenced by path and instanced rather than copied into the map. Import normalizes units and can force nearest filtering so models sit comfortably next to pixel art.

**Grounding**: placement drops the object onto the surface under the cursor. Objects can optionally be anchored to that surface, so sculpting the terrain moves them with it instead of burying them.

Also: optional collision metadata (none, box, cylinder, or from the mesh); animated sprite frames and timing; a scatter brush with per-instance seeds for variation; clicks that pick free objects before voxel faces, with a modifier to reach through; and an outliner with groups, locking, and hiding.

**Facing and flip configuration** (Firm that it exists; details Tentative):

- **Sides**: a front image, plus a back that can be its own image, the mirrored front, a darkened silhouette, or nothing.
- **Facings**: one, two, four, or eight directional images keyed to the view angle, with mirroring so left can reuse right.
- **Transition**: instant swap, a Paper Mario–style flip (a Y-axis rotation that swaps images at the edge-on midpoint), or a crossfade, with adjustable duration and easing.
- **Trigger**: camera yaw crossing a threshold, with hysteresis to prevent flicker. Characters use movement direction relative to the camera instead, so the same system covers NPCs and 4-direction sprite sheets.
- **Hinge**: center, one edge (like a door), or the base, which also enables pop-up and fold-down effects.

### 9. Prefabs and reuse

**Prefabs** are exact, linked copies: a saved object or group whose instances update when the definition changes.

- Editing happens in isolation, with the rest of the map dimmed (as with Figma components). Sculpting an instance asks whether to edit the prefab or detach the copy.
- Instances can override properties, paint, and fixtures. Overrides are shown visually, with actions to revert them or apply them back to the prefab.
- Stable child IDs (section 2) are what let overrides survive later edits to the definition.
- Instances snap to the grid with 90° rotation and mirroring. Paint stored in local grid coordinates rotates with the instance.
- Engine-type fields can be marked as required per instance (a door's target, for example), and unset ones get flagged on the map.

Prefab sprites can include several variants plus tint and scale jitter, selected by a stored per-instance seed, so repeated props look varied but export identically every time.

**Styles** (section 4) cover resizable reuse. The working assumption is that prefabs are fixed shapes and styles are for anything resizable.

Open: whether the artist expects a stretched prefab instance to stay linked. How prefabs nest.

### 10. Texture resolution

The world unit is fixed at one tile. Pixel density is a setting, so a 16px map and a 64px map share world scale and differ only in texture detail.

Resolution lives in a named **resolution profile** that maps reference: texel density (pixels per tile), filtering (nearest for pixel art, linear with mipmaps for high-res), and whether things snap to the texel grid. Tilesets, templates, and prefabs declare the profile they were authored for. Mismatches produce warnings, and the editor offers nearest-neighbor rescaling when the ratio is a whole number. Mixed texel density is the fastest way to make pixel art in 3D look wrong, so the tool should make it hard to do by accident.

High-res profiles will outgrow a single atlas quickly. Plan for array textures in the editor and multiple atlases per export.

Open: whether the profile is set per map or per project, with per-map overrides.

### 11. Camera rig and bounds

A rig definition holds the default yaw, pitch, distance, and field of view; bounds on yaw, pitch, zoom, and height; snapping (continuous, or detents such as 90°); and projection (perspective with a narrow FOV, or orthographic). Bounds cascade: a project default, a per-map override, and optional camera zones that tighten them further inside a map. The rig ships in the export for the runtime to enforce.

Rotation should be cheap to experiment with. In the editor:

- Free orbit is always available, but the viewport tints when it leaves the game's allowed envelope, and a "game camera" toggle clamps it.
- A sweep preview animates through the extremes of the allowed range.
- A validator flags fixed-facing planes that would be seen close to edge-on within the envelope, with a one-click switch to a better display mode.
- A coverage readout shows how many objects have only one facing and how many would look wrong under the current bounds. This turns "do we want rotation?" into a concrete trade-off between feel and art cost.

A possible payoff: surfaces that can't be seen from any allowed angle don't need painting, and the mesher can skip them. If bounds widen later, the editor highlights newly visible unpainted surfaces, which fall back to template defaults.

Open: whether the target games rotate at all, and whether rotation is continuous or snapped. That's a primary question for the prototype.

### 12. Lighting, atmosphere, and sky

Lights are mostly implicit: lamp props carry their own point lights, and windows carry emissive layers. Atmosphere comes as named presets ("Misty dusk", "Night festival") that control fog, bloom, tilt-shift depth of field, hemisphere light colors, and the sky, with sliders tucked away as a secondary option. Ambient occlusion baked into vertex colors does much of the soft HD-2D shading cheaply.

The sky system, offered in layers from cheapest to richest:

1. Gradient sky with color stops and optional sun and moon sprites.
2. Image sky, cubemap or equirectangular, including HDR for high-res profiles.
3. Backdrop cards: painted distant layers (mountains, skylines, tree lines) on large planes with parallax. This is the no-modeling answer to distant scenery.
4. Scrolling cloud layers, with optional cloud shadows projected onto the ground.

The sky drives fog and ambient light colors, so choosing a preset changes everything together. Skies are reusable assets, and a time-of-day setting can blend between two presets.

Open: how often the camera actually sees the horizon at typical pitch. If rarely, backdrop cards and fog matter more than full skyboxes.

### 13. Engine-defined custom types

Engines drop `*.schema.json` files into the project, and the editor hot-reloads them when they change. Support a deliberate subset of JSON Schema (objects, primitives, enums, arrays, refs, tagged `oneOf` unions) plus a few editor annotations:

- placement kind: point, box area, path, or wall-attached
- viewport appearance: icon, sprite, or colored volume
- special field widgets: references to other entities, asset pickers, color pickers

Instances are validated (for example with Ajv), and invalid ones are highlighted on the map when a schema changes. Engines can generate their schemas from code (zod or TypeBox in TypeScript, schemars in Rust), so the engine stays the source of truth. The same form renderer powers the editor's own template parameters. Generic JSON Schema form libraries are fine for prototyping, but a custom renderer for the supported subset will probably feel friendlier. LDtk's entity definitions are good prior art.

Open: how much gameplay data belongs in levels (just collision and markers, or also triggers and event hooks).

### 14. Export and runtime

The exporter takes the same buffers the editor previews and packs them into `.glb` (gltf-transform is one option). Candidate mappings:

| Feature | glTF representation |
|---|---|
| Cutouts | Alpha-masked meshes (`alphaMode: MASK`) |
| Pixel-art textures | `NEAREST` samplers, lossless PNG; avoid KTX2/Basis |
| Lamps | `KHR_lights_punctual` |
| Glowing sprites | Emissive materials with `KHR_materials_emissive_strength` |
| Repeated props | Shared meshes or `EXT_mesh_gpu_instancing` |
| Baked AO and tint | Vertex colors (`COLOR_0`) |
| Facing and animation frames | One atlas per object plus UV rectangles in extras, switched via `KHR_texture_transform` |
| Camera-facing billboards | A plane plus an extras flag; the runtime reorients it |

Anything glTF can't express goes into node and scene `extras`: fog, post-processing, sky, camera rig, collision, walkability, spawn points, animated tiles, facing and flip behavior, prefab IDs, and engine-type instances. Document this as a small versioned spec with a JSON Schema, since "engine-agnostic" really means other people implementing that spec.

A **reference runtime package** for three.js reads the extras and sets up post-processing, lights, sky, billboard and flip behavior, roof fading, and collision data. The editor's viewport and play mode use this same package, so the editor matches the game by construction.

A per-export option chooses between keeping objects separate (identity preserved) and merging static geometry per chunk (fewer draw calls). The exporter should also run as a headless CLI for build pipelines.

---

## First prototype slice

The goal is to test the core feel, and whether camera rotation is worth pursuing, before building buildings, prefabs, or blocks. One small map with:

1. Terrain with height sculpting and tile painting from a simple template.
2. Image objects with display modes and the facing and flip configuration.
3. Camera bounds controls, a game-camera preview, and ideally the coverage readout.
4. Play mode: a character walking the map, using the runtime package for billboard behavior.
5. Save and load in the native format.

glTF export can follow right after, since the runtime package already exercises most of the extras spec.

## Questions the prototype should help answer

- Is camera rotation worth it, and how much extra art does it cost?
- Can the artist understand the template sheets? A useful test: can they slot an existing pack (for example Kenney's Tiny Town) into the terrain template in about an hour?
- Pixel art in perspective: crisp or soft? How bad is shimmering at distance, and which filtering and mipmap settings work?
- Is TypeScript meshing in a worker fast enough while brushing?
- Electron or Tauri, based on real rendering on the target platforms?
- How does the artist think about reuse: fixed prefabs, resizable styles, or something else?
- How much of the sky is ever visible?
- How much gameplay data should levels carry?

## Out of scope for now

Event and scripting systems, dialogue, battle systems, multiplayer or collaborative editing, a public plugin API, round-tripping glTF back into editable data, and an asset store.

## Test assets and licensing

- **RPG Maker RTP (default assets) must not be used.** The RPG Maker EULA restricts them to games made with RPG Maker. Supporting the MZ sheet layout is fine for third-party packs whose licenses allow any engine.
- **CC0, safe to bundle as sample content:** Kenney's Tiny Town, Tiny Dungeon, and Tiny Farm (16px); Kenney Voxel Pack and Block Pack; Ninja Adventure by Pixel-boy (16px).
- **LPC base assets (32px):** CC-BY-SA 3.0 / GPL 3.0. Fine for testing in games with attribution, but don't bundle them as sample content.
- Anything shipped with the editor should be CC0 or similarly permissive. Keep a credits and licenses file for every third-party asset.

## References

- RPG Maker U2U's P2D map editor: fixed perspective, block-based terrain, tile decorations, 4-direction sprites auto-mapped to 8 directions.
- Paper Mario: flip rotation and paper-cutout objects.
- Octopath Traveler and other HD-2D games: lighting, depth of field, and atmosphere.
- LDtk: friendly, schema-driven entity definitions.
- Minecraft block models and Blockbench: box-list custom shapes.
- Figma components: prefab editing and override UX.
