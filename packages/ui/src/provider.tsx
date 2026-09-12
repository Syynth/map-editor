/**
 * The one place the editor mounts Mantine. Everything in the vocabulary
 * renders inside this: it supplies the theme generated from the tokens, loads
 * the two faces the tokens name, and publishes the tokens as CSS custom
 * properties on `:root` so the app's remaining class-based styles read the
 * same palette while they are being retired.
 */

// Mantine's base stylesheet is NOT imported yet. It has to be imported from
// this package (#12: only `ui` depends on Mantine — the app cannot resolve
// it, by design), but a side-effect `.css` import here has no module shape
// for the consumers that compile this file under their own tsconfig, and
// there are no project references until #46 lands. Until then the provider
// supplies the theme and the CSS variables; Mantine-backed primitives follow
// the moment #46 merges.

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
