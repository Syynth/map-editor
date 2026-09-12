import { describe, expect, it } from 'vitest'

import { canonicalSpec, chordFromEvent, chordsEqual, formatChord, parseChords, type Chord, type Platform } from './chords'

/**
 * The grammar is a pure function over strings, so it is tested as a table:
 * spec in, chords out, on both platforms. Everything the resolver does rests
 * on this, and a chord that parses one way in a preferences file and another
 * way at the keypress is the failure nobody can see.
 */
function chord(key: string, modifiers: Partial<Omit<Chord, 'key'>> = {}): Chord {
  return { key, ctrl: false, shift: false, alt: false, meta: false, ...modifiers }
}

describe('chord grammar', () => {
  const cases: Array<[string, Platform, Chord[]]> = [
    ['z', 'other', [chord('z')]],
    ['Z', 'other', [chord('z')]],
    ['ctrl+z', 'other', [chord('z', { ctrl: true })]],
    ['shift+alt+x', 'other', [chord('x', { shift: true, alt: true })]],
    ['alt+shift+x', 'other', [chord('x', { shift: true, alt: true })]],
    ['cmd+s', 'other', [chord('s', { meta: true })]],
    ['option+e', 'mac', [chord('e', { alt: true })]],
    ['ctrl+k ctrl+s', 'other', [chord('k', { ctrl: true }), chord('s', { ctrl: true })]],
    ['g r', 'other', [chord('g'), chord('r')]],
    ['tab', 'other', [chord('tab')]],
    ['esc', 'other', [chord('escape')]],
    ['up', 'other', [chord('arrowup')]],
    ['[', 'other', [chord('[')]],
    ['ctrl++', 'other', [chord('+', { ctrl: true })]],
    ['+', 'other', [chord('+')]],
    ['f5', 'other', [chord('f5')]],
    ['space', 'other', [chord('space')]],
  ]

  for (const [spec, platform, expected] of cases) {
    it(`parses "${spec}" on ${platform}`, () => {
      expect(parseChords(spec, platform)).toEqual(expected)
    })
  }

  it('maps `mod` to the platform accelerator, and nothing else about the chord changes', () => {
    expect(parseChords('mod+z', 'mac')).toEqual([chord('z', { meta: true })])
    expect(parseChords('mod+z', 'other')).toEqual([chord('z', { ctrl: true })])
    expect(parseChords('mod+shift+k k', 'mac')).toEqual([chord('k', { meta: true, shift: true }), chord('k')])
  })

  it('refuses a spec that names no key, rather than reading the modifier as one', () => {
    expect(() => parseChords('ctrl+shift', 'other')).toThrow(/is a modifier, not a key/)
    expect(() => parseChords('ctrl+', 'other')).toThrow(/missing a key/)
    expect(() => parseChords('   ', 'other')).toThrow(/empty/)
    expect(() => parseChords('hyper+z', 'other')).toThrow(/not a modifier/)
  })

  it('reads a keypress into the same spelling a spec parses to', () => {
    expect(chordFromEvent({ key: 'Z', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })).toEqual(
      chord('z', { ctrl: true }),
    )
    // Shift+Z reports the upper-case key AND the flag; lower-casing is what
    // makes `ctrl+shift+z` match the same chord the spec parses to.
    expect(chordFromEvent({ key: 'Z', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false })).toEqual(
      chord('z', { ctrl: true, shift: true }),
    )
    expect(chordFromEvent({ key: 'Tab', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })).toEqual(chord('tab'))
    expect(chordFromEvent({ key: 'ArrowUp', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })).toEqual(
      chord('arrowup'),
    )
    // The one key whose DOM spelling cannot survive a whitespace-separated
    // sequence, so both halves agree on `space` instead.
    expect(chordFromEvent({ key: ' ', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })).toEqual(chord('space'))
  })

  it('round-trips every spec in the table through an event', () => {
    for (const [spec, platform, expected] of cases) {
      if (expected.length !== 1) continue
      const [only] = parseChords(spec, platform)
      const event = { key: only.key === 'space' ? ' ' : only.key, ctrlKey: only.ctrl, shiftKey: only.shift, altKey: only.alt, metaKey: only.meta }
      expect(chordsEqual(chordFromEvent(event), only), spec).toBe(true)
    }
  })

  it('canonicalises a spec without committing to a platform', () => {
    expect(canonicalSpec('Alt+Shift+X')).toBe(canonicalSpec('shift+alt+x'))
    expect(canonicalSpec('cmd+s')).toBe(canonicalSpec('meta+s'))
    expect(canonicalSpec('esc')).toBe(canonicalSpec('escape'))
    // `mod` survives as itself: on a Mac it is not `ctrl`, so a declare-time
    // comparison that resolved it would depend on the machine running it.
    expect(canonicalSpec('mod+z')).not.toBe(canonicalSpec('ctrl+z'))
  })

  it('formats a chord for a menu', () => {
    expect(formatChord(chord('z', { meta: true }), 'mac')).toBe('⌘Z')
    expect(formatChord(chord('z', { ctrl: true, shift: true }), 'other')).toBe('Ctrl+Shift+Z')
    expect(formatChord(chord('tab'), 'other')).toBe('tab')
  })
})
