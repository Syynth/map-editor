import { describe, expect, it } from 'vitest'

import { always, and, defineContextKey, evaluate, never, not, or, parsePredicate } from './index'

const tool = defineContextKey<'select' | 'raise' | 'paint'>('test.context.tool', 'select')
const mode = defineContextKey<'edit' | 'play'>('test.context.mode', 'edit')
const canUndo = defineContextKey('test.context.canUndo', false)

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
    expect(() => defineContextKey('test.context.tool', 'select')).toThrow(/already defined/)
  })
})
