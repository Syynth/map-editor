/**
 * The chord grammar (#14).
 *
 * A binding's `chord` is a string because that is what a preferences file and
 * a keybinding editor hold, and this file is the only place that string is
 * given meaning. Everything here is pure and DOM-free: the parser takes a
 * spec plus a platform and answers with data, and the normaliser takes the
 * five fields a `KeyboardEvent` carries rather than the event, so `registry`
 * keeps compiling without `DOM` and a test needs no window.
 *
 * Three shapes, all of which #14 names:
 *
 *   - `mod+z` — `mod` is the platform's primary accelerator, `meta` on a Mac
 *     and `ctrl` everywhere else. It resolves at PARSE time, not at declare
 *     time, so one declaration serves both platforms and the same registry
 *     can be asked what a binding means on the other one.
 *   - `shift+alt+x` — modifiers in any order, the key last.
 *   - `ctrl+k ctrl+s` — a sequence: whitespace separates chords, and the
 *     resolver holds the prefix between keypresses.
 *
 * Keys are canonicalised toward the DOM's own spelling, lower-cased: `tab`,
 * `escape`, `arrowup`, `[`, `f5`. That is what `chordFromEvent` produces from
 * a real keypress, so the two halves meet without a translation table in the
 * middle; the aliases below exist only so a human may write `esc` or `up` in
 * a spec. The one departure is the space bar, whose `event.key` is a single
 * space — unwritable in a whitespace-separated sequence — so it is `space` on
 * both sides.
 */

export type Platform = 'mac' | 'other'

/** One keypress: the key, canonicalised, plus the four modifier flags a `KeyboardEvent` carries. */
export interface Chord {
  readonly key: string
  readonly ctrl: boolean
  readonly shift: boolean
  readonly alt: boolean
  readonly meta: boolean
}

/** What `chordFromEvent` reads. A DOM `KeyboardEvent` satisfies it structurally; a test can write one by hand. */
export interface KeyEventLike {
  readonly key: string
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
}

type ModifierName = 'ctrl' | 'shift' | 'alt' | 'meta' | 'mod'

const MODIFIERS: Readonly<Record<string, ModifierName>> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  opt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
  mod: 'mod',
}

/** Spellings a human may write, mapped to the DOM's. Everything else is already canonical once lower-cased. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  ins: 'insert',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  pgup: 'pageup',
  pgdn: 'pagedown',
  plus: '+',
}

/** `event.key` for the space bar is a single space, which cannot survive a whitespace-separated sequence. */
const SPACE = 'space'

/**
 * Whether a canonicalised key is a MODIFIER NAME rather than a key — the same
 * table `parseOne` refuses a spec's final token against, asked of a keypress
 * instead of a spec.
 *
 * A real `ctrl+k` is two `keydown` events, `Control` then `k`, and
 * `chordFromEvent` turns the first into `{ key: 'control' }`. No binding can
 * name it (the parse throws), so it can neither match nor prefix one — which
 * makes it indistinguishable from a miss to anything reading only the
 * resolution. A chord SEQUENCE has to tell them apart or the modifier keydown
 * that begins its second chord discards the first.
 */
export function isModifierKey(key: string): boolean {
  return MODIFIERS[key.toLowerCase()] !== undefined
}

/** The keypress a DOM event describes. Modifier keys report themselves (`shift`, `alt`), exactly as the old viewport listener did. */
export function chordFromEvent(event: KeyEventLike): Chord {
  return {
    key: event.key === ' ' ? SPACE : event.key.toLowerCase(),
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
  }
}

/**
 * `'ctrl++'` splits to `['ctrl', '', '']`: the `+` separator consumed the key
 * and left two empties behind. Nothing else produces a pair of trailing
 * empties, so collapsing them back into a literal `+` is unambiguous — and it
 * is the only place the separator and a key name collide.
 */
function segments(part: string): string[] {
  const tokens = part.split('+')
  const last = tokens.length - 1
  if (tokens.length >= 2 && tokens[last] === '' && tokens[last - 1] === '') tokens.splice(last - 1, 2, '+')
  return tokens
}

function parseOne(part: string, spec: string, platform: Platform): Chord {
  const tokens = segments(part.toLowerCase())
  let ctrl = false
  let shift = false
  let alt = false
  let meta = false

  for (let i = 0; i < tokens.length - 1; i += 1) {
    const modifier = MODIFIERS[tokens[i]]
    if (!modifier) throw new Error(`chord "${spec}": "${tokens[i]}" is not a modifier`)
    // `mod` is the whole reason parsing takes a platform: the SAME declaration
    // is cmd on a Mac and ctrl elsewhere, decided here rather than by whoever
    // wrote the binding.
    if (modifier === 'mod') {
      if (platform === 'mac') meta = true
      else ctrl = true
    } else if (modifier === 'ctrl') ctrl = true
    else if (modifier === 'shift') shift = true
    else if (modifier === 'alt') alt = true
    else meta = true
  }

  const tail = tokens[tokens.length - 1]
  if (tail === '') throw new Error(`chord "${spec}": missing a key`)
  // A modifier in the final position means the spec named no key at all —
  // `ctrl+shift` binds nothing, and reading it as the key `shift` would make
  // it silently unreachable instead of loudly wrong.
  if (tail !== '+' && MODIFIERS[tail]) throw new Error(`chord "${spec}": "${tail}" is a modifier, not a key`)
  return { key: KEY_ALIASES[tail] ?? tail, ctrl, shift, alt, meta }
}

/** Parse a spec into the sequence of chords it names. Throws: a malformed binding is a bug at declare time, not a miss at keypress time. */
export function parseChords(spec: string, platform: Platform): readonly Chord[] {
  const parts = spec.trim().split(/\s+/).filter((part) => part.length > 0)
  if (parts.length === 0) throw new Error(`chord "${spec}": empty`)
  return parts.map((part) => parseOne(part, spec, platform))
}

export function chordsEqual(a: Chord, b: Chord): boolean {
  return a.key === b.key && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta
}

/**
 * A canonical spelling for a spec, used to compare two DECLARATIONS without
 * committing to a platform (`keymap`'s conflict check). `mod` survives as
 * `mod`, deliberately: `mod+z` and `ctrl+z` are the same chord on Linux and
 * different ones on a Mac, and a declare-time check that depended on which
 * machine ran it would report a conflict in CI that the author cannot see.
 */
export function canonicalSpec(spec: string): string {
  const parts = spec.trim().split(/\s+/).filter((part) => part.length > 0)
  if (parts.length === 0) throw new Error(`chord "${spec}": empty`)
  return parts
    .map((part) => {
      const tokens = segments(part.toLowerCase())
      const tail = tokens[tokens.length - 1]
      const modifiers = tokens
        .slice(0, -1)
        .map((token) => MODIFIERS[token] ?? token)
        .sort()
      return [...new Set(modifiers), KEY_ALIASES[tail] ?? tail].join('+')
    })
    .join(' ')
}

const DISPLAY: Readonly<Record<string, string>> = { mac: '⌘', other: 'Meta' }

/** What a menu prints beside a command (#14's discovery half). */
export function formatChord(chord: Chord, platform: Platform): string {
  const parts: string[] = []
  if (chord.ctrl) parts.push(platform === 'mac' ? '⌃' : 'Ctrl')
  if (chord.alt) parts.push(platform === 'mac' ? '⌥' : 'Alt')
  if (chord.shift) parts.push(platform === 'mac' ? '⇧' : 'Shift')
  if (chord.meta) parts.push(DISPLAY[platform])
  parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key)
  return platform === 'mac' ? parts.join('') : parts.join('+')
}
