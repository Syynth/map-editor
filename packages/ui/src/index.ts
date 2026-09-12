/**
 * The ui package's public surface — the editor's design vocabulary.
 *
 * Issue #12's rule: this is not "the package that contains Mantine", it is the
 * package that holds the vocabulary, and Mantine is an implementation detail of
 * it. The dependency on `@mantine/core` is declared here and nowhere else so
 * that boundary is stated before the first import exists; the eight primitives
 * below are still the hand-rolled ones, moved verbatim. Converting them — wrap
 * `Stack`/`Group`/`Panel` where the style prop IS the purpose, re-export
 * `Slider`/`NumberInput`/`Select` where it is incidental — is its own piece of
 * work, and mixing it into a move makes the diff unreviewable.
 *
 * Two things issue #12 puts here that are absent, deliberately:
 *
 * - The arrow to `@map-editor/registry` (declarations only, never handlers) is
 *   what makes a control able to resolve a command id to its title, icon and
 *   availability reason. `registry` does not exist yet, so the dependency is
 *   not declared — a faked one would claim a boundary nothing enforces.
 * - The primitives still render against class names defined in the app's
 *   `src/editor/styles.css`, which is one interleaved sheet with global element
 *   selectors. Prising their rules out is a rewrite of that sheet, not a move.
 *
 * Written out rather than `export *`, matching the other packages.
 */

export {
  ColorInput,
  Field,
  Note,
  NumberInput,
  Panel,
  Segmented,
  Select,
  Slider,
} from './primitives'

export { UiProvider } from './provider'
export { cssVariables, darkScale, shades, theme, themeOverride } from './theme'
export { colors, fontSize, fonts, frame, radius, space, tokens } from './tokens'
export type { Tokens } from './tokens'

