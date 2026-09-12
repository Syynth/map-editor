/**
 * The terrain commands: the verbs as an intent layer (#5, #8, #23).
 *
 * A command is what a palette, a keybinding and a test all invoke identically,
 * so every one of these takes its target as PLAIN SERIALISABLE DATA and reads
 * nothing ambient — `terrain.raise({ cells, delta })`, never "raise whatever
 * the brush is over with whatever the verb bar says". The tool parameters that
 * a stroke reads (brush size, the active verb, the selected tile) are the
 * stroke's business, not a command's; they reach this package through
 * `FeatureDeps.params()` and appear here only as the arguments a UI fills in.
 *
 * Erasure is `null`, not an absent key: `undefined` is not JSON and the
 * schemas refuse it (#23), so "clear the paint here" has to be a value a
 * recorded session can carry. The ops take `undefined`, which is where the two
 * spellings meet — at the boundary, once, rather than in every caller.
 */

import {
  MAX_HEIGHT,
  MIN_HEIGHT,
  NO_RAMP,
  flatten,
  paintCliff,
  paintTint,
  paintTop,
  raise,
  setMaterial,
  setRamp,
  setWater,
  type Patch,
  type ReadonlyMapDoc,
} from '@map-editor/document'
import { commands, type OwnerId } from '@map-editor/registry'
import { z } from 'zod'

/**
 * A cell address, as a pair. Bounds are the document's question — `cellIndex`
 * and the ops clamp or skip what is off the map — so the schema checks the
 * shape and the sign, which is what it can check without a document.
 */
const cell = z.tuple([z.int().min(0), z.int().min(0)])
const cells = z.array(cell).min(1)

/** One cliff band: a cell, the face it points along, and the level on that face. */
const face = z.object({ x: z.int().min(0), y: z.int().min(0), dir: z.int().min(0).max(3), level: z.int().min(0) }).strict()

const raiseArgs = z.object({ cells, delta: z.int().min(-MAX_HEIGHT).max(MAX_HEIGHT) }).strict()
const flattenArgs = z.object({ cells, height: z.int().min(MIN_HEIGHT).max(MAX_HEIGHT) }).strict()
const rampArgs = z.object({ cells, dir: z.int().min(NO_RAMP).max(3) }).strict()
const waterArgs = z.object({ cells, level: z.int().min(MIN_HEIGHT).max(MAX_HEIGHT).nullable() }).strict()
const materialArgs = z.object({ cells, material: z.int().min(0) }).strict()
const topArgs = z.object({ cells, tile: z.int().min(0).nullable() }).strict()
const cliffArgs = z.object({ faces: z.array(face).min(1), tile: z.int().min(0).nullable() }).strict()
const tintArgs = z.object({ cells, tint: z.int().min(0).max(0xffffff).nullable() }).strict()

/**
 * Declared at import, under the feature's owner, and revoked with it. No
 * `when`: a terrain verb reads its whole target from its arguments, so there
 * is no state in which one of these is meaningless — which tool is selected
 * decides what a POINTER does, not what a command may do.
 */
export function declareTerrainCommands(owner: OwnerId): void {
  commands.declare(owner, { id: 'terrain.raise', title: 'Raise Terrain', category: 'Terrain', args: raiseArgs })
  commands.declare(owner, { id: 'terrain.flatten', title: 'Flatten Terrain', category: 'Terrain', args: flattenArgs })
  commands.declare(owner, { id: 'terrain.ramp', title: 'Set Ramp', category: 'Terrain', args: rampArgs })
  commands.declare(owner, { id: 'terrain.water', title: 'Set Water', category: 'Terrain', args: waterArgs })
  commands.declare(owner, { id: 'terrain.material', title: 'Set Material', category: 'Terrain', args: materialArgs })
  commands.declare(owner, { id: 'terrain.paint.top', title: 'Paint Tile', category: 'Terrain', args: topArgs })
  commands.declare(owner, { id: 'terrain.paint.cliff', title: 'Paint Cliff Band', category: 'Terrain', args: cliffArgs })
  commands.declare(owner, { id: 'terrain.paint.tint', title: 'Tint Cells', category: 'Terrain', args: tintArgs })
}

/** One command's effect: its undo label and the patches it produces. */
export interface TerrainEdit {
  readonly label: string
  readonly patches: Patch[]
}

/**
 * What a routed command means, as data. The actor turns this into one
 * `deps.apply`; nothing here writes, and an id this owner never declared
 * answers `undefined` so the actor can refuse it with v6's "not enabled"
 * shape rather than dropping it inside an effect.
 *
 * `args` is trusted: the host validated it against the schema above before
 * routing (#23), which is what the casts rest on.
 */
export function terrainEdit(doc: ReadonlyMapDoc, id: string, args: unknown): TerrainEdit | undefined {
  switch (id) {
    case 'terrain.raise': {
      const { cells, delta } = args as z.infer<typeof raiseArgs>
      return { label: delta < 0 ? 'Lower' : 'Raise', patches: raise(doc, cells, delta) }
    }
    case 'terrain.flatten': {
      const { cells, height } = args as z.infer<typeof flattenArgs>
      return { label: 'Flatten', patches: flatten(doc, cells, height) }
    }
    case 'terrain.ramp': {
      const { cells, dir } = args as z.infer<typeof rampArgs>
      return { label: 'Toggle ramp', patches: dir < 0 ? [] : setRamp(doc, cells, dir) }
    }
    case 'terrain.water': {
      const { cells, level } = args as z.infer<typeof waterArgs>
      return { label: level === null ? 'Remove water' : 'Carve water', patches: setWater(doc, cells, level) }
    }
    case 'terrain.material': {
      const { cells, material } = args as z.infer<typeof materialArgs>
      return { label: 'Set material', patches: setMaterial(doc, cells, material) }
    }
    case 'terrain.paint.top': {
      const { cells, tile } = args as z.infer<typeof topArgs>
      return { label: tile === null ? 'Clear paint' : 'Paint', patches: paintTop(doc, cells, tile ?? undefined) }
    }
    case 'terrain.paint.cliff': {
      const { faces, tile } = args as z.infer<typeof cliffArgs>
      return { label: tile === null ? 'Clear paint' : 'Paint', patches: paintCliff(doc, faces, tile ?? undefined) }
    }
    case 'terrain.paint.tint': {
      const { cells, tint } = args as z.infer<typeof tintArgs>
      return { label: tint === null ? 'Clear tint' : 'Tint', patches: paintTint(doc, cells, tint ?? undefined) }
    }
    default:
      return undefined
  }
}
