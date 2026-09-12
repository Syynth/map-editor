/**
 * The editor host's public surface: rung 5 of the ladder (#3), the
 * composition spine.
 *
 * An app builds a host with `createHost` and dispatches through it; the
 * React glue reads actors through selectors and the document through
 * `useDocument`; the viewport's pointer handlers are `Host.input` (#11). The
 * child logics are not exported: the host spawns them, and a consumer reaches
 * their state through `Host.children` and the typed selector hooks. Features
 * never import this package (#35) — the contract they implement lives in
 * `registry`, and an app hands them in as `Feature`. `strokeCells` is here
 * because the brush preview in the app computes the same cells a stroke will.
 *
 * Written out longhand rather than `export *` (#34): a barrel exports what
 * has an outside consumer plus the types to name what those consumers
 * receive, so narrowing it is a visible edit here.
 */

export { GESTURE_OWNER, HOST_OWNER, createHost, hostKeys } from './host'
export type { Clock, DeadLetter, EditorInput, Feature, Host, HostActor, HostChildren, HostOptions, Mode } from './host'

export { ORBIT_DRAG_THRESHOLD } from './gesture'
export type { Gesture, PointerMotion, PointerPress, PointerRelease } from './gesture'

export { strokeCells } from './strokes'
export type { PickSample, PointerModifiers, StrokeSample } from './strokes'

export { TOOLS_OWNER, toolKeys } from './tools'
export type { TerrainMode, ToolId, ToolSettings, ToolsContext } from './tools'

export { VIEW_OWNER, viewKeys } from './view'
export type { ViewContext, ViewSettings } from './view'

export { HostProvider, useDocument, useHost, useHostRef, useHostSelector, useToolsSelector, useViewSelector } from './react'
