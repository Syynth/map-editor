import { afterEach, describe, expect, it } from 'vitest'

import {
  commands,
  defineContextKey,
  dispose,
  isReservedOwner,
  keymap,
  onDispose,
  panels,
  reserveOwner,
  tools,
} from './index'

// Declared at module scope, on purpose: this file IS the "enumerable before
// any actor exists" claim. Nothing below spawns anything, and the first test
// reads what import time left behind.
const importTime = 'test:import-time'
const mode = defineContextKey<'edit' | 'play'>(importTime, 'test.registry.mode', 'edit')
commands.declare(importTime, { id: 'test.import.command', title: 'Import-time command', when: mode.is('edit') })
tools.declare(importTime, { id: 'test.import.tool', title: 'Import-time tool' })
panels.declare(importTime, { id: 'test.import.panel', title: 'Import-time panel', component: 'opaque' })
keymap.declare(importTime, { chord: 'ctrl+i', command: 'test.import.command' })

// Each test picks its own owner id; the ones that are not reserved are
// disposed here so a failure in one cannot leak declarations into the next.
const scratch: string[] = []
function owner(name: string): string {
  const id = `test:${name}`
  scratch.push(id)
  return id
}
afterEach(() => {
  for (const id of scratch) if (!isReservedOwner(id)) dispose(id)
  scratch.length = 0
})

describe('declaration registries', () => {
  it('are enumerable at import time, before any actor exists', () => {
    expect(commands.all().map((c) => c.id)).toContain('test.import.command')
    expect(tools.all().map((t) => t.id)).toContain('test.import.tool')
    expect(panels.all().map((p) => p.id)).toContain('test.import.panel')
    expect(keymap.all()).toContainEqual({ chord: 'ctrl+i', command: 'test.import.command' })
    expect(commands.get('test.import.command')?.title).toBe('Import-time command')
    expect(commands.ownerOf('test.import.command')).toBe(importTime)
  })

  it('dispose(owner) removes everything that owner declared, and nothing else', () => {
    const a = owner('dispose-a')
    const b = owner('dispose-b')
    commands.declare(a, { id: 'test.a.cmd', title: 'A' })
    tools.declare(a, { id: 'test.a.tool', title: 'A tool' })
    panels.declare(a, { id: 'test.a.panel', title: 'A panel', component: null })
    keymap.declare(a, { chord: 'a', command: 'test.a.cmd' })
    commands.declare(b, { id: 'test.b.cmd', title: 'B' })
    keymap.declare(b, { chord: 'b', command: 'test.b.cmd' })

    dispose(a)

    expect(commands.get('test.a.cmd')).toBeUndefined()
    expect(tools.get('test.a.tool')).toBeUndefined()
    expect(panels.get('test.a.panel')).toBeUndefined()
    expect(keymap.all().some((k) => k.command === 'test.a.cmd')).toBe(false)
    expect(commands.ownerOf('test.a.cmd')).toBeUndefined()

    expect(commands.get('test.b.cmd')?.title).toBe('B')
    expect(keymap.all()).toContainEqual({ chord: 'b', command: 'test.b.cmd' })
  })

  it('frees an id for re-declaration once its owner is disposed', () => {
    const first = owner('redeclare-1')
    const second = owner('redeclare-2')
    commands.declare(first, { id: 'test.redeclare', title: 'First' })
    dispose(first)
    expect(() => commands.declare(second, { id: 'test.redeclare', title: 'Second' })).not.toThrow()
    expect(commands.ownerOf('test.redeclare')).toBe(second)
  })

  it('runs onDispose hooks most-recent-first and treats an unknown owner as a no-op', () => {
    const o = owner('hooks')
    const order: string[] = []
    onDispose(o, () => order.push('first'))
    onDispose(o, () => order.push('second'))
    dispose(o)
    expect(order).toEqual(['second', 'first'])
    expect(() => dispose('test:never-declared-anything')).not.toThrow()
  })
})

describe('reserved owners', () => {
  it('cannot be disposed, and their declarations survive the attempt', () => {
    const builtin = reserveOwner(owner('builtin'))
    commands.declare(builtin, { id: 'test.builtin.cmd', title: 'Built-in' })

    expect(() => dispose(builtin)).toThrow(/reserved/)
    expect(commands.get('test.builtin.cmd')?.title).toBe('Built-in')
    expect(isReservedOwner(builtin)).toBe(true)
  })

  it('cannot be reserved twice', () => {
    const id = reserveOwner(owner('reserve-twice'))
    expect(() => reserveOwner(id)).toThrow(/already reserved/)
  })
})

describe('conflicting declarations', () => {
  it('throws when a second owner declares an id the first still holds, naming both', () => {
    const a = owner('conflict-a')
    const b = owner('conflict-b')
    commands.declare(a, { id: 'test.conflict', title: 'A' })
    expect(() => commands.declare(b, { id: 'test.conflict', title: 'B' })).toThrow(/test\.conflict.*test:conflict-a.*test:conflict-b/)
    // The loser left no trace: the original is intact and still A's.
    expect(commands.get('test.conflict')?.title).toBe('A')
    expect(commands.ownerOf('test.conflict')).toBe(a)
  })

  it('throws for the same owner too — a duplicate is a duplicate', () => {
    const a = owner('conflict-same')
    tools.declare(a, { id: 'test.conflict.tool', title: 'T' })
    expect(() => tools.declare(a, { id: 'test.conflict.tool', title: 'T again' })).toThrow(/already declared/)
  })
})
