/**
 * The editor's design tokens: one plain object, the single source of truth for
 * every colour, face and scale the vocabulary uses. The Mantine theme is
 * generated from it (theme.ts) and so are the CSS custom properties the app's
 * legacy stylesheet still reads (provider.tsx), so a change here lands
 * everywhere at once instead of drifting across three files.
 *
 * Values come from the design review's mockups (docs/design/five-modes-deep.html,
 * its `:root`): a slate ground with a slight blue bias so the map's greens and
 * blues read as the colour in the room, and a single saffron accent reserved
 * for "this is active" — never for chrome, never for warnings.
 */

export const colors = {
  /** Grounds, darkest to lightest. */
  bg: '#15171c',
  bg2: '#1b1e25',
  panel: '#242833',
  panel2: '#2c3140',
  line: '#353b4a',
  line2: '#414859',
  /** Ink, primary to faintest. */
  ink: '#e8eaf0',
  ink2: '#aab0c0',
  ink3: '#7b8294',
  /** The one accent: active tool, current material, Play. */
  accent: '#e9a23b',
  accentInk: '#1a1305',
  /** Semantic colours, kept apart from the accent so a warning is never confused with "active". */
  warn: '#e5636f',
  ok: '#7bc47f',
} as const

export const fonts = {
  ui: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
  mono: "'IBM Plex Mono', 'SFMono-Regular', Menlo, monospace",
} as const

/** Base font size for the chrome. The mockups are set at 13px; the app was 13px before. */
export const fontSize = 13

export const radius = { sm: 4, md: 6 } as const

/** A 4px grid, named so spacing reads as a scale rather than as numbers. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const

/** Fixed dimensions the frame is built from; the mockup's own measurements. */
export const frame = {
  topBar: 44,
  contextBar: 40,
  rail: 52,
  inspector: 300,
  statusBar: 28,
} as const

export type Tokens = {
  colors: typeof colors
  fonts: typeof fonts
  fontSize: typeof fontSize
  radius: typeof radius
  space: typeof space
  frame: typeof frame
}

export const tokens: Tokens = { colors, fonts, fontSize, radius, space, frame }
