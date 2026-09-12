import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * #64 review: `xstate@6.0.0-alpha.53` sat in `minimumReleaseAgeExclude`
 * guarding nothing — `git grep xstate -- '**\/package.json'` and
 * `grep xstate pnpm-lock.yaml` both returned nothing, so pnpm's lockfile
 * re-verification never reaches that entry; an exclude that re-verifies
 * nothing is exactly the silent drift #39 was opened to close. This walks
 * every entry in the list and confirms it names a version pnpm-lock.yaml
 * actually records (the lockfile spells a pinned version `<name>@<version>:`),
 * so a stale exclude fails loudly here instead of sitting there unnoticed.
 */
describe('pnpm-workspace minimumReleaseAgeExclude', () => {
  const workspace = readFileSync(join(import.meta.dirname, '../pnpm-workspace.yaml'), 'utf8')
  const lockfile = readFileSync(join(import.meta.dirname, '../pnpm-lock.yaml'), 'utf8')

  const listMatch = workspace.match(/minimumReleaseAgeExclude:\n((?:[ \t]+-[ \t]+.+\n?)+)/)
  if (!listMatch) throw new Error('minimumReleaseAgeExclude list not found in pnpm-workspace.yaml')
  const entries = listMatch[1]
    .split('\n')
    .filter((line) => line.trim().startsWith('-'))
    .map((line) =>
      line
        .replace(/^[ \t]*-[ \t]*/, '')
        .replace(/^['"]|['"]$/g, '')
        .trim(),
    )

  it('has at least one entry', () => {
    expect(entries.length).toBeGreaterThan(0)
  })

  it.each(entries)('%s guards a real lockfile entry', (entry) => {
    // A scoped name (leading `@`) is a YAML key that needs quoting
    // (`'@types/three@0.186.0':`); an unscoped one is written bare
    // (`vitest@5.0.0:`) — accept either so this isn't tied to which shape
    // the lockfile happens to pick for a given package name.
    const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`^\\s*['"]?${escaped}['"]?:`, 'm')
    expect(lockfile).toMatch(pattern)
  })
})
