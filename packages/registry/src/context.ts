/**
 * The availability predicate DSL (#5, #8, #3's handoff).
 *
 * Availability is a closed, analysable predicate language over a declared
 * vocabulary of context keys — not arbitrary functions. Blender's `poll()` is a
 * function, so two operators' availability can never be proven disjoint and
 * keymap conflict detection is impossible in principle; VS Code's `when` is a
 * parsed string, analysable but stringly-typed. This is the third option: typed
 * data. A predicate can only ever mention a key minted by `defineContextKey`,
 * so an undeclared key is a type error at the call site and a parse error in
 * a preferences file, and two predicates can be compared symbolically instead
 * of being run.
 *
 * Three consumers shape the surface:
 *   - a disabled control must say WHY (standing constraint), so evaluation
 *     returns a reason, not a boolean;
 *   - a palette re-evaluates only what changed, so a predicate lists the keys
 *     it depends on (`keys()`, VS Code's invalidation shape);
 *   - a future preferences file stores predicates, so a predicate serialises
 *     to plain JSON (`toJSON`) and parses back against the live vocabulary.
 *
 * The scoped holder that reads focus from the DOM lives in `ui`, not here (#3):
 * this file is the pure resolver and compiles without `DOM`.
 */

import { onDispose, type OwnerId } from './owners'

/** Values a key may take: JSON scalars, so a snapshot and a predicate both serialise as-is. */
export type KeyValue = string | number | boolean | null

/**
 * The serialisable form of a predicate. `is` is the only leaf that reads a
 * key, which is what keeps `disjoint`-style analysis to one base case.
 */
export type PredicateNode =
  | { readonly op: 'always' }
  | { readonly op: 'never' }
  | { readonly op: 'is'; readonly key: string; readonly value: KeyValue }
  | { readonly op: 'not'; readonly of: PredicateNode }
  | { readonly op: 'and'; readonly of: readonly PredicateNode[] }
  | { readonly op: 'or'; readonly of: readonly PredicateNode[] }

export interface Predicate {
  readonly node: PredicateNode
  not(): Predicate
  /** The key ids this predicate reads, sorted and unique — the invalidation set. */
  keys(): readonly string[]
  /** `JSON.stringify` hook, so a predicate drops into a preferences file unchanged. */
  toJSON(): PredicateNode
}

export interface ContextKey<T extends KeyValue> {
  readonly id: string
  /** What the key reads as when a snapshot does not carry it. */
  readonly defaultValue: T
  is(value: T): Predicate
}

/** The live values, keyed by key id. An absent key reads as its default. */
export type ContextSnapshot = Readonly<Record<string, KeyValue>>

export type Availability = { readonly available: true } | { readonly available: false; readonly reason: string }

const definedKeys = new Map<string, ContextKey<KeyValue>>()

function wrap(node: PredicateNode): Predicate {
  return {
    node,
    not: () => wrap({ op: 'not', of: node }),
    keys: () => [...collectKeys(node, new Set())].sort(),
    toJSON: () => node,
  }
}

function collectKeys(node: PredicateNode, into: Set<string>): Set<string> {
  switch (node.op) {
    case 'always':
    case 'never':
      return into
    case 'is':
      into.add(node.key)
      return into
    case 'not':
      return collectKeys(node.of, into)
    case 'and':
    case 'or':
      for (const child of node.of) collectKeys(child, into)
      return into
  }
}

/**
 * A `false` default must not make a `ContextKey<false>`: TypeScript keeps the
 * literal when the constraint contains its primitive, and a flag whose `is`
 * only accepts `false` is useless. Booleans and numbers widen; strings keep
 * their literal so `defineContextKey<'edit' | 'play'>(…)` stays a closed union
 * — the analysable shape conflict detection needs.
 */
type Widen<T extends KeyValue> = T extends boolean ? boolean : T extends number ? number : T

/**
 * Mint a key under `owner`. The vocabulary is declared-but-extensible (#3's
 * handoff to #8): any package may add a key, but a predicate can only be built
 * from one that exists, and two definitions of one id throw because the second
 * would either disagree about the default or silently alias the first.
 *
 * The owner is what makes that throw survivable for a feature (#21 §4, #66
 * step 5's handoff). Without it the vocabulary was global and permanent: a
 * feature module that minted a key threw on the HMR re-import that #21 §4
 * requires, because the id was still taken by the incarnation the hot update
 * was replacing. Keys are revoked with everything else the owner declared, in
 * the same `dispose(owner)` and by the same mechanism, so a re-mint under the
 * same id is exactly as legal as re-declaring a command.
 *
 * The revocation is UNCONDITIONAL, and `owners.ts` is what makes that safe:
 * `dispose` drops an owner's teardown list before running it, so a list runs
 * at most once. An id is only free to be minted again after the teardown
 * holding it has run, and that teardown is gone by then — so at any instant at
 * most one live teardown names a given id, and the key it would delete is the
 * one the slot holds. Guarding the delete with `definedKeys.get(id) === key`
 * therefore tests a condition that cannot be false; it was written as if a
 * stale teardown could outlive its owner's re-mint, and none can.
 */
export function defineContextKey<T extends KeyValue>(owner: OwnerId, id: string, defaultValue: T): ContextKey<Widen<T>> {
  if (definedKeys.has(id)) throw new Error(`context key "${id}" is already defined`)
  const key: ContextKey<Widen<T>> = {
    id,
    defaultValue: defaultValue as Widen<T>,
    is: (value) => wrap({ op: 'is', key: id, value }),
  }
  definedKeys.set(id, key)
  onDispose(owner, () => definedKeys.delete(id))
  return key
}

export const always: Predicate = wrap({ op: 'always' })
export const never: Predicate = wrap({ op: 'never' })

export function and(...of: readonly Predicate[]): Predicate {
  return wrap({ op: 'and', of: of.map((p) => p.node) })
}

export function or(...of: readonly Predicate[]): Predicate {
  return wrap({ op: 'or', of: of.map((p) => p.node) })
}

export function not(of: Predicate): Predicate {
  return of.not()
}

function read(snapshot: ContextSnapshot, key: string): KeyValue | undefined {
  return key in snapshot ? snapshot[key] : definedKeys.get(key)?.defaultValue
}

function holds(node: PredicateNode, snapshot: ContextSnapshot): boolean {
  switch (node.op) {
    case 'always':
      return true
    case 'never':
      return false
    case 'is':
      return read(snapshot, node.key) === node.value
    case 'not':
      return !holds(node.of, snapshot)
    case 'and':
      return node.of.every((child) => holds(child, snapshot))
    case 'or':
      return node.of.some((child) => holds(child, snapshot))
  }
}

/**
 * Why a predicate fails, in words, for a disabled control's tooltip. Returns
 * the first unsatisfied clause rather than the whole tree: a tooltip wants one
 * reason, not a proof. Only called on a node that does not hold.
 */
function explain(node: PredicateNode, snapshot: ContextSnapshot): string {
  switch (node.op) {
    case 'always':
      return 'unavailable'
    case 'never':
      return 'never available'
    case 'is':
      return `requires ${node.key} to be ${JSON.stringify(node.value)} (it is ${JSON.stringify(read(snapshot, node.key))})`
    case 'not':
      return node.of.op === 'is'
        ? `requires ${node.of.key} not to be ${JSON.stringify(node.of.value)}`
        : 'requires a condition that currently holds to be false'
    case 'and': {
      const failing = node.of.find((child) => !holds(child, snapshot))
      return failing ? explain(failing, snapshot) : 'unavailable'
    }
    case 'or':
      return node.of.length === 0 ? 'never available' : node.of.map((child) => explain(child, snapshot)).join(', or ')
  }
}

/** Pure: reads only the snapshot and the key defaults, so a test needs no DOM and no actor. */
export function evaluate(predicate: Predicate, snapshot: ContextSnapshot): Availability {
  return holds(predicate.node, snapshot) ? { available: true } : { available: false, reason: explain(predicate.node, snapshot) }
}

/**
 * A value standing for "anything nobody named". A predicate only ever compares
 * a key against the values it mentions, so one witness outside that set is
 * enough to represent every other value the key could hold.
 */
const OTHER = Symbol('other')
type Candidate = KeyValue | typeof OTHER

/** Beyond this many assignments the search gives up and reports "not provably disjoint" — the safe answer. */
const SEARCH_LIMIT = 4096

function mention(node: PredicateNode, into: Map<string, Set<KeyValue>>): void {
  switch (node.op) {
    case 'always':
    case 'never':
      return
    case 'is': {
      const values = into.get(node.key)
      if (values) values.add(node.value)
      else into.set(node.key, new Set([node.value]))
      return
    }
    case 'not':
      mention(node.of, into)
      return
    case 'and':
    case 'or':
      for (const child of node.of) mention(child, into)
  }
}

/**
 * The values each key has to be tried at. A key declared with a boolean
 * default has a domain of exactly two, so no witness is needed and the search
 * is EXACT for it; anything else gets the values the predicate mentions plus
 * one witness for everything it does not.
 */
function domains(node: PredicateNode): Array<readonly [string, readonly Candidate[]]> {
  const mentioned = new Map<string, Set<KeyValue>>()
  mention(node, mentioned)
  return [...mentioned].map(([key, values]) => {
    const declared = definedKeys.get(key)
    const candidates: readonly Candidate[] =
      typeof declared?.defaultValue === 'boolean' ? [true, false] : [...values, OTHER]
    return [key, candidates] as const
  })
}

function holdsUnder(node: PredicateNode, assignment: ReadonlyMap<string, Candidate>): boolean {
  switch (node.op) {
    case 'always':
      return true
    case 'never':
      return false
    case 'is':
      return assignment.get(node.key) === node.value
    case 'not':
      return !holdsUnder(node.of, assignment)
    case 'and':
      return node.of.every((child) => holdsUnder(child, assignment))
    case 'or':
      return node.of.some((child) => holdsUnder(child, assignment))
  }
}

function satisfiable(node: PredicateNode): boolean {
  const keys = domains(node)
  let total = 1
  for (const [, candidates] of keys) total *= candidates.length
  // Giving up must err toward "satisfiable", because the only caller reads
  // UNsatisfiable as "these two can never collide" and would suppress a real
  // conflict on a search it never finished.
  if (total > SEARCH_LIMIT) return true
  for (let i = 0; i < total; i += 1) {
    const assignment = new Map<string, Candidate>()
    let rest = i
    for (const [key, candidates] of keys) {
      assignment.set(key, candidates[rest % candidates.length])
      rest = Math.floor(rest / candidates.length)
    }
    if (holdsUnder(node, assignment)) return true
  }
  return false
}

/**
 * Can these two ever hold at once? The question #14's conflict detection is
 * built on, and the reason availability is typed data rather than Blender's
 * `poll()`: two functions cannot be proven disjoint, two predicates over a
 * declared vocabulary can.
 *
 * Decided by search rather than by rewriting to a normal form — the vocabulary
 * a predicate touches is a handful of keys with a handful of values each, so
 * enumerating the assignments is both exact and shorter than a DNF pass. It is
 * exact whenever every key it mentions is boolean or every value it could take
 * is named; where a key's domain is open (a string key, say) the witness above
 * covers "some other value", which is enough for every predicate this DSL can
 * build, since `is` is the only leaf that reads a key.
 *
 * One-directional error, on purpose: an answer of `true` means PROVEN
 * disjoint, and a search that runs out of room answers `false`. A caller may
 * therefore act on `true` and must treat `false` as "unknown or overlapping".
 */
export function disjoint(a: Predicate, b: Predicate): boolean {
  return !satisfiable({ op: 'and', of: [a.node, b.node] })
}

function isKeyValue(value: unknown): value is KeyValue {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function parseNode(input: unknown, path: string): PredicateNode {
  if (typeof input !== 'object' || input === null || !('op' in input)) throw new Error(`${path}: expected a predicate node`)
  const op: unknown = input.op
  switch (op) {
    case 'always':
    case 'never':
      return { op }
    case 'is': {
      const key: unknown = 'key' in input ? input.key : undefined
      const value: unknown = 'value' in input ? input.value : undefined
      if (typeof key !== 'string') throw new Error(`${path}.key: expected a key id`)
      // Rejecting an undeclared key here is what makes a stored predicate as
      // safe as an authored one: the type system cannot see a preferences file.
      if (!definedKeys.has(key)) throw new Error(`${path}.key: unknown context key "${key}"`)
      if (!isKeyValue(value)) throw new Error(`${path}.value: expected a string, number, boolean or null`)
      return { op, key, value }
    }
    case 'not': {
      const of: unknown = 'of' in input ? input.of : undefined
      return { op, of: parseNode(of, `${path}.of`) }
    }
    case 'and':
    case 'or': {
      const of: unknown = 'of' in input ? input.of : undefined
      if (!Array.isArray(of)) throw new Error(`${path}.of: expected an array`)
      return { op, of: of.map((child: unknown, i) => parseNode(child, `${path}.of[${i}]`)) }
    }
    default:
      throw new Error(`${path}.op: unknown operator ${JSON.stringify(op)}`)
  }
}

/** The inverse of `toJSON`: rebuilds a predicate from stored data, refusing anything that names a key nobody defined. */
export function parsePredicate(input: unknown): Predicate {
  return wrap(parseNode(input, 'predicate'))
}
