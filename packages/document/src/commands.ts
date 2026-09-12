/**
 * The document's own commands (#3, #66 step 3).
 *
 * `registry` sits below this package precisely so the document can declare
 * what it handles without the host's help: `undo` and `redo` are the
 * document actor's, so their declarations live beside it, under an owner id
 * this package reserves and never exports a way to dispose. The host routes
 * a command by its declaring owner (#8), which is why the owner id is
 * exported — it is the key the host spawns the document actor under.
 *
 * The two context keys are the document's contribution to the availability
 * vocabulary. The host derives their values from `reader` on every dispatch,
 * never from a held snapshot (#8's finding 2); this file only mints the keys
 * so a predicate can name them and a disabled Undo button can say why.
 */

import { commands, defineContextKey, reserveOwner } from '@map-editor/registry'

export const DOCUMENT_OWNER = reserveOwner('document')

export const documentKeys = {
  canUndo: defineContextKey('document.canUndo', false),
  canRedo: defineContextKey('document.canRedo', false),
}

commands.declare(DOCUMENT_OWNER, { id: 'undo', title: 'Undo', category: 'Edit', when: documentKeys.canUndo.is(true) })
commands.declare(DOCUMENT_OWNER, { id: 'redo', title: 'Redo', category: 'Edit', when: documentKeys.canRedo.is(true) })
