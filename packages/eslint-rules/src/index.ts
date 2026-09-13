import type { ESLint } from 'eslint'

// The register of machine-checked constraints (issue #20): a constraint that has
// a rule file here is checked, one that does not is prose and therefore
// advisory. There is no third list to drift out of sync with this one.
//
// Empty on purpose. The two rules this package exists for — `enq` purity (#22)
// and no-styles-outside-`packages/ui` (#12) — are separately owned and
// deliberately not stubbed here, because a stub that always passes is
// indistinguishable from a rule that has stopped firing.
//
// Consumed as source rather than build output: the export map points at
// `src/index.ts` and Node 26 strips the types on load, so `eslint.config.js`
// needs no build step ahead of it. `erasableSyntaxOnly` in this package's
// tsconfig is what keeps that true — it fails the typecheck on any syntax Node
// cannot simply erase.
export const rules: NonNullable<ESLint.Plugin['rules']> = {}

export const plugin: ESLint.Plugin = {
  meta: { name: '@papercut/eslint-rules', version: '0.0.0' },
  rules,
}
