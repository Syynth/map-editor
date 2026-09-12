/**
 * The document's own commands (#3, #66 step 3).
 *
 * `registry` sits below this package precisely so the document can declare
 * what it handles without the host's help: `undo`, `redo` and
 * `objects.delete` are the document actor's — everything whose effect is one
 * call on the write handle — so their declarations live beside it, under an owner id
 * this package reserves and never exports a way to dispose. The host routes
 * a command by its declaring owner (#8), which is why the owner id is
 * exported — it is the key the host spawns the document actor under.
 *
 * The two context keys are the document's contribution to the availability
 * vocabulary. The host derives their values from `reader` on every dispatch,
 * never from a held snapshot (#8's finding 2); this file only mints the keys
 * so a predicate can name them and a disabled Undo button can say why. They
 * are minted under the same reserved owner as the commands: a key is revoked
 * with everything else its owner declared, and a reserved owner is never
 * disposed, so these two stand for the life of the process.
 */

import { commands, defineContextKey, reserveOwner } from '@map-editor/registry'
import { z } from 'zod'

export const DOCUMENT_OWNER = reserveOwner('document')

export const documentKeys = {
  canUndo: defineContextKey(DOCUMENT_OWNER, 'document.canUndo', false),
  canRedo: defineContextKey(DOCUMENT_OWNER, 'document.canRedo', false),
}

/**
 * Objects by STABLE ID, never "the selected one" (#2's argument convention).
 * Whoever invokes this fills the ids in — a keybinding through the host's
 * `selection.delete`, an inspector button from the object it is showing — so
 * the handler never reads ambient selection and a recorded session replays.
 * An id the document does not hold is dropped rather than refused: the list
 * is a request, and half a delete is not a document state any undo restores.
 */
const objectIds = z.object({ ids: z.array(z.string().min(1)).min(1) }).strict()

commands.declare(DOCUMENT_OWNER, { id: 'undo', title: 'Undo', category: 'Edit', when: documentKeys.canUndo.is(true) })
commands.declare(DOCUMENT_OWNER, { id: 'redo', title: 'Redo', category: 'Edit', when: documentKeys.canRedo.is(true) })
commands.declare(DOCUMENT_OWNER, { id: 'objects.delete', title: 'Delete Objects', category: 'Edit', args: objectIds })
