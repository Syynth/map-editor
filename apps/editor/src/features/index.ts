/**
 * The feature modules this app installs (#9, #35).
 *
 * An app is the only thing that may import a feature, and this file is where
 * that happens: the import runs the module, which declares its commands,
 * panels, tools and context keys against an owner it mints itself, and exports
 * the module value the host spawns. Discovery is an import — no manifest, no
 * scan — which is what keeps a feature's declarations enumerable before
 * anything is running (#9), and what makes adding one a one-line diff a
 * reviewer can see.
 *
 * The list is typed as the host's `Feature` here rather than in the feature,
 * which is the seam working as designed: `feature-terrain` names its own
 * document and parameter types, this line checks them against the host's, and
 * neither package imports the other.
 */

import type { Feature } from '@papercut/editor-host'
import { sketchFeature } from '@papercut/feature-sketch'
import { terrainFeature } from '@papercut/feature-terrain'

export const features: readonly Feature[] = [terrainFeature, sketchFeature]
