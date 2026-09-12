/**
 * `@map-editor/feature-terrain`: the terrain tools as a feature module — the
 * first one, and the proof that the import surface #35 drew is real.
 *
 * What a feature is, concretely (#9): a module that declares through the
 * registry at import, under an identity it mints itself, and exports the actor
 * the host spawns. It imports `registry`, `document`, `geometry` and `ui`, and
 * NOTHING from `editor-host` — the contract it implements lives below both, in
 * `registry`, and an app is the only thing that sees the two halves. The
 * dependency-direction test enforces that arrow; this module is what it was
 * written for.
 *
 * The order below is the protocol, and all of it re-runs on a hot re-import
 * because it is a call rather than a module-scope side effect somewhere else
 * (see `keys.ts`):
 *
 *   1. `defineFeature` mints the owner and wires the hot update (#21 §4). Vite
 *      looks a disposer up by the path of the module that CHANGED, so the
 *      registration has to be here rather than in whatever imports us.
 *   2. Everything the owner declares — keys first, since a panel's `when`
 *      names one.
 *   3. `provideFeature` publishes the module, which is what tells an already
 *      running host to spawn the new logic (#21 §6).
 *
 * `create` is called once per host, with the deps only a composition root can
 * supply, and answers with the actor, the terrain tool's stroke contract and
 * the values for the keys minted in step 2.
 */

import type { Patch } from '@map-editor/document'
import { defineFeature, provideFeature, tools, type FeatureInstance, type HotHandle } from '@map-editor/registry'

import { declareTerrainCommands } from './commands'
import type { FeatureDeps } from './deps'
import { defineTerrainKeys, terrainKeys } from './keys'
import { terrainLogic, type TerrainLogic } from './logic'
import { declareTerrainPanels } from './panels'
import { terrainContract, type TerrainSample } from './stroke'
import { activeVerb } from './verbs'

/**
 * `import.meta.hot` without depending on the bundler. `registry` types the
 * handle structurally for the same reason (#21 §4), and this package's
 * tsconfig loads no ambient types — a feature has to compile without the thing
 * that loads it, so the one property Vite adds is named here rather than
 * pulled in as a global.
 */
const hot = (import.meta as ImportMeta & { readonly hot?: HotHandle }).hot

export const TERRAIN = defineFeature('terrain', hot)

defineTerrainKeys(TERRAIN)
declareTerrainCommands(TERRAIN)
declareTerrainPanels(TERRAIN)
tools.declare(TERRAIN, { id: 'terrain', title: 'Terrain', icon: 'terrain' })

export const terrainFeature = provideFeature({
  owner: TERRAIN,
  create(deps: FeatureDeps): FeatureInstance<TerrainLogic, TerrainSample, Patch> {
    return {
      logic: terrainLogic(deps),
      tools: { terrain: terrainContract(deps) },
      keys: () => ({ [terrainKeys.verb.id]: activeVerb(deps.params()), [terrainKeys.mode.id]: deps.params().terrainMode }),
    }
  },
})

/**
 * Written out longhand rather than `export *` (#34), and deliberately short:
 * an app composes this feature by handing `terrainFeature` to `createHost`,
 * and reaches everything else — the commands, the panels' components, the
 * tool's contract — through the registry, by id. The two types name what a
 * consumer receives rather than adding surface: `TerrainParams` is the shape
 * of a parameter change, and `TerrainPanelProps` is what whoever renders a
 * declared panel has to fill in.
 *
 * `strokeCells` is the one exception, and it is here for the same reason the
 * contract is: the app's brush preview draws the cells a terrain stroke WILL
 * touch, so it has to compute them with the function the stroke itself uses or
 * the outline and the edit disagree. It used to live in `editor-host`, which
 * meant a second copy of the rule; the preview is terrain knowledge, so it
 * belongs to the terrain feature and an app reads it from here.
 */
export { strokeCells } from './verbs'
export type { TerrainPanelProps } from './panels'
export type { TerrainParams } from './verbs'
