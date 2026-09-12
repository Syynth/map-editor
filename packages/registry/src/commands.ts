/**
 * Command declarations and the pre-flight half of dispatch (#8, #23).
 *
 * A command is the intent layer: a named, enumerable, remappable thing that a
 * keybinding, a UI control and a test all invoke identically, as `(id, args)`
 * and never as a function (#5). Its declaration is data — id, title, category,
 * availability, argument schema — registered at import; its handler rides on
 * the actor that implements it, addressed by the declaring owner. Arguments
 * are plain serialisable data addressing targets by stable id, and the schema
 * is where that discipline is enforced (#23).
 *
 * `dispatch(id, args)` itself belongs to the host (#8: one root actor,
 * bubble-down), built in #66 step 3, because it needs the actor refs. What
 * lives here is everything that does NOT need an actor — lookup,
 * availability, argument validation — so a test drives the same code path a
 * keybinding does without `editor-host` (#3), and so the `unknown` /
 * `unavailable` / `invalid-args` outcomes are decided by the same code
 * wherever dispatch is called from.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec'
import { always, evaluate, type ContextSnapshot, type Predicate } from './context'
import { createRegistry } from './registry'

/**
 * A Standard Schema v1 object (#23). Validator-agnostic: a Zod schema conforms
 * today, anything else that implements `~standard` will too, and the package
 * keeps its zero-runtime-dependency property because the spec ships types only.
 */
export type ArgSchema = StandardSchemaV1

export interface CommandDecl {
  readonly id: string
  /** What the palette and a menu show. */
  readonly title: string
  /** Grouping in the palette; VS Code prefixes the title with it. */
  readonly category?: string
  /** Availability. Absent means always available. */
  readonly when?: Predicate
  /** Argument schema. Absent means the command takes no arguments. */
  readonly args?: ArgSchema
}

/** One argument-validation failure, with the field it names: a rejection must say why. */
export interface ArgIssue {
  readonly path: readonly (string | number)[]
  readonly message: string
}

/**
 * The ways a dispatch does not happen. Every one is an ordinary return value,
 * never a throw (#8): "declared but its actor is not running" is a legal state
 * and a keybinding hitting it must not take the editor down.
 *
 * - `unknown`: nobody declared the id.
 * - `unavailable`: declared, but its `when` is false — and the reason says which clause.
 * - `invalid-args`: available, but the arguments fail the declared schema.
 * - `unhandled`: declared and available, but no actor took it — the owner's
 *   actor is not running, or the send dead-lettered at a stopped ref (#15).
 */
export type DispatchRefusal =
  | { readonly ok: false; readonly kind: 'unknown'; readonly reason: string }
  | { readonly ok: false; readonly kind: 'unavailable'; readonly reason: string }
  | { readonly ok: false; readonly kind: 'invalid-args'; readonly issues: readonly ArgIssue[] }
  | { readonly ok: false; readonly kind: 'unhandled'; readonly reason: string }

export type DispatchResult = { readonly ok: true } | DispatchRefusal

/**
 * What the pre-flight hands its caller — the host, once #66 step 3 builds it:
 * the declaration to route by and the VALIDATED arguments, since a schema may
 * fill defaults or strip what it does not know, and the handler must see what
 * the schema approved.
 */
export type Resolution =
  | { readonly ok: true; readonly command: CommandDecl; readonly args: unknown }
  | Exclude<DispatchRefusal, { kind: 'unhandled' }>

function isThenable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function'
}

/**
 * The probe (#23): `~standard` carries no async flag, so the only way to know
 * whether a validator goes async is to call it. `{}` is the probe because an
 * object schema is the shape a command takes.
 *
 * It is a probe, not a proof. Measured on `zod@4.6.2`: a refinement is skipped
 * once the payload has issues, so an async refine on `z.object({ name:
 * z.string() })` returns a SYNC failure for `{}` and slips through, while the
 * same refine on an all-optional or defaulted object, an async field refine
 * behind a `.default()`, and an async `.transform()` all return a Promise and
 * are caught here. What slips is caught at dispatch instead, where
 * `validateArgs` reports it as an issue rather than hanging or throwing — the
 * declare-time refusal is the early warning, the dispatch guard is the rule.
 */
function refuseAsyncValidator(declaration: CommandDecl): void {
  if (!declaration.args) return
  if (isThenable(declaration.args['~standard'].validate({})))
    throw new Error(
      `command "${declaration.id}": its argument schema validates asynchronously; dispatch is synchronous, so async validators are refused at declare time (#23)`,
    )
}

function normalisePath(path: StandardSchemaV1.Issue['path']): readonly (string | number)[] {
  if (!path) return []
  return path.map((segment) => {
    const key = typeof segment === 'object' ? segment.key : segment
    return typeof key === 'symbol' ? key.toString() : key
  })
}

export const commands = createRegistry<CommandDecl>('command', refuseAsyncValidator)

/**
 * Run the declared schema over `args`. Absent schema means the command takes
 * no arguments, so passing any is an issue rather than something to drop on
 * the floor — a keybinding that binds arguments to an argument-less command is
 * a mistake worth hearing about.
 */
export function validateArgs(declaration: CommandDecl, args: unknown): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly issues: readonly ArgIssue[] } {
  if (!declaration.args) {
    return args === undefined ? { ok: true, value: undefined } : { ok: false, issues: [{ path: [], message: 'this command takes no arguments' }] }
  }
  const result = declaration.args['~standard'].validate(args)
  // The declare-time probe cannot see every async path (see above). Dispatch
  // must stay synchronous and must not throw, so a validator that goes async
  // here is reported as the one issue that names the real problem.
  if (isThenable(result))
    return { ok: false, issues: [{ path: [], message: 'argument schema validated asynchronously; async validators are not supported' }] }
  const settled = result as StandardSchemaV1.Result<unknown>
  if (settled.issues) return { ok: false, issues: settled.issues.map((issue) => ({ path: normalisePath(issue.path), message: issue.message })) }
  return { ok: true, value: settled.value }
}

/**
 * Everything dispatch decides before it needs an actor, in the order a caller
 * wants to hear about it: does the command exist, may it run now, are the
 * arguments well-formed. `snapshot` is supplied per call, never held — #8's
 * prototype froze one at construction and left `play.stop` permanently
 * unavailable.
 */
export function resolveCommand(id: string, args: unknown, snapshot: ContextSnapshot): Resolution {
  const command = commands.get(id)
  if (!command) return { ok: false, kind: 'unknown', reason: `no command is declared with id "${id}"` }
  const availability = evaluate(command.when ?? always, snapshot)
  if (!availability.available) return { ok: false, kind: 'unavailable', reason: availability.reason }
  const validated = validateArgs(command, args)
  if (!validated.ok) return { ok: false, kind: 'invalid-args', issues: validated.issues }
  return { ok: true, command, args: validated.value }
}
