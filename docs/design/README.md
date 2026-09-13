# Design

- [`five-modes-deep.html`](five-modes-deep.html) — the 2026-09-12 review of the editor's
  primary editing tasks, with mockups of the proposed chrome. **This is the spec for the
  UI revamp**: the token values in its `:root`, the rail / context bar / stacked-inspector
  frame, the Paint material palette, the Objects sprite palette, and the coverage
  placement. Open it in a browser; the viewports are drawn stand-ins, everything else is
  literal. Published copy: https://claude.ai/code/artifact/9882467f-9c7f-417a-b31f-ad3f3a80ae58
- [`select-first.html`](select-first.html) — the 2026-09-12 frame, worked interactively: the
  rail of subject tools with Select first, the all-icon context bar with tooltips, the
  stacked inspector, the library sections, and the slicer-style layer view. **This
  supersedes the frame half of `five-modes-deep.html`**; the decisions it records are in
  `docs/decision-log.md` under that date. Published copy:
  https://claude.ai/code/artifact/66edd969-eb88-42e7-a6f8-7929811ee063
- [`terrain-tools.html`](terrain-tools.html) — the 2026-09-13 Terrain and Water tools on the
  `select-first.html` frame: the Paint bar as Material / Stamp / Tint with the active
  material as a chip, the Materials library section (fills ordered by draw priority, the
  path as an overlay, each material's sixteen variants straight from the sheet), the
  Sculpt bar as Raise / Flatten / Smooth / Ramp with Strength and Height as scrub fields,
  and Water as a rail item with Fill / Drain and a Level scrub. The viewport is a live
  paint demo: every tile is blitted from a generated 16 px sheet through the corner-tag
  lookup, five fills and a path are wired up, and the face view shows one row's cliff as
  the grid it is so bands can be painted. Below the frame, a static mockup of terrain-set
  setup: Tiled-style corner and side tags underneath, an RPG Maker-style template stamp
  on top. The decisions it records are in `docs/decision-log.md` under that date.
  Published copy: https://claude.ai/code/artifact/49647e2f-c4ab-45d6-9472-4c308f52df16
