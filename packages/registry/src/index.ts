/**
 * The registry package's public surface: rung 0 of the ladder (#3).
 *
 * Declarations, plus the two resolvers that read them — a command's pre-flight
 * (`resolveCommand`) and the keymap's (`resolve`, #14). Both take their data
 * as arguments except the command's own `when`, which they read from the
 * module-global command registry, so they sit beside the declarations they
 * consume rather than above them; the keydown listener that feeds the second
 * one is the app's, because it needs a window and this package compiles
 * without `DOM`.
 *
 * Commands, tools, panels and keybindings are static data
 * registered at import and enumerable before any actor exists; the handlers
 * ride on actors — `document`'s and `editor-host`'s (#66 steps 2 and 3) —
 * joined to these by string id and nothing else (#5, #9). Nothing here
 * imports XState, React or the DOM — a consumer that needs one of those sits
 * above this package, and the only dependency is a types-only spec.
 *
 * Written out longhand rather than `export *` (#34): a barrel exports what has
 * an outside consumer plus the types to name what those consumers receive, so
 * narrowing it is a visible edit here. `onDispose` is exported for surface
 * packages that hold something on an owner's behalf (#21 §1); `dispose` and
 * `reserveOwner` for the host and the built-in declarers respectively;
 * `defineFeature` for a feature module and `onFeatureChange` for the one host
 * that installs what it publishes (#21 §4, §6).
 */

export { dispose, isReservedOwner, onDispose, reserveOwner } from './owners'
export type { OwnerId } from './owners'

export type { Declaration, DeclarationRegistry } from './registry'

export { defineFeature, onFeatureChange, provideFeature } from './feature'
export type { FeatureChangeHooks, FeatureDeps, FeatureInstance, FeatureModule, FeatureSelection, HotHandle } from './feature'

export { always, and, defineContextKey, disjoint, evaluate, never, not, or, parsePredicate } from './context'
export type { Availability, ContextKey, ContextSnapshot, KeyValue, Predicate, PredicateNode } from './context'

export { commands, resolveCommand, validateArgs } from './commands'
export type { ArgIssue, ArgSchema, CommandDecl, DispatchRefusal, DispatchResult, Resolution } from './commands'

export { tools } from './tools'
export type { CommandEvent, CommandTarget, StrokeHandler, ToolContract, ToolDecl } from './tools'

export { panels } from './panels'
export type { PanelDecl, PanelSlot } from './panels'

export { canonicalSpec, chordFromEvent, chordsEqual, formatChord, parseChords } from './chords'
export type { Chord, KeyEventLike, Platform } from './chords'

export { chordFor, createChordSession, keymap, resolve } from './keymap'
export type { BindingWeight, ChordSession, KeyBinding, KeymapContext, KeyResolution } from './keymap'
