/**
 * The tools actor: which tool is active, and every feature's parameters.
 *
 * The host owns three facts — the active tool, the object tool's sprite and
 * how a drag snaps (ruling of 2026-09-12, "Select tool") — and holds, without reading, one parameter slice per installed feature:
 * the terrain feature's brush, verbs and modes live under `features.terrain`
 * and are shaped by the terrain feature alone (its `<owner>.params` command
 * validates them; the host only stores what arrives). A feature is seeded
 * with its declared defaults when it is installed and reads its slice back
 * through `FeatureDeps.params()`. Nothing terrain-shaped is declared here.
 *
 * Any declared tool can be made active: the rail lists what the registry
 * knows, and `tools.set { tool }` refuses an id no owner declared.
 */

import type { SnapMode } from '@map-editor/document'
import { commands, defineContextKey, reserveOwner, tools } from '@map-editor/registry'
import { setup, types } from 'xstate'
import { z } from 'zod'

export const TOOLS_OWNER = reserveOwner('editor-host.tools')

/** A declared tool's id: `select` and `object` are the host's; the rest come from features. */
export type ToolId = string

export const toolKeys = {
  tool: defineContextKey<ToolId>(TOOLS_OWNER, 'tools.tool', 'select'),
}

const toolSettings = z
  .object({
    tool: z.string().min(1).exactOptional(),
    spriteName: z.string().min(1).exactOptional(),
    snap: z.enum(['grid', 'half', 'free']).exactOptional(),
  })
  .strict()

export type ToolSettings = z.infer<typeof toolSettings>

/** One feature's parameters, as the host holds them: shaped by the feature, opaque here. */
export type FeatureParams = Record<string, unknown>

export interface ToolsContext {
  readonly tool: ToolId
  readonly spriteName: string
  /** How the Select and Objects tools snap a drag; the sketch feature keeps its own for now. */
  readonly snap: SnapMode
  readonly features: Readonly<Record<string, FeatureParams>>
}

commands.declare(TOOLS_OWNER, { id: 'tools.set', title: 'Set Tool', category: 'Tools', args: toolSettings })

tools.declare(TOOLS_OWNER, { id: 'select', title: 'Select', icon: 'select' })
tools.declare(TOOLS_OWNER, { id: 'object', title: 'Objects', icon: 'objects' })

function applySettings(settings: ToolSettings): { context: Partial<ToolsContext> } | undefined {
  const next: { tool?: ToolId; spriteName?: string; snap?: SnapMode } = {}
  if (settings.tool !== undefined) {
    // A tool nobody declared is not a tool; the rail could never have shown it.
    if (tools.ownerOf(settings.tool) === undefined) return undefined
    next.tool = settings.tool
  }
  if (settings.spriteName !== undefined) next.spriteName = settings.spriteName
  if (settings.snap !== undefined) next.snap = settings.snap
  return { context: next }
}

/** The tools logic, seeded with each installed feature's default parameters. A closure, not `input`: `input` leaks into the inspector. */
export function toolsLogicWith(seeds: Readonly<Record<string, FeatureParams>>) {
  const initial: ToolsContext = { tool: 'select', spriteName: 'tree', snap: 'grid', features: { ...seeds } }
  return setup({
    schemas: {
      context: types<ToolsContext>(),
      events: {
        command: types<{ id: string; args: unknown }>(),
        settings: types<{ settings: ToolSettings }>(),
        /** A feature changing its own parameters, through `FeatureDeps.setParams`. */
        feature: types<{ owner: string; changes: FeatureParams }>(),
        /** A feature installed after start, bringing its defaults; a slice already present is left alone. */
        seed: types<{ owner: string; params: FeatureParams }>(),
      },
    },
  }).createMachine({
    id: 'tools',
    context: initial,
    initial: 'ready',
    states: {
      ready: {
        on: {
          command: ({ event }) => (event.id === 'tools.set' ? applySettings(event.args as ToolSettings) : undefined),
          settings: ({ event }) => applySettings(event.settings),
          feature: ({ context, event }) => ({
            context: { features: { ...context.features, [event.owner]: { ...context.features[event.owner], ...event.changes } } },
          }),
          seed: ({ context, event }) =>
            context.features[event.owner] === undefined ? { context: { features: { ...context.features, [event.owner]: { ...event.params } } } } : undefined,
        },
      },
    },
  })
}

export const toolsLogic = toolsLogicWith({})
export type ToolsLogic = ReturnType<typeof toolsLogicWith>
