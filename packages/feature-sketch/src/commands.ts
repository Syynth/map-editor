/**
 * The feature's commands: its parameters, and the two verbs the pen needs
 * beyond the document's own sketch commands — finish the open outline, or
 * abandon it. The document owns `sketch.new`, `sketch.point.*`,
 * `sketch.close` and `sketch.set`; these are the tool's, not the data's.
 */

import { commands, type OwnerId } from '@papercut/registry'
import { z } from 'zod'

const sketchParams = z
  .object({
    sketchMode: z.enum(['draw', 'edit']).exactOptional(),
    sketchSnap: z.enum(['grid', 'half', 'free']).exactOptional(),
  })
  .strict()

export type SketchParamsChange = z.infer<typeof sketchParams>

export function declareSketchCommands(owner: OwnerId): void {
  commands.declare(owner, { id: 'sketch.params', title: 'Set Sketch Parameters', category: 'Sketch', args: sketchParams })
  commands.declare(owner, { id: 'sketch.finish', title: 'Finish Sketch', category: 'Sketch' })
  commands.declare(owner, { id: 'sketch.cancel', title: 'Cancel Sketch', category: 'Sketch' })
}
