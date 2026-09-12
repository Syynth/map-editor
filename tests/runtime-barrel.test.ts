import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * #34's house rule, held by a test instead of a reviewer (#50): a barrel
 * exports what has a consumer outside the package, plus the types needed to
 * name what those consumers receive.
 *
 * Only `runtime`'s barrel is checked. `document`'s barrel gave up the write
 * machinery when the document actor landed (#13: `History`, `applyPatches`,
 * `pruneNoops` and the `Patch` family are internal now) but still carries
 * exports with no outside consumer, so it is not held to this test yet; and
 * `geometry`'s surface was judged fine as is — both per #50. Add a package
 * here the day its barrel is meant to be narrow.
 *
 * "Consumer" means a file outside `packages/runtime` that imports the name
 * from `@map-editor/runtime`. Matching import statements rather than grepping
 * for the bare identifier is what keeps a comment or a same-named local in
 * another package from counting as a use. The shapes understood are the two
 * the barrel is written in — `export { a, b } from './x'` and
 * `export type { T } from './x'` — and the two import shapes consumers use;
 * anything else is reported rather than skipped, so a new shape cannot make
 * the test pass by being invisible to it.
 */

const ROOT = new URL('..', import.meta.url).pathname
const PACKAGE = 'packages/runtime'
const BARREL = `${PACKAGE}/src/index.ts`
const SPECIFIER = '@map-editor/runtime'

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** `a, type B, c as d` → `['a', 'B', 'c']` — the exported/imported name, before any alias. */
function namesIn(list: string): string[] {
  return list
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, ''))
    .filter((part) => part.length > 0)
    .map((part) => part.split(/\s+as\s+/)[0].trim())
}

function barrelExports(): { names: string[]; unreadable: string[] } {
  const source = stripComments(readFileSync(join(ROOT, BARREL), 'utf8'))
  const names: string[] = []
  const re = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'[^']+'/g
  for (const match of source.matchAll(re)) names.push(...namesIn(match[1]))
  const unreadable = source
    .replace(re, '')
    .split('\n')
    .filter((line) => /^\s*export\b/.test(line))
  return { names, unreadable }
}

function sourceFiles(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sourceFiles(path, into)
    else if (/\.(ts|tsx)$/.test(entry)) into.push(path)
  }
  return into
}

/** Every name imported from the barrel by a file outside the package, and any import shape this cannot read. */
function consumers(): { used: Set<string>; unreadable: string[] } {
  const used = new Set<string>()
  const unreadable: string[] = []
  const roots = ['apps', 'packages'].map((root) => join(ROOT, root))
  for (const file of roots.flatMap((root) => sourceFiles(root))) {
    const rel = relative(ROOT, file)
    if (rel.startsWith(PACKAGE + '/')) continue
    const source = stripComments(readFileSync(file, 'utf8'))
    const named = new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*'${SPECIFIER}'`, 'g')
    for (const match of source.matchAll(named)) for (const name of namesIn(match[1])) used.add(name)
    const other = new RegExp(`import\\s+(?!(?:type\\s+)?\\{)[^;\\n]*from\\s*'${SPECIFIER}'`, 'g')
    for (const match of source.matchAll(other)) unreadable.push(`${rel}: ${match[0].trim()}`)
  }
  return { used, unreadable }
}

describe(`${BARREL} exports only what has a consumer`, () => {
  const exported = barrelExports()
  const consumed = consumers()

  it('is written in shapes this test can read', () => {
    expect(exported.unreadable).toEqual([])
    expect(consumed.unreadable).toEqual([])
    expect(exported.names.length).toBeGreaterThan(0)
  })

  it('has no export that nothing outside the package imports', () => {
    const orphans = exported.names
      .filter((name) => !consumed.used.has(name))
      .map(
        (name) =>
          `${name} is exported from ${BARREL} but no file outside ${PACKAGE} imports it from '${SPECIFIER}': drop it from the barrel (its module still exports it), or add the consumer`,
      )
    expect(orphans).toEqual([])
  })
})
