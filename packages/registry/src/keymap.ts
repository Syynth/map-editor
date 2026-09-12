/**
 * Keymap declarations and the resolver (#14, #5).
 *
 * A binding binds a chord to `(command id, args)` — never to a function, in
 * every editor surveyed (#5) — so the same tuple is a keymap entry, a menu
 * item's payload and a test's invocation. Unlike the other registries this is
 * an ordered LIST, not a map keyed by id: two bindings may carry the same
 * command with different arguments, and nothing about a binding is unique
 * (VS Code: "rules are a flat list").
 *
 * Four rules make the list a resolution, and every one of them is #14's:
 *
 * 1. ORDERED LIST, REVERSE SCAN, USER BINDINGS LAST. No specificity scoring
 *    and no resolution pass. Order is `weight` (`core` < `tool` < `feature` <
 *    `user`) and then declaration order inside a weight, so "the user's
 *    override wins" is literally "it is appended last".
 * 2. A BINDING WHOSE CONDITION IS FALSE FALLS THROUGH — it does not swallow
 *    the key. VS Code and Blender arrived at this independently (`continue`
 *    rather than `return null`; `PASS_THROUGH`), and it is what makes layered
 *    defaults work: a tool-specific binding that did not fall through would
 *    be a black hole over whatever the core layer bound underneath it. The
 *    condition is the binding's `when` AND the COMMAND's own `when`, which is
 *    why `p` can be two bindings — `mode.play` and `mode.edit`, each already
 *    gated on `host.mode` — with no scope written on either.
 * 3. UNBIND IS NOT SHADOW. `unbind` deletes an earlier rule, so whatever sat
 *    under it becomes reachable; a binding with `command: null` shadows —
 *    the chord is consumed and does nothing. Users want both, and the
 *    difference is invisible unless a lower rule exists.
 * 4. CONFLICT DETECTION AT DECLARE TIME, for identical `(chord, when)` only.
 *    #14 makes this contingent on availability being analysable, and it is
 *    (`disjoint`, in `context.ts`) — but the DEFAULT stays the narrow check:
 *    two rules that merely overlap are how layering works, while two rules
 *    with the same chord and the same condition disagreeing about what to run
 *    is nobody's intent. Scoped to one weight, because a `user` rule
 *    overriding a `core` one is the mechanism, not a mistake.
 *
 * `resolve` takes bindings, a context snapshot, the chords pressed so far and
 * the keypress, and answers with a decision — no clock and no DOM, so it is
 * testable as a table without a window. It is NOT pure: the AND half of rule 2
 * reads the COMMAND registry (`conditionOf`), so the same arguments resolve
 * differently as commands are declared and disposed. That module-global read
 * is what makes the `p` toggle work, and it is the one thing a table test has
 * to arrange rather than pass in. The chord-sequence state that `ctrl+k
 * ctrl+s` needs lives in `createChordSession`, which is the only stateful
 * thing here and holds nothing but an array of chords.
 */

import { canonicalSpec, chordsEqual, formatChord, isModifierKey, parseChords, type Chord, type Platform } from './chords'
import { commands } from './commands'
import { always, and, disjoint, evaluate, type ContextSnapshot, type Predicate } from './context'
import { onDispose, type OwnerId } from './owners'

/**
 * #14's weight enum, which is the whole ordering mechanism. `tool` sits
 * between `core` and `feature` for a binding that a tool contributes while it
 * is the active one; nothing declares at that weight yet.
 */
export type BindingWeight = 'core' | 'tool' | 'feature' | 'user'

const WEIGHTS: readonly BindingWeight[] = ['core', 'tool', 'feature', 'user']

export interface KeyBinding {
  /** The chord, as `chords.ts` parses it — `'mod+z'`, `'shift+alt+x'`, `'ctrl+k ctrl+s'`. Unparsed here: `mod` resolves per platform at resolve time. */
  readonly chord: string
  /**
   * The command to run, or `null` to SHADOW the chord: the key is consumed
   * and nothing happens. Shadowing is not unbinding — see `unbind`.
   */
  readonly command: string | null
  /** Plain serialisable data, validated against the command's schema at dispatch. */
  readonly args?: unknown
  /** Scope: where the binding is active. ANDed with the command's own `when` by the resolver. */
  readonly when?: Predicate
  /** Where in the layering this sits. Absent means `feature`, which is what a feature module contributes. */
  readonly weight?: BindingWeight
  /**
   * Delete earlier rules on this chord instead of adding one (VS Code's
   * `-command`). `command` names which to delete; `null` deletes every rule on
   * the chord. Applied at RESOLVE time against everything declared before it,
   * so a `user` unbind reaches a `core` rule and the rule beneath it — if any
   * — becomes reachable. That is the difference from a shadow, which leaves
   * the lower rule buried.
   */
  readonly unbind?: true
}

interface Entry {
  readonly owner: OwnerId
  readonly binding: KeyBinding
  readonly weight: BindingWeight
  readonly spec: string
  /** Declaration order, so the weight sort stays stable without depending on `Array.sort`'s. */
  readonly seq: number
}

const entries: Entry[] = []
let nextSeq = 0

/**
 * The chord a control should advertise for `(command, args)`, formatted for
 * the platform — what a tooltip or a menu item shows beside its name. The
 * LAST binding wins, matching the resolver's reverse scan, so a user preset
 * that rebinds a tool changes what the rail says without touching the tool.
 * `args` are compared structurally: a binding is `(id, args)`, and `tools.set
 * { tool: 'select' }` and `tools.set { tool: 'terrain' }` are different keys.
 * `undefined` when nothing binds it, which a control shows as no chord.
 */
export function chordFor(command: string, args: unknown, platform: Platform): string | undefined {
  const wanted = JSON.stringify(args ?? null)
  for (let index = entries.length - 1; index >= 0; index--) {
    const { binding } = entries[index]
    if (binding.unbind || binding.command !== command) continue
    if (JSON.stringify(binding.args ?? null) !== wanted) continue
    return parseChords(binding.chord, platform)
      .map((chord) => formatChord(chord, platform))
      .join(' ')
  }
  return undefined
}

/** Parsed chords are cached per `(spec, platform)`: resolution runs on every keypress and parsing is the only string work in it. */
const parsed = new Map<string, readonly Chord[]>()

function chordsOf(spec: string, platform: Platform): readonly Chord[] {
  const cacheKey = `${platform}:${spec}`
  const hit = parsed.get(cacheKey)
  if (hit) return hit
  const chords = parseChords(spec, platform)
  parsed.set(cacheKey, chords)
  return chords
}

/**
 * What actually gates a binding: its own scope AND the command's availability.
 * An undeclared command contributes nothing — declared-but-unhandled is a
 * legal state here and so is bound-before-declared, since a keymap file may
 * be read before the feature that implements it loads.
 */
function conditionOf(binding: KeyBinding): Predicate {
  const scope = binding.when ?? always
  if (binding.command === null) return scope
  const command = commands.get(binding.command)?.when
  return command ? and(scope, command) : scope
}

function sameTarget(a: KeyBinding, b: KeyBinding): boolean {
  return a.command === b.command && JSON.stringify(a.args ?? null) === JSON.stringify(b.args ?? null)
}

/**
 * #14's narrow check. Two rules conflict when they are the same chord at the
 * same weight under the same condition and disagree about what to run. An
 * unsatisfiable condition is exempt: `disjoint(c, c)` is true only when `c`
 * can never hold, and two rules that can never fire cannot collide.
 */
function conflict(entry: Entry, existing: Entry): boolean {
  if (existing.spec !== entry.spec || existing.weight !== entry.weight) return false
  if (sameTarget(existing.binding, entry.binding)) return false
  const condition = conditionOf(entry.binding)
  if (JSON.stringify(condition.toJSON()) !== JSON.stringify(conditionOf(existing.binding).toJSON())) return false
  return !disjoint(condition, condition)
}

function describe(binding: KeyBinding): string {
  if (binding.unbind) return binding.command === null ? 'unbind everything' : `unbind "${binding.command}"`
  return binding.command === null ? 'shadow' : `"${binding.command}"`
}

export const keymap = {
  /**
   * Register a binding under `owner`. An `unbind` entry is never checked for
   * conflict: deleting a rule is exactly the thing that is allowed to collide
   * with one.
   */
  declare(owner: OwnerId, binding: KeyBinding): void {
    // Parsed here and thrown away: a chord nobody can parse is a bug in the
    // declaration, and startup is a cheaper place to hear about it than the
    // keypress that silently never fires. The platform is immaterial —
    // `mod` is the only token that varies and it is legal on both — and the
    // parse is cached for the resolver that follows.
    chordsOf(binding.chord, 'other')
    const entry: Entry = {
      owner,
      binding,
      weight: binding.weight ?? 'feature',
      spec: canonicalSpec(binding.chord),
      seq: nextSeq,
    }
    nextSeq += 1
    if (!binding.unbind) {
      const clash = entries.find((existing) => !existing.binding.unbind && conflict(entry, existing))
      if (clash)
        throw new Error(
          `keybinding "${binding.chord}" is declared twice under the same condition: ${describe(clash.binding)} by owner "${clash.owner}", ${describe(binding)} by "${owner}"`,
        )
    }
    entries.push(entry)
    onDispose(owner, () => {
      const at = entries.indexOf(entry)
      if (at !== -1) entries.splice(at, 1)
    })
  },
  /** Every live binding, lowest weight first and declaration order inside a weight — the order `resolve` scans in reverse. */
  all(): readonly KeyBinding[] {
    return [...entries]
      .sort((a, b) => WEIGHTS.indexOf(a.weight) - WEIGHTS.indexOf(b.weight) || a.seq - b.seq)
      .map((entry) => entry.binding)
  },
  /**
   * The binding a menu prints beside a command (#14's discovery half): the
   * one that would win, which is the last surviving rule naming it. Unbinds
   * are applied first, so a command the user unbound reports nothing.
   */
  bindingFor(command: string, platform: Platform = 'other'): KeyBinding | undefined {
    const live = applyUnbinds(this.all(), platform)
    for (let i = live.length - 1; i >= 0; i -= 1) if (live[i].command === command) return live[i]
    return undefined
  },
}

/**
 * Delete what the `unbind` rules name. Forward pass, and each unbind only
 * reaches what was declared BEFORE it — the same direction the reverse scan
 * reads, so "later wins" and "later deletes" agree.
 */
function applyUnbinds(bindings: readonly KeyBinding[], platform: Platform): readonly KeyBinding[] {
  if (!bindings.some((binding) => binding.unbind)) return bindings
  const kept: KeyBinding[] = []
  for (const binding of bindings) {
    if (!binding.unbind) {
      kept.push(binding)
      continue
    }
    const target = chordsOf(binding.chord, platform)
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      if (binding.command !== null && kept[i].command !== binding.command) continue
      if (sequenceEqual(chordsOf(kept[i].chord, platform), target)) kept.splice(i, 1)
    }
  }
  return kept
}

function sequenceEqual(a: readonly Chord[], b: readonly Chord[]): boolean {
  return a.length === b.length && a.every((chord, i) => chordsEqual(chord, b[i]))
}

function isPrefix(prefix: readonly Chord[], of: readonly Chord[]): boolean {
  return prefix.length < of.length && prefix.every((chord, i) => chordsEqual(chord, of[i]))
}

/** What `resolve` reads. Supplied per keypress, never held: availability that is frozen goes stale (#8's finding 2). */
export interface KeymapContext {
  readonly bindings: readonly KeyBinding[]
  readonly snapshot: ContextSnapshot
  /** Absent means `'other'` — `mod` is `ctrl`. */
  readonly platform?: Platform
}

/**
 * What a keypress turned out to be.
 *
 * - `dispatch`: run this command. The caller consumes the key.
 * - `shadow`: a rule bound the chord to nothing. Consume the key, run nothing.
 * - `pending`: the chord starts a sequence. Consume the key and hold it.
 * - `none`: nothing matched, or everything that matched was unavailable. The
 *   key is NOT consumed — rule 2 above.
 */
export type KeyResolution =
  | { readonly kind: 'dispatch'; readonly binding: KeyBinding; readonly command: string; readonly args: unknown }
  | { readonly kind: 'shadow'; readonly binding: KeyBinding }
  | { readonly kind: 'pending' }
  | { readonly kind: 'none' }

/**
 * Resolve one keypress. No clock and no DOM, and `context` carries the
 * bindings, the snapshot and the platform, which is what makes the
 * fall-through and layering rules testable as a table. The one thing it does
 * NOT carry is the command's own `when`: `conditionOf` reads that from the
 * module-global command registry for the AND half of rule 2, so a table test
 * that depends on it must declare the command as well as pass the context.
 *
 * An exact match wins over a prefix, which is the one place this differs from
 * VS Code (where a chord prefix always wins and the complete binding under it
 * becomes unreachable). Reverse scan says the more recently declared, more
 * specific statement wins, and a binding that can never fire is the worse
 * failure of the two: the sequence can still be reached by rebinding its
 * prefix, while a shadowed complete binding cannot be reached at all.
 */
export function resolve(context: KeymapContext, chordsSoFar: readonly Chord[], press: Chord): KeyResolution {
  const platform = context.platform ?? 'other'
  const live = applyUnbinds(context.bindings, platform)
  const sequence = [...chordsSoFar, press]

  for (let i = live.length - 1; i >= 0; i -= 1) {
    const binding = live[i]
    if (!sequenceEqual(chordsOf(binding.chord, platform), sequence)) continue
    // THE FALL-THROUGH. `continue`, never `return`: an unavailable binding
    // yields to whatever is under it, and if nothing is, the key reaches the
    // browser untouched.
    if (!evaluate(conditionOf(binding), context.snapshot).available) continue
    return binding.command === null
      ? { kind: 'shadow', binding }
      : { kind: 'dispatch', binding, command: binding.command, args: binding.args }
  }

  for (let i = live.length - 1; i >= 0; i -= 1) {
    const binding = live[i]
    if (!isPrefix(sequence, chordsOf(binding.chord, platform))) continue
    if (!evaluate(conditionOf(binding), context.snapshot).available) continue
    return { kind: 'pending' }
  }

  return { kind: 'none' }
}

/** The chord-sequence state a multi-chord binding needs, and nothing else. */
export interface ChordSession {
  press(press: Chord): KeyResolution
  /** Abandon a half-typed sequence — what a focus change or an `escape` does. */
  reset(): void
  /** The chords held so far; empty unless a sequence is in progress. */
  pending(): readonly Chord[]
}

/**
 * The stateful wrapper around `resolve`. `read` is called per keypress rather
 * than captured, for the reason #8 gives about availability snapshots: the
 * context that gates a binding changes between keypresses, and a held copy
 * makes a command permanently unavailable.
 */
export function createChordSession(read: () => KeymapContext): ChordSession {
  let held: Chord[] = []
  return {
    press(press) {
      // A bare modifier keydown is not a keypress, it is the first half of
      // one: the browser fires `Control` on its own before the `ctrl+s` that
      // follows. `resolve` can only answer `none` for it — no binding may
      // name a modifier as its key — and reading that as a miss cleared the
      // pending prefix, which broke EVERY sequence unless the user held the
      // modifier down continuously across both chords. `none` without
      // touching `held` is the honest answer: nothing happened yet, and the
      // caller must not consume the key either.
      if (isModifierKey(press.key)) return { kind: 'none' }
      const resolution = resolve(read(), held, press)
      if (resolution.kind === 'pending') held = [...held, press]
      else held = []
      return resolution
    },
    reset() {
      held = []
    },
    pending: () => held,
  }
}
