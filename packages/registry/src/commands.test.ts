import type { StandardSchemaV1 } from '@standard-schema/spec'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { and, commands, defineContextKey, dispose, resolveCommand, validateArgs } from './index'

const tool = defineContextKey<'select' | 'raise' | 'paint'>('test.commands.tool', 'select')
const documentOpen = defineContextKey('test.commands.documentOpen', false)

const scratch: string[] = []
function owner(name: string): string {
  const id = `test:commands:${name}`
  scratch.push(id)
  return id
}
afterEach(() => {
  for (const id of scratch) dispose(id)
  scratch.length = 0
})

const raiseArgs = z.object({
  cells: z.array(z.tuple([z.number(), z.number()])),
  delta: z.number().int().min(-8).max(8).default(1),
})

describe('declare-time schema check (#23)', () => {
  it('refuses a Zod schema with an async refinement, and stores nothing', () => {
    const o = owner('async-zod')
    const schema = z.object({ name: z.string().optional() }).refine(async () => true)
    expect(() => commands.declare(o, { id: 'test.async.zod', title: 'Async', args: schema })).toThrow(/asynchronously/)
    expect(commands.get('test.async.zod')).toBeUndefined()
  })

  it('refuses an async field refinement and an async transform', () => {
    const o = owner('async-zod-shapes')
    const field = z.object({ name: z.string().default('x').refine(async () => true) })
    const transform = z.object({}).transform(async (v) => v)
    expect(() => commands.declare(o, { id: 'test.async.field', title: 'Async', args: field })).toThrow(/asynchronously/)
    expect(() => commands.declare(o, { id: 'test.async.transform', title: 'Async', args: transform })).toThrow(/asynchronously/)
  })

  it('cannot see an async refinement Zod skips because {} fails the shape — dispatch catches it instead', () => {
    // Measured on zod@4.6.2: with `name` required, `{}` yields a sync failure
    // and the refinement never runs, so the probe passes. The dispatch-time
    // guard is what holds the line in that case.
    const o = owner('async-slipped')
    const schema = z.object({ name: z.string() }).refine(async () => true)
    expect(() => commands.declare(o, { id: 'test.async.slipped', title: 'Slipped', args: schema })).not.toThrow()

    expect(resolveCommand('test.async.slipped', { name: 'x' }, {})).toEqual({
      ok: false,
      kind: 'invalid-args',
      issues: [{ path: [], message: 'argument schema validated asynchronously; async validators are not supported' }],
    })
  })

  it('refuses a hand-rolled validator that returns a Promise', () => {
    const o = owner('async-handrolled')
    const schema: StandardSchemaV1 = {
      '~standard': { version: 1, vendor: 'test', validate: (value) => Promise.resolve({ value }) },
    }
    expect(() => commands.declare(o, { id: 'test.async.handrolled', title: 'Async', args: schema })).toThrow(/asynchronously/)
  })

  it('accepts a synchronous schema', () => {
    const o = owner('sync')
    expect(() => commands.declare(o, { id: 'test.sync', title: 'Sync', args: raiseArgs })).not.toThrow()
  })
})

describe('resolveCommand', () => {
  it('returns the declaration and the schema-validated arguments, defaults filled', () => {
    const o = owner('ok')
    commands.declare(o, { id: 'test.raise', title: 'Raise', when: tool.is('raise'), args: raiseArgs })

    const r = resolveCommand('test.raise', { cells: [[1, 2]] }, { [tool.id]: 'raise' })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.command.id).toBe('test.raise')
    expect(r.args).toEqual({ cells: [[1, 2]], delta: 1 })
  })

  it('unknown: nobody declared the id', () => {
    expect(resolveCommand('test.never.declared', undefined, {})).toEqual({
      ok: false,
      kind: 'unknown',
      reason: 'no command is declared with id "test.never.declared"',
    })
  })

  it('unavailable: a false `when` says which clause failed and what the key actually is', () => {
    const o = owner('unavailable')
    commands.declare(o, {
      id: 'test.gated',
      title: 'Gated',
      when: and(documentOpen.is(true), tool.is('raise')),
    })

    // Both clauses false: the reason is the FIRST failing one, not a proof.
    expect(resolveCommand('test.gated', undefined, { [tool.id]: 'paint' })).toEqual({
      ok: false,
      kind: 'unavailable',
      reason: 'requires test.commands.documentOpen to be true (it is false)',
    })
    // First clause true: the reason moves to the second.
    expect(resolveCommand('test.gated', undefined, { [documentOpen.id]: true, [tool.id]: 'paint' })).toEqual({
      ok: false,
      kind: 'unavailable',
      reason: 'requires test.commands.tool to be "raise" (it is "paint")',
    })
  })

  it('invalid-args: issues carry the path of the offending field and a message', () => {
    const o = owner('invalid')
    commands.declare(o, { id: 'test.invalid', title: 'Invalid', args: raiseArgs })

    const r = resolveCommand('test.invalid', { cells: 'nope', delta: 99 }, {})

    expect(r.ok).toBe(false)
    if (r.ok || r.kind !== 'invalid-args') throw new Error(`expected invalid-args, got ${JSON.stringify(r)}`)
    const paths = r.issues.map((issue) => issue.path)
    expect(paths).toContainEqual(['cells'])
    expect(paths).toContainEqual(['delta'])
    for (const issue of r.issues) expect(issue.message).toMatch(/\S/)
  })

  it('invalid-args: a nested path names every segment', () => {
    const o = owner('nested')
    commands.declare(o, { id: 'test.nested', title: 'Nested', args: raiseArgs })

    const r = resolveCommand('test.nested', { cells: [[1, 'two']] }, {})

    if (r.ok || r.kind !== 'invalid-args') throw new Error(`expected invalid-args, got ${JSON.stringify(r)}`)
    expect(r.issues.map((issue) => issue.path)).toContainEqual(['cells', 0, 1])
  })

  it('checks availability before arguments, so a disabled command reports why it is disabled', () => {
    const o = owner('order')
    commands.declare(o, { id: 'test.order', title: 'Order', when: tool.is('raise'), args: raiseArgs })
    expect(resolveCommand('test.order', { cells: 'nope' }, { [tool.id]: 'select' })).toMatchObject({ kind: 'unavailable' })
  })
})

describe('validateArgs', () => {
  it('treats arguments to an argument-less command as an issue rather than dropping them', () => {
    const o = owner('argless')
    commands.declare(o, { id: 'test.argless', title: 'No args' })
    const decl = commands.get('test.argless')
    if (!decl) throw new Error('not declared')
    expect(validateArgs(decl, undefined)).toEqual({ ok: true, value: undefined })
    expect(validateArgs(decl, { stray: 1 })).toEqual({ ok: false, issues: [{ path: [], message: 'this command takes no arguments' }] })
  })

  it('reports a validator that goes async on a path the declare-time probe never reached, instead of hanging', () => {
    // Sync on `{}` (the probe), async on the one input that reaches the
    // refinement: the shape of a nested async refinement under a required key.
    const sneaky: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) =>
          typeof value === 'object' && value !== null && 'go' in value
            ? Promise.resolve({ value })
            : { issues: [{ message: 'missing go', path: ['go'] }] },
      },
    }
    const o = owner('sneaky')
    commands.declare(o, { id: 'test.sneaky', title: 'Sneaky', args: sneaky })

    const r = resolveCommand('test.sneaky', { go: true }, {})
    expect(r).toEqual({
      ok: false,
      kind: 'invalid-args',
      issues: [{ path: [], message: 'argument schema validated asynchronously; async validators are not supported' }],
    })
  })
})
