/**
 * The Mantine theme, derived from the tokens. Mantine wants every colour as a
 * ten-shade tuple, lightest to darkest, and reads its dark-mode neutrals from
 * `colors.dark`; both are built here from the token object so nothing about
 * the palette is written twice.
 */

import { DEFAULT_THEME, createTheme, mergeMantineTheme, type MantineColorsTuple, type MantineThemeOverride } from '@mantine/core'

import { colors, fonts, fontSize, frame, radius, space } from './tokens'

type Rgb = [number, number, number]

function parse(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function format([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/**
 * Ten shades around a base colour: five lighter, the base at index 5, four
 * darker. Mantine's `primaryShade` below points at index 5, so the accent the
 * mockup specifies is the accent that renders; the other shades exist for
 * hover, soft fills and disabled states.
 */
export function shades(base: string): MantineColorsTuple {
  const rgb = parse(base)
  const light = parse('#ffffff')
  const dark = parse('#000000')
  const steps = [0.85, 0.7, 0.5, 0.3, 0.15, 0, 0.15, 0.3, 0.45, 0.6]
  return steps.map((t, i) => format(mix(rgb, i < 5 ? light : dark, t))) as unknown as MantineColorsTuple
}

/**
 * Mantine's neutral scale for dark mode, from the token grounds and inks:
 * index 0 is the brightest text, index 9 the deepest ground. Mantine's own
 * components (inputs, menus, tooltips) draw from this, which is how they pick
 * up the editor's slate without per-component styling.
 */
export const darkScale: MantineColorsTuple = [
  colors.ink,
  colors.ink2,
  colors.ink3,
  colors.line2,
  colors.line,
  colors.panel2,
  colors.panel,
  colors.bg2,
  colors.bg,
  '#0f1115',
]

export const themeOverride: MantineThemeOverride = {
  colors: {
    dark: darkScale,
    accent: shades(colors.accent),
    warn: shades(colors.warn),
    ok: shades(colors.ok),
  },
  primaryColor: 'accent',
  primaryShade: { light: 6, dark: 5 },
  fontFamily: fonts.ui,
  fontFamilyMonospace: fonts.mono,
  fontSizes: {
    xs: `${fontSize - 2}px`,
    sm: `${fontSize - 1}px`,
    md: `${fontSize}px`,
    lg: `${fontSize + 2}px`,
    xl: `${fontSize + 5}px`,
  },
  radius: { sm: `${radius.sm}px`, md: `${radius.md}px` },
  defaultRadius: 'sm',
  spacing: Object.fromEntries(Object.entries(space).map(([k, v]) => [k, `${v}px`])),
  headings: { fontFamily: fonts.ui, fontWeight: '600' },
  cursorType: 'pointer',
}

/**
 * The resolved theme — the override merged over Mantine's defaults — so every
 * field is present and typed. The provider takes this; tests read from it.
 */
export const theme = mergeMantineTheme(DEFAULT_THEME, createTheme(themeOverride))

/**
 * The CSS custom properties the vocabulary publishes on `:root`. The new names
 * are the token names; the old names (`--bg`, `--panel`, `--text`, `--muted`,
 * `--accent`, `--warn`, `--danger`) are what the app's stylesheet still reads
 * today, kept during the transition so the legacy class rules pick up the
 * new palette immediately and can be deleted one at a time.
 */
export function cssVariables(): Record<string, string> {
  const c = colors
  return {
    '--ui-bg': c.bg,
    '--ui-bg-2': c.bg2,
    '--ui-panel': c.panel,
    '--ui-panel-2': c.panel2,
    '--ui-line': c.line,
    '--ui-line-2': c.line2,
    '--ui-ink': c.ink,
    '--ui-ink-2': c.ink2,
    '--ui-ink-3': c.ink3,
    '--ui-accent': c.accent,
    '--ui-accent-ink': c.accentInk,
    '--ui-warn': c.warn,
    '--ui-ok': c.ok,
    '--ui-font': fonts.ui,
    '--ui-font-mono': fonts.mono,
    // the frame's fixed dimensions, so the grid in styles.css reads them from here
    '--ui-top': `${frame.topBar}px`,
    '--ui-context': `${frame.contextBar}px`,
    '--ui-rail': `${frame.rail}px`,
    '--ui-inspector': `${frame.inspector}px`,
    '--ui-status': `${frame.statusBar}px`,
    // legacy names, read by apps/editor/src/editor/styles.css
    '--bg': c.bg,
    '--panel': c.panel,
    '--panel-2': c.panel2,
    '--line': c.line,
    '--text': c.ink,
    '--muted': c.ink3,
    '--accent': c.accent,
    '--warn': c.warn,
    '--danger': c.warn,
  }
}
