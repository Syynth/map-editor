import { describe, expect, it } from 'vitest'

import { cssVariables, darkScale, shades, theme } from './theme'
import { colors, fonts } from './tokens'

describe('theme is generated from the tokens', () => {
  it('renders the accent the mockup specifies, at the shade Mantine will use in dark mode', () => {
    expect(theme.colors.accent[5]).toBe(colors.accent)
    expect(theme.primaryShade).toEqual({ light: 6, dark: 5 })
    expect(theme.primaryColor).toBe('accent')
  })

  it('builds ten shades, lighter before the base and darker after it', () => {
    const tuple = shades('#e9a23b')
    expect(tuple).toHaveLength(10)
    const lum = (hex: string) => Number.parseInt(hex.slice(1, 3), 16) + Number.parseInt(hex.slice(3, 5), 16) + Number.parseInt(hex.slice(5, 7), 16)
    for (let i = 1; i < 10; i++) expect(lum(tuple[i])).toBeLessThan(lum(tuple[i - 1]))
  })

  it("uses the token grounds and inks as Mantine's dark neutrals, brightest first", () => {
    expect(darkScale[0]).toBe(colors.ink)
    expect(darkScale[8]).toBe(colors.bg)
    expect(theme.colors.dark).toEqual(darkScale)
  })

  it('names the faces from the tokens', () => {
    expect(theme.fontFamily).toBe(fonts.ui)
    expect(theme.fontFamilyMonospace).toBe(fonts.mono)
  })

  it('publishes both the new and the legacy custom-property names, from the same values', () => {
    const vars = cssVariables()
    expect(vars['--ui-accent']).toBe(colors.accent)
    expect(vars['--accent']).toBe(colors.accent)
    expect(vars['--text']).toBe(colors.ink)
    expect(vars['--muted']).toBe(colors.ink3)
    expect(vars['--danger']).toBe(colors.warn)
  })
})
