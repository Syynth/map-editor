# Project format and flow — design source

Artboard sources for the project format and the open/new/settings flow,
drafted 2026-09-14 to mirror brink's flow and style: two doors on startup,
kind-badged recents, a "Will create" dialog, and a settings modal with a
scope switch and a rail of sections. Project settings take LDtk's shape:
image management (Sheets), terrain type management (Terrain sets), and the
material library (Materials).

| File | Screen |
|------|--------|
| `Model.dc.html` | The model: a project is a folder anchored on `papercut.json`; three ways in |
| `Main.dc.html` | Startup — New Project / Open, recents with PROJECT / MAP badges, reopen toggle |
| `NewProject.dc.html` | New Project dialog → `papercut.json`, a first map, the placeholder sheet |
| `Shell.dc.html` | The editor with a project open; the project popover under the crumb |
| `Sheets.dc.html` | Project settings › Sheets |
| `Terrains.dc.html` | Project settings › Terrain sets |
| `Materials.dc.html` | Project settings › Materials |
| `Format.dc.html` | The folder layout, a `papercut.json` excerpt, what moves out of the map file |
| `canvas.json` | Canvas layout and the open questions as notes |

## What these are matched against

Values are papercut's own `packages/ui` tokens (`tokens.ts`, `styles.css`):
IBM Plex Sans 13px, grounds `#15171c` / `#1b1e25` / `#242833` / `#2c3140`,
hairlines `#353b4a`, ink `#e8eaf0` / `#aab0c0` / `#7b8294`, the saffron
accent `#e9a23b`, radii 4 / 6, 28px controls, the frame's 44 / 40 / 52 / 300
/ 28. The structure — doors, badges, the settings rail — is brink's
(`docs/design/project-open-flow`, `packages/studio-ui/src/SettingsModal.tsx`
there).

## Format

`.dc.html` (Design Components). Each file is one artboard; `canvas.json`
places them. They render on a canvas published as an Artifact.
