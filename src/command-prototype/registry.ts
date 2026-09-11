/**
 * PROTOTYPE — throwaway. See issue #8.
 *
 * The command layer's *declaration* half: static module-level data, registered
 * at import, independent of whether any actor is running. A keybinding UI and a
 * command palette can enumerate all of this before the editor starts.
 *
 * Nothing here imports XState. That is deliberate — if the declaration half
 * needed the actor library, the two-registry split would be a lie.
 */

// ---------------------------------------------------------------------------
// Context keys — the closed vocabulary availability predicates may mention.
// ---------------------------------------------------------------------------

/**
 * The set of keys is closed and typed. This is what makes predicates
 * analysable: a predicate can only ever talk about these, so two predicates
 * can be compared symbolically instead of being run.
 */
export interface ContextKeys {
  tool: 'select' | 'raise' | 'paint'
  mode: 'edit' | 'play'
  documentOpen: boolean
  hasSelection: boolean
  canUndo: boolean
  canRedo: boolean
}

export type KeyName = keyof ContextKeys
export type KeyValue = ContextKeys[KeyName]

// ---------------------------------------------------------------------------
// The availability predicate language.
// ---------------------------------------------------------------------------

/**
 * A closed algebra, not a function. Blender's `poll()` is a function and so
 * two commands' availability can never be proven disjoint; VS Code's `when` is
 * a parsed string, which is analysable but stringly-typed. This is the third
 * option: typed data.
 */
export type Predicate =
  | { k: 'always' }
  | { k: 'never' }
  | { k: 'is'; key: KeyName; value: KeyValue }
  | { k: 'not'; of: Predicate }
  | { k: 'and'; of: Predicate[] }
  | { k: 'or'; of: Predicate[] }

export const always: Predicate = { k: 'always' }
export const never: Predicate = { k: 'never' }
export const is = <K extends KeyName>(key: K, value: ContextKeys[K]): Predicate => ({ k: 'is', key, value })
export const not = (of: Predicate): Predicate => ({ k: 'not', of })
export const and = (...of: Predicate[]): Predicate => ({ k: 'and', of })
export const or = (...of: Predicate[]): Predicate => ({ k: 'or', of })

export function evaluate(p: Predicate, keys: ContextKeys): boolean {
  switch (p.k) {
    case 'always': return true
    case 'never': return false
    case 'is': return keys[p.key] === p.value
    case 'not': return !evaluate(p.of, keys)
    case 'and': return p.of.every((q) => evaluate(q, keys))
    case 'or': return p.of.some((q) => evaluate(q, keys))
  }
}

/**
 * Why a command is unavailable, in words, for a disabled control's tooltip.
 * Returns the first unsatisfied clause rather than the whole tree — a tooltip
 * wants one reason, not a proof.
 */
export function explain(p: Predicate, keys: ContextKeys): string | null {
  if (evaluate(p, keys)) return null
  switch (p.k) {
    case 'never': return 'never available'
    case 'is': return `requires ${p.key} to be ${JSON.stringify(p.value)} (it is ${JSON.stringify(keys[p.key])})`
    case 'not': {
      const inner = p.of
      if (inner.k === 'is') return `requires ${inner.key} not to be ${JSON.stringify(inner.value)}`
      return 'a condition that must be false is true'
    }
    case 'and': {
      for (const q of p.of) {
        const why = explain(q, keys)
        if (why) return why
      }
      return 'unavailable'
    }
    case 'or':
      return p.of.map((q) => explain(q, keys)).filter(Boolean).join(', and ')
    default:
      return 'unavailable'
  }
}

// ---------------------------------------------------------------------------
// Disjointness — the entire reason the language is data and not a function.
// ---------------------------------------------------------------------------

/**
 * Sound but incomplete: `true` means the two predicates provably never hold at
 * once, so two keybindings carrying them cannot conflict. `false` means "not
 * proven disjoint" — which a conflict checker must treat as a possible clash.
 *
 * Being conservative in that direction is the safe failure: it over-reports
 * conflicts rather than missing them.
 */
export function disjoint(a: Predicate, b: Predicate): boolean {
  if (a.k === 'never' || b.k === 'never') return true
  if (a.k === 'and') return a.of.some((q) => disjoint(q, b))
  if (b.k === 'and') return b.of.some((q) => disjoint(a, q))
  if (a.k === 'or') return a.of.every((q) => disjoint(q, b))
  if (b.k === 'or') return b.of.every((q) => disjoint(a, q))
  // The base case that does the real work: the same key pinned to two
  // different values can never hold simultaneously.
  if (a.k === 'is' && b.k === 'is') return a.key === b.key && a.value !== b.value
  if (a.k === 'is' && b.k === 'not' && b.of.k === 'is') {
    return a.key === b.of.key && a.value === b.of.value
  }
  if (b.k === 'is' && a.k === 'not' && a.of.k === 'is') {
    return b.key === a.of.key && b.value === a.of.value
  }
  return false
}

// ---------------------------------------------------------------------------
// Argument schemas — closed, serialisable, enough to generate a form from.
// ---------------------------------------------------------------------------

export type ArgSchema =
  | { t: 'int'; min?: number; max?: number }
  | { t: 'string'; oneOf?: readonly string[] }
  | { t: 'cells' }

export type ArgsSchema = Record<string, ArgSchema>

export interface ArgIssue { path: string; message: string }

export function validateArgs(schema: ArgsSchema | undefined, args: unknown): ArgIssue[] {
  if (!schema) return []
  const issues: ArgIssue[] = []
  const bag = (args ?? {}) as Record<string, unknown>
  for (const [name, spec] of Object.entries(schema)) {
    const v = bag[name]
    if (v === undefined) { issues.push({ path: name, message: 'missing' }); continue }
    if (spec.t === 'int') {
      if (typeof v !== 'number' || !Number.isInteger(v)) issues.push({ path: name, message: 'expected an integer' })
      else if (spec.min !== undefined && v < spec.min) issues.push({ path: name, message: `must be >= ${spec.min}` })
      else if (spec.max !== undefined && v > spec.max) issues.push({ path: name, message: `must be <= ${spec.max}` })
    } else if (spec.t === 'string') {
      if (typeof v !== 'string') issues.push({ path: name, message: 'expected a string' })
      else if (spec.oneOf && !spec.oneOf.includes(v)) issues.push({ path: name, message: `must be one of ${spec.oneOf.join(', ')}` })
    } else if (spec.t === 'cells') {
      const ok = Array.isArray(v) && v.every((c) => Array.isArray(c) && c.length === 2 && c.every((n) => typeof n === 'number'))
      if (!ok) issues.push({ path: name, message: 'expected an array of [x, y] pairs' })
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// Declarations, and the feature that owns them.
//
// Per #9: two registries joined by a string id. This file is the DECLARATION
// registry — static module-level data registered at import, enumerable before
// any actor exists. Handlers ride on an actor the feature exports as `logic`,
// which the host spawns; see machines.ts.
// ---------------------------------------------------------------------------

/** Features are identified by string. A command is owned by exactly one. */
export type FeatureId = string

export interface CommandDecl {
  id: string
  title: string
  category: string
  /** The feature that declared it. Routing is by this, never by id prefix. */
  feature: FeatureId
  when: Predicate
  args?: ArgsSchema
}

const registry = new Map<string, CommandDecl>()
/** #9's amendment: `declare` owns teardown, so the host disposes by feature id. */
const byFeature = new Map<FeatureId, Set<string>>()

export function declare(decl: CommandDecl): CommandDecl {
  if (registry.has(decl.id)) throw new Error(`duplicate command id: ${decl.id}`)
  registry.set(decl.id, decl)
  let owned = byFeature.get(decl.feature)
  if (!owned) byFeature.set(decl.feature, (owned = new Set()))
  owned.add(decl.id)
  return decl
}

/**
 * Remove everything a feature declared. The feature does not collect its own
 * disposables — #9 found that leaks, because nothing makes it. The registry
 * knows what the feature declared, so the registry is what can undo it.
 */
export function disposeFeature(feature: FeatureId): string[] {
  const owned = byFeature.get(feature)
  if (!owned) return []
  for (const id of owned) registry.delete(id)
  byFeature.delete(feature)
  return [...owned]
}

export const allCommands = (): CommandDecl[] => [...registry.values()]
export const lookup = (id: string): CommandDecl | undefined => registry.get(id)
export const featuresWithCommands = (): FeatureId[] => [...byFeature.keys()]
