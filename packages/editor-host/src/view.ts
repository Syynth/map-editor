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
 *
 * `select` is the same write arriving by the host-internal door, for the
 * object tool, which selects from inside a stroke effect where re-entering
 * `dispatch` would run the registry's resolution inside an enqueued effect.
 * It carries the id as a TYPE rather than as `args: unknown`, so the shape is
 * checked at the call site instead of by a cast. It is not a second command
 * path — no id, no registry, and no ref outside this package to send it (#8).
 */

import { MAX_HEIGHT, MIN_HEIGHT } from '@map-editor/document'
import { commands, defineContextKey, reserveOwner } from '@map-editor/registry'
import { setup, types } from 'xstate'
import { z } from 'zod'

export const VIEW_OWNER = reserveOwner('editor-host.view')

/**
 * `gameCamera` is a context key and the other two toggles are not, for one
 * reason: `G` toggles it, and a toggle is two bindings on one chord, each
 * gated on the value it flips away from (#14's fall-through). A key exists
 * because a predicate needs to name it; the grid and the open inspector tab
 * gate nothing, so neither gets one.
 */
export const viewKeys = {
  hasSelection: defineContextKey(VIEW_OWNER, 'view.hasSelection', false),
  gameCamera: defineContextKey(VIEW_OWNER, 'view.gameCamera', false),
}

/**
 * Every field is `exactOptional`, not `.partial()`: a key that is absent is
 * "leave it alone", but a key that is present with the value `undefined` is
 * rejected — `.partial()` would let it through and the context patch would
 * write `undefined` over a boolean. `undefined` is not JSON, so the schema
 * refuses it the same way it refuses a stray key (#23).
 */
/**
 * The layer view's range, in half-tiles (the document's height unit), or
 * `null` for the whole map. Both ends are validated against the document's
 * own bounds, and a range whose floor is above its ceiling is refused here
 * rather than clamped somewhere downstream.
 */
const layerRange = z
  .object({ lo: z.int().min(MIN_HEIGHT).max(MAX_HEIGHT), hi: z.int().min(MIN_HEIGHT).max(MAX_HEIGHT) })
  .strict()
  .refine((range) => range.lo <= range.hi, { message: 'lo must not exceed hi' })

const viewSettings = z
  .object({
    showGrid: z.boolean().exactOptional(),
    gameCamera: z.boolean().exactOptional(),
    inspector: z.enum(['properties', 'coverage', 'atmosphere', 'outliner']).exactOptional(),
    layers: layerRange.nullable().exactOptional(),
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
    events: {
      command: types<{ id: string; args: unknown }>(),
      select: types<{ id: string | null }>(),
    },
  },
}).createMachine({
  id: 'view',
  context: { showGrid: true, gameCamera: false, inspector: 'properties', layers: null, selectedObjectId: null },
  initial: 'ready',
  states: {
    ready: {
      on: {
        command: ({ event }) => {
          if (event.id === 'view.set') return { context: event.args as ViewSettings }
          if (event.id === 'selection.set') return { context: { selectedObjectId: (event.args as z.infer<typeof selection>).id } }
          return undefined
        },
        select: ({ event }) => ({ context: { selectedObjectId: event.id } }),
      },
    },
  },
})

export type ViewLogic = typeof viewLogic
