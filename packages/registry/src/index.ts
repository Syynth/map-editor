/**
 * The registry package's public surface: rung 0 of the ladder (#3).
 *
 * Declarations only. Commands, tools, panels and keybindings are static data
 * registered at import and enumerable before any actor exists; the handlers
 * will ride on actors — `document`'s in #66 step 2, `editor-host`'s in step 3
 * — joined to these by string id and nothing else (#5, #9). Nothing here
 * imports XState, React or the DOM — a consumer that needs one of those sits
 * above this package, and the only dependency is a types-only spec.
 *
 * Written out longhand rather than `export *` (#34): a barrel exports what has
 * an outside consumer plus the types to name what those consumers receive, so
 * narrowing it is a visible edit here. `onDispose` is exported for surface
 * packages that hold something on an owner's behalf (#21 §1); `dispose` and
 * `reserveOwner` for the host and the built-in declarers respectively.
 */

export { dispose, isReservedOwner, onDispose, reserveOwner } from './owners'
export type { OwnerId } from './owners'

export type { Declaration, DeclarationRegistry } from './registry'

export { always, and, defineContextKey, evaluate, never, not, or, parsePredicate } from './context'
export type { Availability, ContextKey, ContextSnapshot, KeyValue, Predicate, PredicateNode } from './context'

export { commands, resolveCommand, validateArgs } from './commands'
export type { ArgIssue, ArgSchema, CommandDecl, DispatchRefusal, DispatchResult, Resolution } from './commands'

export { tools } from './tools'
export type { CommandEvent, CommandTarget, StrokeHandler, ToolContract, ToolDecl } from './tools'

export { panels } from './panels'
export type { PanelDecl } from './panels'

export { keymap } from './keymap'
export type { KeyBinding } from './keymap'
