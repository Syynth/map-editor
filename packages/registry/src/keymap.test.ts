import { afterEach, describe, expect, it } from 'vitest'

import { chordFromEvent, parseChords, type Chord, type KeyEventLike } from './chords'
import { commands } from './commands'
import { and, defineContextKey, disjoint } from './context'
import { chordFor, createChordSession, keymap, resolve, type KeyBinding, type KeymapContext } from './keymap'
import { dispose } from './owners'

/**
 * The resolver takes its bindings and its snapshot as arguments, so almost
 * everything here hands it a literal list and a literal snapshot. The half it
 * does not take is the command's own `when`, which it reads from the command
 * registry — so the tests that exercise that, and the conflict tests, declare
 * into the module registries and dispose their owners afterwards.
 *
 * The vocabulary is minted once for the file. `mode` is a string key so the
 * satisfiability search has to reason about a value nobody named; `dirty` is
 * boolean, where the domain is closed.
 */
const OWNER = 'keymap-test'
const mode = defineContextKey<'edit' | 'play'>(OWNER, 'test.mode', 'edit')
const dirty = defineContextKey(OWNER, 'test.dirty', false)

const press = (spec: string): Chord => parseChords(spec, 'other')[0]

/** A `KeyboardEvent`'s five fields, so a test can hand the session what the dispatcher forwards rather than a chord it made up. */
const keydown = (key: string, held: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...held,
})

function context(bindings: readonly KeyBinding[], snapshot: KeymapContext['snapshot'] = {}): KeymapContext {
  return { bindings, snapshot }
}

function hit(bindings: readonly KeyBinding[], spec: string, snapshot: KeymapContext['snapshot'] = {}) {
  return resolve(context(bindings, snapshot), [], press(spec))
}

describe('resolution order', () => {
  it('scans in reverse, so the last binding declared wins', () => {
    const bindings: KeyBinding[] = [
      { chord: 'ctrl+z', command: 'core.undo' },
      { chord: 'ctrl+z', command: 'user.undo' },
    ]
    expect(hit(bindings, 'ctrl+z')).toMatchObject({ kind: 'dispatch', command: 'user.undo' })
  })

  it('orders by weight before declaration order, so a user binding appended first still wins', () => {
    keymap.declare(OWNER, { chord: 'ctrl+z', command: 'user.undo', weight: 'user' })
    keymap.declare(OWNER, { chord: 'ctrl+z', command: 'core.undo', weight: 'core' })
    expect(keymap.all().map((binding) => binding.command)).toEqual(['core.undo', 'user.undo'])
    expect(hit(keymap.all(), 'ctrl+z')).toMatchObject({ kind: 'dispatch', command: 'user.undo' })
  })

  it('carries the binding arguments through untouched', () => {
    const bindings: KeyBinding[] = [{ chord: ']', command: 'brush.resize', args: { by: 1 } }]
    expect(hit(bindings, ']')).toMatchObject({ kind: 'dispatch', command: 'brush.resize', args: { by: 1 } })
  })
})

describe('fall-through (#14: a false condition must not swallow the key)', () => {
  it('falls through a binding whose own `when` is false to the one underneath', () => {
    const bindings: KeyBinding[] = [
      { chord: 'g', command: 'core.grid' },
      { chord: 'g', command: 'tool.grab', when: mode.is('play') },
    ]
    expect(hit(bindings, 'g', { 'test.mode': 'play' })).toMatchObject({ command: 'tool.grab' })
    // The tool binding is scoped out, so the core one underneath is reachable
    // — the layering #14 says fall-through gives for free.
    expect(hit(bindings, 'g', { 'test.mode': 'edit' })).toMatchObject({ command: 'core.grid' })
  })

  it('reports `none` rather than consuming the key when everything bound to it is unavailable', () => {
    const bindings: KeyBinding[] = [{ chord: 'g', command: 'tool.grab', when: mode.is('play') }]
    expect(hit(bindings, 'g', { 'test.mode': 'edit' })).toEqual({ kind: 'none' })
  })

  it('ANDs the command’s own availability in, so two bindings need no scope of their own', () => {
    commands.declare(OWNER, { id: 'test.play', title: 'Play', when: mode.is('edit') })
    commands.declare(OWNER, { id: 'test.stop', title: 'Stop', when: mode.is('play') })
    const bindings: KeyBinding[] = [
      { chord: 'p', command: 'test.play' },
      { chord: 'p', command: 'test.stop' },
    ]
    // Reverse scan reaches `test.stop` first and falls through it: this is
    // the exact shape the editor's P key is declared in.
    expect(hit(bindings, 'p', { 'test.mode': 'edit' })).toMatchObject({ command: 'test.play' })
    expect(hit(bindings, 'p', { 'test.mode': 'play' })).toMatchObject({ command: 'test.stop' })
  })
})

describe('shadow versus unbind', () => {
  const lower: KeyBinding = { chord: 'ctrl+z', command: 'core.undo' }

  it('shadow consumes the key and leaves the rule underneath buried', () => {
    const result = hit([lower, { chord: 'ctrl+z', command: null }], 'ctrl+z')
    expect(result.kind).toBe('shadow')
  })

  it('unbind deletes the rule, so the one underneath becomes reachable', () => {
    const bindings: KeyBinding[] = [
      { chord: 'ctrl+z', command: 'deep.undo' },
      lower,
      { chord: 'ctrl+z', command: 'core.undo', unbind: true },
    ]
    expect(hit(bindings, 'ctrl+z')).toMatchObject({ kind: 'dispatch', command: 'deep.undo' })
  })

  it('unbind with a null command deletes every rule on the chord, and the key falls through', () => {
    const bindings: KeyBinding[] = [lower, { chord: 'ctrl+z', command: null, unbind: true }]
    expect(hit(bindings, 'ctrl+z')).toEqual({ kind: 'none' })
  })

  it('only reaches rules declared before it', () => {
    const bindings: KeyBinding[] = [
      { chord: 'ctrl+z', command: 'core.undo', unbind: true },
      lower,
    ]
    expect(hit(bindings, 'ctrl+z')).toMatchObject({ kind: 'dispatch', command: 'core.undo' })
  })

  it('matches the unbind by chord, not by spelling', () => {
    const bindings: KeyBinding[] = [{ chord: 'ctrl+z', command: 'core.undo' }, { chord: 'mod+z', command: 'core.undo', unbind: true }]
    // `mod` is ctrl on this platform, so the unbind finds it.
    expect(resolve({ bindings, snapshot: {}, platform: 'other' }, [], press('ctrl+z'))).toEqual({ kind: 'none' })
    expect(resolve({ bindings, snapshot: {}, platform: 'mac' }, [], press('ctrl+z'))).toMatchObject({ command: 'core.undo' })
  })
})

describe('sequences', () => {
  const bindings: KeyBinding[] = [{ chord: 'ctrl+k ctrl+s', command: 'keys.open' }]

  it('answers `pending` for a prefix and dispatches on the second chord', () => {
    const session = createChordSession(() => context(bindings))
    expect(session.press(press('ctrl+k'))).toEqual({ kind: 'pending' })
    expect(session.pending()).toHaveLength(1)
    expect(session.press(press('ctrl+s'))).toMatchObject({ kind: 'dispatch', command: 'keys.open' })
    expect(session.pending()).toHaveLength(0)
  })

  it('drops the sequence when the second chord matches nothing', () => {
    const session = createChordSession(() => context(bindings))
    session.press(press('ctrl+k'))
    expect(session.press(press('x'))).toEqual({ kind: 'none' })
    expect(session.pending()).toHaveLength(0)
  })

  it('does not offer a prefix whose binding is unavailable', () => {
    const scoped: KeyBinding[] = [{ chord: 'ctrl+k ctrl+s', command: 'keys.open', when: mode.is('play') }]
    expect(hit(scoped, 'ctrl+k', { 'test.mode': 'edit' })).toEqual({ kind: 'none' })
    expect(hit(scoped, 'ctrl+k', { 'test.mode': 'play' })).toEqual({ kind: 'pending' })
  })

  /**
   * The events the DISPATCHER actually forwards, not the synthetic chords the
   * tests above hand the session: `ctrl+k ctrl+s` typed with the modifier
   * RELEASED between the two chords is six events, two of which are bare
   * `Control` keydowns. Those matched no binding and were no prefix, so the
   * session read them as a miss and dropped the pending `ctrl+k`.
   */
  it('survives the bare modifier keydowns a real keyboard sends between the chords', () => {
    const session = createChordSession(() => context(bindings))
    const down = (key: string) => session.press(chordFromEvent(keydown(key, { ctrlKey: true })))

    // Press ctrl, press k, release both, press ctrl again, press s.
    expect(down('Control')).toEqual({ kind: 'none' })
    expect(down('k')).toEqual({ kind: 'pending' })
    expect(down('Control')).toEqual({ kind: 'none' })
    expect(session.pending()).toHaveLength(1)
    expect(down('s')).toMatchObject({ kind: 'dispatch', command: 'keys.open' })
  })

  it('does not consume a modifier keydown when no sequence is in flight', () => {
    const session = createChordSession(() => context(bindings))
    for (const key of ['Control', 'Shift', 'Alt', 'Meta'])
      expect(session.press(chordFromEvent(keydown(key)))).toEqual({ kind: 'none' })
    expect(session.pending()).toHaveLength(0)
  })

  it('resets on demand, so a half-typed sequence can be abandoned', () => {
    const session = createChordSession(() => context(bindings))
    session.press(press('ctrl+k'))
    session.reset()
    expect(session.pending()).toHaveLength(0)
    expect(session.press(press('ctrl+s'))).toEqual({ kind: 'none' })
  })
})

describe('conflict detection at declare time', () => {
  it('refuses two rules with the same chord and the same condition, naming both owners', () => {
    keymap.declare('owner-a', { chord: 'ctrl+b', command: 'a.thing', weight: 'feature' })
    expect(() => keymap.declare('owner-b', { chord: 'ctrl+b', command: 'b.thing', weight: 'feature' })).toThrow(
      /owner-a[\s\S]*owner-b/,
    )
  })

  it('allows the same chord under conditions that differ, which is how layering works', () => {
    expect(() => {
      keymap.declare('owner-c', { chord: 'ctrl+d', command: 'c.thing', when: mode.is('edit'), weight: 'feature' })
      keymap.declare('owner-d', { chord: 'ctrl+d', command: 'd.thing', when: mode.is('play'), weight: 'feature' })
    }).not.toThrow()
  })

  it('allows a user binding to override a core one on the same chord', () => {
    expect(() => {
      keymap.declare('owner-e', { chord: 'ctrl+e', command: 'core.thing', weight: 'core' })
      keymap.declare('owner-f', { chord: 'ctrl+e', command: 'user.thing', weight: 'user' })
    }).not.toThrow()
  })

  it('allows an unbind to name a chord something else already bound', () => {
    expect(() => {
      keymap.declare('owner-g', { chord: 'ctrl+g', command: 'g.thing', weight: 'feature' })
      keymap.declare('owner-h', { chord: 'ctrl+g', command: 'g.thing', unbind: true, weight: 'feature' })
    }).not.toThrow()
  })

  it('allows two identical rules whose shared condition can never hold', () => {
    // The one place `disjoint` does real work in the conflict check: the
    // chord, the weight and the condition are all identical and the commands
    // differ, which is the shape that throws — except that the condition is
    // unsatisfiable, so neither rule can ever fire and they cannot collide.
    const impossible = and(dirty.is(true), dirty.is(false))
    expect(disjoint(impossible, impossible)).toBe(true)
    expect(() => {
      keymap.declare('owner-i', { chord: 'ctrl+i', command: 'i.one', when: impossible, weight: 'feature' })
      keymap.declare('owner-j', { chord: 'ctrl+i', command: 'i.two', when: impossible, weight: 'feature' })
    }).not.toThrow()
  })

  it('refuses a chord that does not parse, at declare time rather than at the keypress', () => {
    expect(() => keymap.declare('owner-m', { chord: 'ctrl+', command: 'm.thing' })).toThrow(/missing a key/)
  })
})

describe('discovery', () => {
  it('reports the binding that would win for a command, and nothing once it is unbound', () => {
    keymap.declare('owner-k', { chord: 'ctrl+l', command: 'k.thing', weight: 'core' })
    expect(keymap.bindingFor('k.thing')?.chord).toBe('ctrl+l')

    keymap.declare('owner-l', { chord: 'ctrl+l', command: 'k.thing', unbind: true, weight: 'user' })
    expect(keymap.bindingFor('k.thing')).toBeUndefined()
  })

  it('reports nothing for a command nobody bound', () => {
    expect(keymap.bindingFor('nobody.bound.this')).toBeUndefined()
  })

  it('tells bindings of one command apart by their arguments', () => {
    keymap.declare('owner-k', { chord: 'v', command: 'k.tool', args: { tool: 'select' }, weight: 'core' })
    keymap.declare('owner-k', { chord: 't', command: 'k.tool', args: { tool: 'terrain' }, weight: 'core' })
    expect(keymap.bindingFor('k.tool', 'other', { tool: 'select' })?.chord).toBe('v')
    expect(keymap.bindingFor('k.tool', 'other', { tool: 'terrain' })?.chord).toBe('t')
    expect(keymap.bindingFor('k.tool', 'other', { tool: 'object' })).toBeUndefined()
    // Without arguments, the last binding of the command, as before.
    expect(keymap.bindingFor('k.tool')?.chord).toBe('t')
  })

  it('advertises the unconditional binding over a scoped one declared later', () => {
    keymap.declare('owner-k', { chord: 'v', command: 'k.tool', args: { tool: 'select' }, weight: 'core' })
    keymap.declare('owner-k', { chord: 'escape', command: 'k.tool', args: { tool: 'select' }, when: mode.is('play'), weight: 'core' })
    expect(keymap.bindingFor('k.tool', 'other', { tool: 'select' })?.chord).toBe('v')
    expect(chordFor('k.tool', { tool: 'select' }, 'other')).toBe('V')
    // A user preset appended last, unconditional, is what the tooltip shows.
    keymap.declare('owner-l', { chord: '1', command: 'k.tool', args: { tool: 'select' }, weight: 'user' })
    expect(chordFor('k.tool', { tool: 'select' }, 'other')).toBe('1')
  })

  it('falls back to the scoped binding when nothing unconditional binds the same thing', () => {
    keymap.declare('owner-k', { chord: 'escape', command: 'k.back', when: mode.is('play'), weight: 'core' })
    expect(chordFor('k.back', undefined, 'other')).toBe('escape')
    expect(chordFor('k.back', undefined, 'mac')).toBe('escape')
  })
})

describe('a real keypress', () => {
  it('resolves an event straight through, with no translation table in between', () => {
    const bindings: KeyBinding[] = [{ chord: 'mod+shift+z', command: 'redo' }]
    const event = { key: 'Z', ctrlKey: false, shiftKey: true, altKey: false, metaKey: true }
    expect(resolve({ bindings, snapshot: {}, platform: 'mac' }, [], chordFromEvent(event))).toMatchObject({ command: 'redo' })
    expect(resolve({ bindings, snapshot: {}, platform: 'other' }, [], chordFromEvent(event))).toEqual({ kind: 'none' })
  })
})

afterEach(() => {
  for (const owner of ['owner-a', 'owner-b', 'owner-c', 'owner-d', 'owner-e', 'owner-f', 'owner-g', 'owner-h', 'owner-i', 'owner-j', 'owner-k', 'owner-l', 'owner-m'])
    dispose(owner)
})
