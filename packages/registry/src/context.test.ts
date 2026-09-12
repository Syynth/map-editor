import { describe, expect, it } from 'vitest'

import { always, and, defineContextKey, disjoint, dispose, evaluate, never, not, or, parsePredicate } from './index'

const KEYS = 'test:context:keys'
const tool = defineContextKey<'select' | 'raise' | 'paint'>(KEYS, 'test.context.tool', 'select')
const mode = defineContextKey<'edit' | 'play'>(KEYS, 'test.context.mode', 'edit')
const canUndo = defineContextKey(KEYS, 'test.context.canUndo', false)

describe('evaluate', () => {
  it('reads a key from the snapshot, falling back to its declared default', () => {
    expect(evaluate(tool.is('raise'), { [tool.id]: 'raise' })).toEqual({ available: true })
    expect(evaluate(tool.is('select'), {})).toEqual({ available: true })
    expect(evaluate(tool.is('raise'), {})).toMatchObject({ available: false })
  })

  it('combines with and / or / not', () => {
    const snapshot = { [tool.id]: 'raise', [mode.id]: 'edit', [canUndo.id]: true }
    expect(evaluate(and(tool.is('raise'), mode.is('edit')), snapshot).available).toBe(true)
    expect(evaluate(and(tool.is('raise'), mode.is('play')), snapshot).available).toBe(false)
    expect(evaluate(or(tool.is('paint'), canUndo.is(true)), snapshot).available).toBe(true)
    expect(evaluate(not(mode.is('play')), snapshot).available).toBe(true)
    expect(evaluate(mode.is('edit').not(), snapshot).available).toBe(false)
    expect(evaluate(always, snapshot).available).toBe(true)
    expect(evaluate(never, snapshot).available).toBe(false)
  })
})

describe('the reason a predicate fails', () => {
  it('names the key, the required value and the actual value for a leaf', () => {
    expect(evaluate(tool.is('raise'), { [tool.id]: 'paint' })).toEqual({
      available: false,
      reason: 'requires test.context.tool to be "raise" (it is "paint")',
    })
  })

  it('reports the first failing clause of an and, not the whole tree', () => {
    const p = and(mode.is('edit'), tool.is('raise'), canUndo.is(true))
    expect(evaluate(p, { [mode.id]: 'edit', [tool.id]: 'paint', [canUndo.id]: false })).toEqual({
      available: false,
      reason: 'requires test.context.tool to be "raise" (it is "paint")',
    })
  })

  it('reports every branch of a failed or, since all of them would have sufficed', () => {
    expect(evaluate(or(tool.is('raise'), canUndo.is(true)), { [tool.id]: 'paint' })).toEqual({
      available: false,
      reason: 'requires test.context.tool to be "raise" (it is "paint"), or requires test.context.canUndo to be true (it is false)',
    })
  })

  it('phrases a negated leaf as a prohibition', () => {
    expect(evaluate(mode.is('play').not(), { [mode.id]: 'play' })).toEqual({
      available: false,
      reason: 'requires test.context.mode not to be "play"',
    })
    expect(evaluate(never, {})).toEqual({ available: false, reason: 'never available' })
  })
})

describe('keys()', () => {
  it('lists the keys a predicate reads, sorted and without duplicates', () => {
    const p = or(and(tool.is('raise'), mode.is('edit')), and(tool.is('paint'), canUndo.is(true).not()))
    expect(p.keys()).toEqual(['test.context.canUndo', 'test.context.mode', 'test.context.tool'])
    expect(always.keys()).toEqual([])
  })
})

describe('serialisation', () => {
  it('round-trips through JSON and evaluates identically', () => {
    const p = or(and(tool.is('raise'), mode.is('edit')), canUndo.is(true).not())
    const stored = JSON.stringify({ when: p })
    const parsed: unknown = JSON.parse(stored)
    if (typeof parsed !== 'object' || parsed === null || !('when' in parsed)) throw new Error('bad round-trip')

    const back = parsePredicate(parsed.when)
    expect(back.node).toEqual(p.node)
    for (const snapshot of [{}, { [tool.id]: 'raise' }, { [canUndo.id]: true }, { [canUndo.id]: true, [tool.id]: 'raise' }])
      expect(evaluate(back, snapshot)).toEqual(evaluate(p, snapshot))
  })

  it('refuses a stored predicate that names a key nobody defined', () => {
    expect(() => parsePredicate({ op: 'is', key: 'test.context.nonexistent', value: 1 })).toThrow(/unknown context key/)
  })

  it('refuses malformed input rather than evaluating it', () => {
    expect(() => parsePredicate({ op: 'sometimes' })).toThrow(/unknown operator/)
    expect(() => parsePredicate({ op: 'and', of: 'not-an-array' })).toThrow(/expected an array/)
    expect(() => parsePredicate({ op: 'is', key: tool.id, value: { nested: true } })).toThrow(/string, number, boolean or null/)
    expect(() => parsePredicate(null)).toThrow(/expected a predicate node/)
  })
})

describe('defineContextKey', () => {
  it('refuses to define the same id twice', () => {
    expect(() => defineContextKey(KEYS, 'test.context.tool', 'select')).toThrow(/already defined/)
  })

  // The vocabulary used to be global and permanent, which made a feature
  // module's key a one-shot: the HMR re-import #21 §4 requires re-runs the
  // module, and the second `defineContextKey` threw on an id its own previous
  // incarnation had taken. Revoking with the owner is what makes a re-mint
  // legal, and the `parsePredicate` check is what proves the key is really
  // gone rather than merely unreferenced — a stored predicate naming it must
  // stop parsing.
  it('revokes a key with its owner, so the id can be minted again', () => {
    const owner = 'test:context:revoked'
    const flag = defineContextKey(owner, 'test.context.revoked', false)
    expect(parsePredicate(flag.is(true).toJSON()).keys()).toEqual(['test.context.revoked'])

    dispose(owner)

    expect(() => parsePredicate({ op: 'is', key: 'test.context.revoked', value: true })).toThrow(/unknown context key/)
    expect(() => defineContextKey(owner, 'test.context.revoked', false)).not.toThrow()
    dispose(owner)
  })

  // A revoked id is free for ANYBODY, not just its previous owner, and the
  // second owner's key is the one a predicate then reads — including its
  // default, which is the half a `parsePredicate` check cannot see.
  //
  // What this does NOT show, and did not when its name said otherwise: that a
  // stale teardown could take the second key down. `dispose` drops an owner's
  // teardown list before running it (`owners.ts`), so the second `dispose`
  // below returns at `if (!list) return` and runs nothing at all. That is the
  // reason the revocation in `context.ts` is unconditional: no teardown can
  // outlive the mint it belongs to, so there is nothing to guard against.
  it('lets a different owner mint a revoked id, with its own default', () => {
    const first = 'test:context:first'
    const second = 'test:context:second'
    defineContextKey(first, 'test.context.contested', 1)
    dispose(first)
    const live = defineContextKey(second, 'test.context.contested', 2)

    // `first` declared nothing else and has already been disposed, so this is
    // a no-op — asserted, because it is the shape a double HMR dispose takes.
    expect(() => dispose(first)).not.toThrow()

    expect(evaluate(live.is(2), {})).toEqual({ available: true })
    // The default is the SECOND key's: an empty snapshot reads 2, not 1.
    expect(evaluate(live.is(1), {})).toMatchObject({ available: false })
    dispose(second)
    expect(() => parsePredicate({ op: 'is', key: 'test.context.contested', value: 2 })).toThrow(/unknown context key/)
  })
})

/**
 * The prerequisite #14's conflict detection rests on, and the reason
 * availability is typed data rather than Blender's `poll()`: two arbitrary
 * functions can never be proven disjoint, two predicates over a declared
 * vocabulary can. The error is one-directional on purpose — `true` means
 * PROVEN, `false` means "overlapping, or not decided" — so every case below
 * that expects `false` is as load-bearing as the ones that expect `true`.
 */
describe('disjoint', () => {
  it('proves two values of one key can never both hold', () => {
    expect(disjoint(mode.is('edit'), mode.is('play'))).toBe(true)
    expect(disjoint(mode.is('edit'), mode.is('edit'))).toBe(false)
  })

  it('proves a predicate disjoint from its own negation, and never from itself', () => {
    expect(disjoint(canUndo.is(true), not(canUndo.is(true)))).toBe(true)
    expect(disjoint(tool.is('raise'), tool.is('raise').not())).toBe(true)
    expect(disjoint(tool.is('raise'), tool.is('raise'))).toBe(false)
  })

  it('says nothing is disjoint from `always`, and everything from `never`', () => {
    expect(disjoint(always, mode.is('edit'))).toBe(false)
    expect(disjoint(never, always)).toBe(true)
    expect(disjoint(never, never)).toBe(true)
  })

  it('sees through and / or rather than comparing shapes', () => {
    // Same key, contradictory clauses buried a level down.
    expect(disjoint(and(tool.is('raise'), mode.is('edit')), and(tool.is('raise'), mode.is('play')))).toBe(true)
    // Overlapping: `raise` in edit mode satisfies both.
    expect(disjoint(and(tool.is('raise'), mode.is('edit')), tool.is('raise'))).toBe(false)
    expect(disjoint(or(tool.is('raise'), tool.is('paint')), tool.is('select'))).toBe(true)
    expect(disjoint(or(tool.is('raise'), tool.is('paint')), tool.is('paint'))).toBe(false)
  })

  it('does not confuse two different keys holding the same value', () => {
    // Nothing stops `tool` being "edit"-ish and `mode` being edit at once:
    // they are separate keys, so the conjunction is satisfiable.
    expect(disjoint(mode.is('edit'), tool.is('raise'))).toBe(false)
  })

  it('reasons about a value nobody named, on a key whose domain is open', () => {
    // `tool` is a string key, so "not raise and not paint" is satisfiable by
    // a third value the predicate never mentions — the witness the search
    // carries. Getting this wrong would report a conflict as impossible.
    expect(disjoint(tool.is('raise').not(), tool.is('paint').not())).toBe(false)
  })

  it('is exact on a boolean key, whose domain is closed', () => {
    // No third value exists for a boolean, so "neither true nor false" is
    // unsatisfiable — which a witness-for-everything-else search would have
    // called satisfiable.
    expect(disjoint(and(canUndo.is(true).not(), canUndo.is(false).not()), always)).toBe(true)
  })
})
