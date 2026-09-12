/**
 * The terrain tool's `ToolContract` — the handler half of #9's split, and the
 * seam #66 step 3 left open: a `ToolDecl` says the tool exists and is
 * enumerable before anything runs, while this says what a stroke with it DOES
 * and cannot exist before the deps do.
 *
 * The contract is deliberately STATEFUL per stroke (registry `tools.ts`): the
 * rectangle anchor, the height sampled at the press, and the cell the last
 * tick edited live on the handler and die with it. The host's stroke actor
 * calls each phase exactly once, inside `enq`, and forwards the patches to the
 * document actor — this package never applies anything and never sees a
 * writer.
 *
 * The sample type is named here rather than imported: #35 forbids reaching
 * into `editor-host`, so the feature states the narrowest shape it reads and
 * structural typing makes the host's richer one fit. `ToolContract.stroke` is
 * a METHOD for the same reason `create` is (registry `feature.ts`): parameter
 * bivariance is what lets the host hand this its own richer `StrokeSample`.
 *
 * This is the only terrain stroke there is. The host's stroke actor reaches it
 * through `Host.toolContract('terrain')` and holds no copy of a terrain verb;
 * `verbs.ts` underneath is shared with the commands, so the stroke form and
 * the command form of a verb cannot drift from each other either.
 */

import { cellIndex, inBounds, type Cell, type Patch, type SurfaceAddress } from '@map-editor/document'
import type { FeatureDeps, StrokeHandler, ToolContract } from './deps'
import { eyedrop, paintPatches, sculptPatches, strokeCells, terrainLabel, type TerrainModifiers } from './verbs'

/** One tick's input: what the pointer is over, and the modifiers held at that instant. */
export interface TerrainSample {
  readonly pick: { readonly surface: SurfaceAddress | null }
  readonly modifiers: TerrainModifiers
}

export type TerrainStrokeHandler = StrokeHandler<TerrainSample, Patch>

function addressKey(address: SurfaceAddress): string {
  return `${address.x},${address.y},${address.kind},${address.dir},${address.level}`
}

function handlerFor(deps: FeatureDeps, press: TerrainSample): TerrainStrokeHandler {
  const doc = deps.doc()
  const address = press.pick.surface
  /** Anchor cell for rectangle strokes, and the corner a rectangle preview grows from. */
  const anchor: Cell | null = address ? [address.x, address.y] : null
  /** Height sampled when the stroke began, for flatten. */
  const anchorHeight = address && inBounds(doc.size, address.x, address.y) ? doc.terrain.height[cellIndex(doc.size, address.x, address.y)] : 0
  /** Cell last edited, so a drag does not re-apply to the same cell. */
  let lastCell: string | null = null

  function tick(sample: TerrainSample, phase: 'start' | 'move' | 'end'): Patch[] {
    const address = sample.pick.surface
    if (!address) return []

    if (sample.modifiers.alt) {
      // The eyedropper changes a tool parameter, not the document, so it
      // leaves through `setParams` — an event at the tools actor — and the
      // stroke produces no patches at all.
      if (phase === 'start') deps.setParams(eyedrop(deps.doc(), deps.params(), address))
      return []
    }

    const params = deps.params()
    // Rectangle strokes only commit on release; everything else is live.
    if (params.strokeShape === 'rect' && phase !== 'end') return []
    if (params.strokeShape !== 'rect' && phase === 'end') return []

    const key = addressKey(address)
    if (phase === 'move' && lastCell === key) return []
    lastCell = key

    // Read per tick, not captured at the press: `]` mid-drag widens the brush,
    // as it always did.
    const doc = deps.doc()
    const cells = strokeCells(doc, params, address, anchor)
    return params.terrainMode === 'sculpt'
      ? sculptPatches(doc, params, address, cells, sample.modifiers, anchorHeight)
      : paintPatches(doc, params, address, cells, sample.modifiers)
  }

  return {
    label: terrainLabel(deps.params(), press.modifiers),
    begin: (sample) => tick(sample, 'start'),
    move: (sample) => tick(sample, 'move'),
    end: (sample) => tick(sample, 'end'),
  }
}

/**
 * The contract for the `terrain` tool. A press that missed the terrain
 * declines (`undefined`), which is what lets the host's arbitration treat it
 * as a click or an orbit instead of spawning a stroke over nothing.
 */
export function terrainContract(deps: FeatureDeps): ToolContract<TerrainSample, Patch> {
  return {
    stroke: (sample) => (sample.pick.surface ? handlerFor(deps, sample) : undefined),
  }
}
