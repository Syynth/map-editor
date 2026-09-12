/**
 * The feature's contribution to the availability vocabulary (#8, #21 §4).
 *
 * One key, minted under the feature's own owner and revoked with it — which is
 * the whole reason `defineContextKey` takes an owner at all: the vocabulary
 * used to be global and permanent, so a feature that minted a key threw on the
 * hot re-import that #21 §4 requires, on an id its own previous incarnation
 * held.
 *
 * `terrain.verb` is the verb in effect, whichever mode is active. It is the
 * feature's because the meaning of "the verb" is the terrain tool's: the host
 * mints `tools.terrainMode` and knows nothing about ramps. Its VALUE is
 * derived per dispatch from the tool parameters, in `FeatureInstance.keys`,
 * and never held (#8's finding 2).
 *
 * Minted by a CALL from `index.ts` rather than at this module's scope, like
 * every other declaration in this package, and for a reason that only shows up
 * under HMR: a hot update re-executes the module that CHANGED, not the modules
 * it imports. A `defineContextKey` at this file's top level would therefore
 * not re-run when `index.ts` is re-imported — but its owner's `dispose` would
 * already have revoked it, leaving the feature short a key with no error
 * anywhere. Everything the owner declares is re-declared by the same call that
 * re-mints the owner.
 */

import { defineContextKey, type ContextKey, type KeyValue, type OwnerId } from '@map-editor/registry'

import type { PaintVerb, SculptVerb, TerrainMode } from './verbs'

export type TerrainVerb = SculptVerb | PaintVerb

let verb: ContextKey<TerrainVerb> | null = null
let mode: ContextKey<TerrainMode> | null = null

export function defineTerrainKeys(owner: OwnerId): void {
  verb = defineContextKey<TerrainVerb>(owner, 'terrain.verb', 'raise')
  // The mode under the feature's own owner, for a panel's `when`: the host
  // mints one too, but a feature may not import the host to name it.
  mode = defineContextKey<TerrainMode>(owner, 'terrain.mode', 'sculpt')
}

function minted<T extends KeyValue>(key: ContextKey<T> | null): ContextKey<T> {
  if (!key) throw new Error('terrain context keys are not minted yet: defineTerrainKeys(owner) runs first, in index.ts')
  return key
}

/**
 * The minted keys, for a `when` predicate. Reading one before
 * `defineTerrainKeys` has run is a module-ordering mistake rather than a state
 * to handle, so it throws rather than minting under an owner nobody chose.
 */
export const terrainKeys = {
  get verb(): ContextKey<TerrainVerb> {
    return minted(verb)
  },
  get mode(): ContextKey<TerrainMode> {
    return minted(mode)
  },
}
