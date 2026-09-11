/**
 * PROTOTYPE — throwaway. See issue #8.
 *
 * This file IS the question. The ticket says: "a vitest file that fires
 * commands by id at a document and asserts on the result — no React, no GL
 * context. This is the thing that has to feel cheap; if it does not, the
 * addressing decision is wrong."
 *
 * So read it as ergonomics evidence, not as test coverage. Every test below is
 * a claim about how the command layer feels to drive.
 */

import { describe, it, expect } from 'vitest'
import { EditorStore } from '../core/store'
import { createSampleMap } from '../core/sample'
import { createHost } from './host'
import { allCommands, lookup, evaluate, explain, disjoint, is, and, not, or, always } from './registry'
import './features'

/**
 * Note what the harness does NOT need: no React, no GL, no DOM, no fixtures.
 * A store and a host, and the tool is set by dispatching a real command rather
 * than by reaching into state — which is the ergonomics claim under test.
 */
const setup = (opts: { tool?: 'select' | 'raise' | 'paint'; documentOpen?: boolean } = {}) => {
  const store = new EditorStore(createSampleMap(32, 32))
  const host = createHost(store, { documentOpen: opts.documentOpen ?? true, hasSelection: false })
  host.dispatch('tool.select', { name: opts.tool ?? 'raise' })
  return { store, host }
}

describe('dispatching by id', () => {
  it('changes the document', () => {
    const { store, host } = setup()
    const before = store.revision

    const r = host.dispatch('terrain.raise', { cells: [[4, 4], [5, 4]], delta: 2 })

    expect(r.status).toBe('ok')
    expect(store.revision).toBeGreaterThan(before)
  })

  it('routes an editor-tier command without touching the document', () => {
    const { store, host } = setup()
    const before = store.revision

    expect(host.dispatch('tool.select', { name: 'paint' }).status).toBe('ok')

    expect(host.tool()).toBe('paint')
    expect(store.revision).toBe(before)
  })

  it('undoes what a command did', () => {
    const { store, host } = setup()
    const h0 = store.doc.terrain.height[4 * 32 + 4]

    host.dispatch('terrain.raise', { cells: [[4, 4]], delta: 3 })
    expect(store.doc.terrain.height[4 * 32 + 4]).toBe(h0 + 3)

    host.dispatch('edit.undo')
    expect(store.doc.terrain.height[4 * 32 + 4]).toBe(h0)
  })
})

describe('the three ways a dispatch does not happen', () => {
  it('unknown: the id was never declared', () => {
    const { host } = setup()
    expect(host.dispatch('terrain.melt')).toMatchObject({ status: 'unknown' })
  })

  it('unavailable: declared, but its predicate is false — and it says why', () => {
    const { host } = setup({ tool: 'select' })
    expect(host.dispatch('terrain.raise', { cells: [[1, 1]], delta: 1 })).toMatchObject({
      status: 'unavailable',
      why: expect.stringContaining('requires tool to be "raise"'),
    })
  })

  it('invalid: available, but the args do not match the schema', () => {
    const { host } = setup()
    expect(host.dispatch('terrain.raise', { cells: [[1, 1]], delta: 99 })).toMatchObject({
      status: 'invalid',
      why: expect.stringContaining('delta: must be <= 8'),
    })
  })

  it('unhandled: declared and available, but its feature is not running', () => {
    const { host } = setup()
    // `play.step` is declared with `when: always`. Nothing is playing.
    expect(host.dispatch('play.step', { frames: 1 })).toMatchObject({
      status: 'unhandled',
      why: expect.stringContaining('never been started'),
    })
  })
})

describe('a child actor with a lifetime', () => {
  it('the same command is unhandled, then handled, then unhandled again', () => {
    const { host } = setup()

    expect(host.dispatch('play.step', { frames: 1 }).status).toBe('unhandled')

    host.dispatch('play.start')
    expect(host.mode()).toBe('play')
    expect(host.dispatch('play.step', { frames: 2 }).status).toBe('ok')
    expect(host.playFrame()).toBe(2)

    host.dispatch('play.stop')
    expect(host.mode()).toBe('edit')
    expect(host.dispatch('play.step', { frames: 1 }).status).toBe('unhandled')
  })

  it('THE ONE THAT KILLS A v5 ROUTER: the host survives routing at a stopped child', () => {
    const { store, host } = setup()
    host.dispatch('play.start')
    host.dispatch('play.stop')

    // Route at the stopped child. On v5 this flips the HOST to status 'error'
    // and every later command is silently ignored.
    host.dispatch('play.step', { frames: 1 })

    expect(host.actor.getSnapshot().status).toBe('active')
    expect(host.deadLetters.at(-1)).toMatchObject({ reason: 'stopped' })

    // And the router still works afterwards — the real proof.
    const before = store.revision
    expect(host.dispatch('terrain.raise', { cells: [[2, 2]], delta: 1 }).status).toBe('ok')
    expect(store.revision).toBeGreaterThan(before)
  })
})

describe('the declaration registry, with nothing running', () => {
  it('enumerates every command before any actor exists', () => {
    // Note: no createHost() call in this test at all.
    const ids = allCommands().map((c) => c.id)
    expect(ids).toContain('terrain.raise')
    expect(ids).toContain('play.step')
    expect(allCommands().every((c) => c.title && c.category && c.feature)).toBe(true)
  })

  it('a palette can grey out a command and name the failing condition', () => {
    const { host } = setup({ tool: 'select' })
    const k = host.currentKeys()
    const rows = allCommands().map((c) => ({
      title: c.title,
      enabled: evaluate(c.when, k),
      why: explain(c.when, k),
    }))
    const undo = rows.find((r) => r.title === 'Undo')!
    expect(undo.enabled).toBe(false)
    expect(undo.why).toContain('requires canUndo to be true')
  })
})

describe('availability predicates are analysable, not just callable', () => {
  it('proves two predicates disjoint — which is what makes conflict detection possible', () => {
    expect(disjoint(is('tool', 'raise'), is('tool', 'paint'))).toBe(true)
    expect(disjoint(is('mode', 'edit'), is('mode', 'play'))).toBe(true)
    expect(disjoint(is('tool', 'raise'), not(is('tool', 'raise')))).toBe(true)
  })

  it('is conservative: unproven disjointness reports a possible conflict', () => {
    expect(disjoint(is('tool', 'raise'), is('canUndo', true))).toBe(false)
    expect(disjoint(always, always)).toBe(false)
  })

  it('sees through and/or nesting', () => {
    const inEdit = and(is('documentOpen', true), is('mode', 'edit'))
    const inPlay = and(is('documentOpen', true), is('mode', 'play'))
    expect(disjoint(inEdit, inPlay)).toBe(true)
    expect(disjoint(or(is('tool', 'raise'), is('tool', 'paint')), is('tool', 'select'))).toBe(true)
  })

  it('two real commands that share a key would conflict on the same chord', () => {
    const raise = lookup('terrain.raise')!
    const flatten = lookup('terrain.flatten')!
    // Same availability — so binding both to the same key IS a conflict.
    expect(disjoint(raise.when, flatten.when)).toBe(false)
  })
})

describe('one command with args, not N commands', () => {
  it('tool.select carries its variant as an argument', () => {
    const { host } = setup()
    for (const name of ['select', 'raise', 'paint'] as const) {
      expect(host.dispatch('tool.select', { name }).status).toBe('ok')
      expect(host.tool()).toBe(name)
    }
    // One declaration covers all three.
    expect(allCommands().filter((c) => c.id.startsWith('tool.')).length).toBe(1)
  })

  it('rejects a variant outside the schema', () => {
    const { host } = setup()
    expect(host.dispatch('tool.select', { name: 'sculpt' }).status).toBe('invalid')
  })
})
