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

import { SURFACE_TOP, cellIndex, inBounds, type Cell, type Patch, type SurfaceAddress, structureOf, type ReadonlyVoxel } from '@map-editor/document'
import type { FeatureDeps, StrokeHandler, ToolContract } from './deps'
import { eyedrop, paintPatches, sculptPatches, strokeCells, terrainLabel, type TerrainModifiers } from './verbs'

/** One tick's input: what the pointer is over, and the modifiers held at that instant. */
export interface TerrainSample {
  readonly pick: {
    readonly surface: SurfaceAddress | null
    /** Mid-stroke, the pointer on the horizontal plane through the press's hit; what a sculpt stroke steers by. */
    readonly plane?: { readonly x: number; readonly z: number } | null
  }
  readonly modifiers: TerrainModifiers
}

export type TerrainStrokeHandler = StrokeHandler<TerrainSample, Patch>

function addressKey(address: SurfaceAddress): string {
  return `${address.x},${address.y},${address.kind},${address.dir},${address.level}`
}

/**
 * Whether the pointer, at `point` on the press plane, has moved from `from`
 * into another cell by more than `deadZone` along every axis it crossed.
 * Measured from the boundary it crossed, so a pointer hovering on a line
 * does not flip cells with every pixel, and one crossing a corner has to
 * clear both edges. `null` while it has not.
 */
export function cellPast(from: Cell, point: { readonly x: number; readonly z: number }, deadZone: number): Cell | null {
  const cx = Math.floor(point.x)
  const cz = Math.floor(point.z)
  if (cx === from[0] && cz === from[1]) return null
  if (cx !== from[0]) {
    const inside = cx > from[0] ? point.x - cx : cx + 1 - point.x
    if (inside < deadZone) return null
  }
  if (cz !== from[1]) {
    const inside = cz > from[1] ? point.z - cz : cz + 1 - point.z
    if (inside < deadZone) return null
  }
  return [cx, cz]
}

/** The top of `cell`, as the address a sculpt verb targets when it was steered there by the plane rather than by a pick. */
const topOf = (structure: string, [x, y]: Cell): SurfaceAddress => ({ structure, x, y, kind: SURFACE_TOP, dir: 0, level: 0 })

function handlerFor(deps: FeatureDeps, press: TerrainSample, voxel: ReadonlyVoxel): TerrainStrokeHandler {
  const address = press.pick.surface
  /** Anchor cell for rectangle strokes, and the corner a rectangle preview grows from. */
  const anchor: Cell | null = address ? [address.x, address.y] : null
  /** Height sampled when the stroke began, for flatten. */
  const anchorHeight = address && inBounds(voxel.size, address.x, address.y) ? voxel.terrain.height[cellIndex(voxel.size, address.x, address.y)] : 0
  /** Cell last edited, so a drag does not re-apply to the same cell. */
  let lastCell: string | null = null
  /** The cell a sculpt stroke is on, steered by the press plane; `null` until a tick lands one. */
  let steered: Cell | null = null

  /**
   * A sculpt stroke (raise, flatten, water) is steered by where the pointer
   * is on the press plane, not by what the ray hits: raising a cell puts a
   * taller face under the cursor, and picking that face is what made the
   * stroke re-fire on the cell it had just raised. It moves to the next cell
   * only once the pointer is `sculptDeadZone` past the boundary. Ramp and
   * paint keep the pick, since they target faces.
   */
  function steer(sample: TerrainSample): SurfaceAddress | null {
    const params = deps.params()
    const surface = sample.pick.surface
    if (params.terrainMode !== 'sculpt' || params.sculptVerb === 'ramp') return surface
    const plane = sample.pick.plane
    if (plane === undefined || plane === null) {
      // No plane — a press, or no camera: the pick decides, by cell only.
      if (surface) steered = [surface.x, surface.y]
      return surface ? topOf(voxel.id, [surface.x, surface.y]) : null
    }
    if (steered === null) steered = [Math.floor(plane.x), Math.floor(plane.z)]
    else {
      const next = cellPast(steered, plane, params.sculptDeadZone)
      if (next !== null && inBounds(voxel.size, next[0], next[1])) steered = next
    }
    return topOf(voxel.id, steered)
  }

  function tick(sample: TerrainSample, phase: 'start' | 'move' | 'end'): Patch[] {
    const address = steer(sample)
    if (!address) return []

    if (sample.modifiers.alt) {
      // The eyedropper changes a tool parameter, not the document, so it
      // leaves through `setParams` — an event at the tools actor — and the
      // stroke produces no patches at all.
      if (phase === 'start') deps.setParams(eyedrop(deps.doc(), voxel, deps.params(), address))
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
    const cells = strokeCells(voxel, params, address, anchor)
    return params.terrainMode === 'sculpt'
      ? sculptPatches(doc, voxel, params, address, cells, sample.modifiers, anchorHeight)
      : paintPatches(voxel, params, address, cells, sample.modifiers)
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
    stroke: (sample) => {
      // The tool addresses the voxel volume the press landed on; a press on any other kind of structure is not its stroke.
      const surface = sample.pick.surface
      const voxel = surface ? structureOf(deps.doc(), surface.structure, 'voxel') : undefined
      return voxel ? handlerFor(deps, sample, voxel) : undefined
    },
  }
}
