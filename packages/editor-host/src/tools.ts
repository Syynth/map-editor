/**
 * The tools actor: the eleven tool parameters (#11).
 *
 * These are properties of the person editing, not of the map — which tool is
 * active, how big the brush is, which tile the paint brush lays down — so
 * none of it is serialised and none of it touches the document. They came
 * out of the 18-field `EditorState` that `App.tsx` held in one `useState`;
 * since #66 step 4 this actor IS that state, and the app assembles the panels'
 * object from this snapshot and the view actor's. The split is by owner and
 * lifetime, not for re-renders, which `useSelector` fixes on its own — and the
 * app has yet to take that half, since it still selects whole snapshots.
 *
 * `terrainMode` is a STATE and the rest is CONTEXT, deliberately (#11): the
 * mode changes what a pointer-drag means, so it is the one parameter whose
 * value is a different behaviour rather than a different number. Nothing is
 * nested further than that — availability comes from the predicate DSL, not
 * from machine shape, so a hierarchy would buy illegal-state-unrepresentable
 * at the cost of a transition per `brush.size` change.
 *
 * One command, `tools.set`, with a partial object of typed arguments (#8:
 * `(id, args)`, not one command per parameter). The schema is where the
 * argument discipline is enforced (#23): a stray key or an out-of-range size
 * is an `invalid-args` result before anything is sent, and the handler may
 * trust what arrives. Nothing here calls `enq` — the transition is pure
 * context — so v6 runs the body once (#2's `enq` constraint).
 *
 * `settings` is the same patch arriving by the HOST-INTERNAL door. The
 * eyedropper writes a tool parameter from inside a stroke effect, and
 * re-entering `dispatch` from there would run the registry's resolution
 * inside an enqueued effect; sending the sibling ref a hand-rolled
 * `{ type: 'command', id: 'tools.set', args }` instead was worse, because
 * `args: unknown` meant the cast, not the schema, decided what was legal and
 * a change to `toolSettings` would not have reached the call site. This event
 * carries `ToolSettings` as a TYPE, so it does. It is not a second command
 * path: it has no id, the registry never sees it, and nothing outside this
 * package holds a ref to send it — `dispatch` remains the only entry point
 * for anything a command is (#8).
 */

import { NO_RAMP } from '@map-editor/document'
import { commands, defineContextKey, reserveOwner } from '@map-editor/registry'
import { setup, types } from 'xstate'
import { z } from 'zod'

export const TOOLS_OWNER = reserveOwner('editor-host.tools')

export type ToolId = 'terrain' | 'object' | 'camera'
export type TerrainMode = 'sculpt' | 'paint'

/**
 * `tool` and `terrainMode` are what availability predicates ask about — a
 * sculpt verb is meaningless while painting — so they are context keys; the
 * numeric parameters are not, since no command is gated on a brush size.
 */
export const toolKeys = {
  tool: defineContextKey<ToolId>('tools.tool', 'terrain'),
  terrainMode: defineContextKey<TerrainMode>('tools.terrainMode', 'sculpt'),
}

/**
 * Ranges match what the panels offer: the brush slider runs 1–12, a ramp
 * direction is an index into `DIR_NAMES` or `NO_RAMP`, a tint is a packed
 * 24-bit colour. `material` and `tile` are indices into the document's
 * material list and the sheet, whose lengths this actor cannot see; the
 * lower bound is what it can check.
 *
 * Every field is `exactOptional` rather than the object being `.partial()`:
 * an absent key means "leave it alone", but a key present with the value
 * `undefined` is refused with the key's path, the same as an out-of-range
 * size. `.partial()` accepts explicit `undefined` and keeps the key, and
 * `applySettings` spreads what arrives, so it would have written `undefined`
 * over `brush` and the next `brush.size` would throw. `undefined` is not
 * JSON; the schema is where that rule is enforced (#23).
 */
const toolSettings = z
  .object({
    tool: z.enum(['terrain', 'object', 'camera']).exactOptional(),
    terrainMode: z.enum(['sculpt', 'paint']).exactOptional(),
    sculptVerb: z.enum(['raise', 'flatten', 'ramp', 'water']).exactOptional(),
    paintVerb: z.enum(['tile', 'material', 'tint']).exactOptional(),
    strokeShape: z.enum(['brush', 'rect', 'fill']).exactOptional(),
    brush: z.object({ size: z.int().min(1).max(12), shape: z.enum(['square', 'circle']) }).exactOptional(),
    material: z.int().min(0).exactOptional(),
    tile: z.int().min(0).exactOptional(),
    tint: z.int().min(0).max(0xffffff).exactOptional(),
    rampDir: z.int().min(NO_RAMP).max(3).exactOptional(),
    spriteName: z.string().min(1).exactOptional(),
  })
  .strict()

export type ToolSettings = z.infer<typeof toolSettings>

/** The ten parameters held as context; `terrainMode` is the state. */
export type ToolsContext = Required<Omit<ToolSettings, 'terrainMode'>>

commands.declare(TOOLS_OWNER, { id: 'tools.set', title: 'Set Tool Parameters', category: 'Tools', args: toolSettings })

const initialTools: ToolsContext = {
  tool: 'terrain',
  sculptVerb: 'raise',
  paintVerb: 'tile',
  strokeShape: 'brush',
  brush: { size: 1, shape: 'square' },
  material: 0,
  tile: 0,
  tint: 0xffffff,
  rampDir: NO_RAMP,
  spriteName: 'tree',
}

/**
 * Apply a `tools.set`. The context patch is whatever the schema approved
 * minus `terrainMode`, which becomes a target instead — the same event can
 * change the mode and a verb at once, which is what a "switch to paint with
 * the tint brush" keybinding wants. `undefined` targets stay put.
 */
function applySettings(settings: ToolSettings, current: TerrainMode): { target?: TerrainMode; context: Partial<ToolsContext> } {
  const { terrainMode, ...context } = settings
  return terrainMode !== undefined && terrainMode !== current ? { target: terrainMode, context } : { context }
}

export const toolsLogic = setup({
  schemas: {
    context: types<ToolsContext>(),
    events: {
      command: types<{ id: string; args: unknown }>(),
      settings: types<{ settings: ToolSettings }>(),
    },
  },
}).createMachine({
  id: 'tools',
  context: initialTools,
  initial: 'sculpt',
  states: {
    sculpt: {
      on: {
        command: ({ event }) => (event.id === 'tools.set' ? applySettings(event.args as ToolSettings, 'sculpt') : undefined),
        settings: ({ event }) => applySettings(event.settings, 'sculpt'),
      },
    },
    paint: {
      on: {
        command: ({ event }) => (event.id === 'tools.set' ? applySettings(event.args as ToolSettings, 'paint') : undefined),
        settings: ({ event }) => applySettings(event.settings, 'paint'),
      },
    },
  },
})

export type ToolsLogic = typeof toolsLogic
