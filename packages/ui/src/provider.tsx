/**
 * The one place the editor mounts Mantine. Everything in the vocabulary
 * renders inside this: it supplies the theme generated from the tokens, loads
 * the two faces the tokens name, and publishes the tokens as CSS custom
 * properties on `:root` so the app's remaining class-based styles read the
 * same palette while they are being retired.
 */

// Mantine's base stylesheet is not imported from this module. It is the first
// line of `styles.css` next door, which an app loads as
// `@papercut/ui/styles.css` — a CSS `@import` resolved from this package's
// own directory, which is the only place `@mantine/core` resolves (#12). A
// side-effect `.css` import from a `.tsx` would instead be bundled away by
// tsup into a file nothing loads.

import { MantineProvider } from '@mantine/core'
import type { ReactNode } from 'react'

import { cssVariables, theme } from './theme'
import { fonts } from './tokens'

function rootVariables(): string {
  const body = Object.entries(cssVariables())
    .map(([name, value]) => `${name}: ${value};`)
    .join(' ')
  return `:root { ${body} color-scheme: dark; }`
}

export function UiProvider({ children }: { children: ReactNode }) {
  return (
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <link rel="stylesheet" href={fonts.stylesheet} />
      <style>{rootVariables()}</style>
      {children}
    </MantineProvider>
  )
}
