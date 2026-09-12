/**
 * The view actor: what the editor is showing (#11).
 *
 * The three view toggles from `EditorState` — the grid, the game camera, and
 * which right-hand panel is open — plus the selection. Selection lives here
 * rather than on the tools actor because it is a fact about what the user is
 * looking at, not about how a stroke behaves; and because #11 rules that
 * handlers NEVER read it. The UI reads `selectedObjectId` to fill in a
 * command's arguments — `objects.delete({ ids })`, never `objects.delete()`
 * acting on ambient selection — which is the map's argument convention
 * doing real work. So the actor holds the id and mints `hasSelection` for
 * the palette to grey things out with, and that is all a command ever learns
 * about selection from this side.
 *
 * Two commands: `view.set` for the toggles and `selection.set` for the id.
 * Both are pure context patches; nothing here calls `enq`.
 */

import { commands, defineContextKey, reserveOwner } from '@map-editor/registry'
import { setup, types } from 'xstate'
import { z } from 'zod'

export const VIEW_OWNER = reserveOwner('editor-host.view')

export const viewKeys = {
  hasSelection: defineContextKey('view.hasSelection', false),
}

/**
 * Every field is `exactOptional`, not `.partial()`: a key that is absent is
 * "leave it alone", but a key that is present with the value `undefined` is
 * rejected — `.partial()` would let it through and the context patch would
 * write `undefined` over a boolean. `undefined` is not JSON, so the schema
 * refuses it the same way it refuses a stray key (#23).
 */
const viewSettings = z
  .object({
    showGrid: z.boolean().exactOptional(),
    gameCamera: z.boolean().exactOptional(),
    inspector: z.enum(['properties', 'coverage', 'atmosphere', 'outliner']).exactOptional(),
  })
  .strict()

export type ViewSettings = z.infer<typeof viewSettings>

/** A stable object id, or `null` to clear. Whether the id exists is the document's question, asked by whoever fills it in. */
const selection = z.object({ id: z.string().min(1).nullable() }).strict()

export interface ViewContext extends Required<ViewSettings> {
  readonly selectedObjectId: string | null
}

commands.declare(VIEW_OWNER, { id: 'view.set', title: 'Set View Options', category: 'View', args: viewSettings })
commands.declare(VIEW_OWNER, { id: 'selection.set', title: 'Select Object', category: 'Selection', args: selection })

export const viewLogic = setup({
  schemas: {
    context: types<ViewContext>(),
    events: { command: types<{ id: string; args: unknown }>() },
  },
}).createMachine({
  id: 'view',
  context: { showGrid: true, gameCamera: false, inspector: 'properties', selectedObjectId: null },
  initial: 'ready',
  states: {
    ready: {
      on: {
        command: ({ event }) => {
          if (event.id === 'view.set') return { context: event.args as ViewSettings }
          if (event.id === 'selection.set') return { context: { selectedObjectId: (event.args as z.infer<typeof selection>).id } }
          return undefined
        },
      },
    },
  },
})

export type ViewLogic = typeof viewLogic
