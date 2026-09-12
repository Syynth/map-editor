import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * #37's `rules-of-hooks` block originally scoped `files: ['**\/*.tsx']`.
 * `rules-of-hooks` keys off `use*`/component naming, not the file extension,
 * so a custom hook written in a plain `.ts` file (no JSX) violated it
 * invisibly — confirmed live with `eslint --print-config` and by running
 * `eslint` against a real conditional-hook fixture: the `.tsx` copy errored,
 * the `.ts` copy lint-clean. Widened to `**\/*.{ts,tsx}` (#64 review) so a
 * hook is checked no matter which extension it lives in.
 *
 * This test does NOT run `eslint` against a fixture written into
 * `apps/editor/src`, and does not `import()` `eslint.config.js` either: the
 * former races turbo's concurrently-running `//:lint` (`eslint .`), which
 * scans that same tree and can catch the fixture mid-existence — an
 * intermittent gate failure with nothing wrong in either task; the latter
 * fails `tsc` (TS7016), since the root tsconfig deliberately has no `allowJs`
 * (see its own comment on `scripts`) and an untyped `.js` import is an
 * implicit `any` under `strict`. Instead this reads the config file's own
 * source text, extracts the `files` array literal from the exact block that
 * sets `react-hooks/rules-of-hooks`, and matches it against representative
 * filenames the way ESLint would at lint time.
 */

// A glob matcher sized for exactly the shapes this repo's flat config uses
// (`**/`, a single `*`, and a `{a,b}` alternation) — not a general-purpose
// implementation, since the point is to check the *actual* pattern in
// eslint.config.js rather than to re-implement minimatch.
function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*' && glob[i + 1] === '*') {
      source += '.*'
      i++
      if (glob[i + 1] === '/') i++
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '{') {
      const close = glob.indexOf('}', i)
      source += `(?:${glob.slice(i + 1, close).split(',').join('|')})`
      i = close
    } else if ('.+^$()|[]\\'.includes(char)) {
      source += `\\${char}`
    } else {
      source += char
    }
  }
  return new RegExp(`^${source}$`)
}

function matchesSomeGlob(globs: readonly string[], filePath: string): boolean {
  return globs.some((glob) => globToRegExp(glob).test(filePath))
}

describe('react-hooks/rules-of-hooks glob', () => {
  it('checks a custom hook written in a plain .ts file, not only .tsx', () => {
    const source = readFileSync(join(import.meta.dirname, '../eslint.config.js'), 'utf8')
    const blockMatch = source.match(/files: (\[[^\]]*\]),\s*\n\s*plugins: \{ 'react-hooks': reactHooks \}/)
    if (!blockMatch) throw new Error('react-hooks/rules-of-hooks block not found in eslint.config.js')
    const globs = JSON.parse(blockMatch[1].replace(/'/g, '"')) as string[]

    expect(matchesSomeGlob(globs, 'apps/editor/src/useThing.ts')).toBe(true)
    expect(matchesSomeGlob(globs, 'apps/editor/src/App.tsx')).toBe(true)
    expect(matchesSomeGlob(globs, 'apps/editor/src/useThing.js')).toBe(false)
  })
})
