/**
 * Edits and undo.
 *
 * An `Edit` is one entry on the undo stack: a completed change to the document
 * together with its exact inverse. It is the *output* of an interaction, where
 * a command — the named, remappable thing a keybinding or a test invokes — is
 * the input to one. Commands live elsewhere; nothing in this file knows about
 * them.
 *
 * Every edit is a list of patches applied to the document. The applier reads
 * the previous value of each address it touches and builds the inverse as it
 * goes, so a tool gets undo and redo by describing what it wants to change and
 * nothing else. No tool writes an `undo()` method.
 *
 * Patches are intentionally addressed at the same granularity as the document:
 * one cell field, one paint key, one object. That keeps the inverse exact and
 * makes a brush stroke a flat list of small writes which coalesce cleanly.
 */

import type { MapDoc, MapObject, ReadonlyMapDoc } from './document'

export type TerrainField = 'height' | 'material' | 'ramp' | 'water'
export type PaintLayer = 'top' | 'cliff' | 'tint'
export type DocField = 'name' | 'texelDensity' | 'filtering' | 'camera' | 'atmosphere' | 'materials'

export type Patch =
  | { t: 'terrain'; field: TerrainField; index: number; value: number }
  | { t: 'paint'; layer: PaintLayer; key: string; value: number | undefined }
  | { t: 'object'; id: string; value: MapObject | undefined }
  | { t: 'objectOrder'; value: string[] }
  | { t: 'doc'; field: DocField; value: unknown }

export interface Edit {
  label: string
  patches: Patch[]
  inverse: Patch[]
}

/** An `Edit` without its label: what a stroke hands back on release, labelled by the store from `beginStroke`. */
export type StrokeRecord = Pick<Edit, 'patches' | 'inverse'>

/**
 * The slot a patch writes, as a key. Two patches with equal keys overwrite
 * each other, which is what makes per-address compaction lossless: within
 * one stroke only the last forward value and the first before-value can ever
 * be observed (#11). The stroke actor in `editor-host` keys its map on this.
 */
export function patchAddress(patch: Patch): string {
  switch (patch.t) {
    case 'terrain':
      return `terrain:${patch.field}:${patch.index}`
    case 'paint':
      return `paint:${patch.layer}:${patch.key}`
    case 'object':
      return `object:${patch.id}`
    case 'objectOrder':
      return 'objectOrder'
    case 'doc':
      return `doc:${patch.field}`
  }
}

/**
 * The patch that would undo `patch` were it applied to `doc` now: the
 * before-value at its address. Reads only, so it takes the readonly view and
 * a holder of `reader` can compute an inverse BEFORE sending the forward
 * patch — the stroke actor needs exactly that to record `first` without ever
 * seeing the writer.
 *
 * The two casts re-wrap values the readonly view narrowed: the inverse puts
 * the same object or array reference back wholesale, and `DeepReadonly` is a
 * promise about who writes, not a different runtime shape.
 */
export function inversePatch(doc: ReadonlyMapDoc, patch: Patch): Patch {
  switch (patch.t) {
    case 'terrain':
      return { t: 'terrain', field: patch.field, index: patch.index, value: doc.terrain[patch.field][patch.index] }
    case 'paint':
      return { t: 'paint', layer: patch.layer, key: patch.key, value: doc.paint[patch.layer][patch.key] }
    case 'object':
      return { t: 'object', id: patch.id, value: doc.objects[patch.id] as MapObject | undefined }
    case 'objectOrder':
      return { t: 'objectOrder', value: doc.objectOrder as string[] }
    case 'doc':
      return { t: 'doc', field: patch.field, value: (doc as unknown as Record<string, unknown>)[patch.field] }
  }
}

/** Apply one patch, returning the patch that undoes it. */
function applyPatch(doc: MapDoc, patch: Patch): Patch {
  const inverse = inversePatch(doc, patch)
  switch (patch.t) {
    case 'terrain':
      doc.terrain[patch.field][patch.index] = patch.value
      break
    case 'paint': {
      const layer = doc.paint[patch.layer]
      if (patch.value === undefined) delete layer[patch.key]
      else layer[patch.key] = patch.value
      break
    }
    case 'object':
      if (patch.value === undefined) delete doc.objects[patch.id]
      else doc.objects[patch.id] = patch.value
      break
    case 'objectOrder':
      doc.objectOrder = patch.value
      break
    case 'doc':
      ;(doc as unknown as Record<string, unknown>)[patch.field] = patch.value
      break
  }
  return inverse
}

/**
 * Apply patches in order and return their inverse, in reverse order so that
 * replaying it undoes the whole list even when two patches touch the same
 * address.
 */
export function applyPatches(doc: MapDoc, patches: Patch[]): Patch[] {
  const inverse: Patch[] = []
  for (const patch of patches) inverse.push(applyPatch(doc, patch))
  inverse.reverse()
  return inverse
}

/**
 * Drop patches that change nothing. A brush dragged back and forth over the
 * same cell would otherwise fill the undo stack with no-ops and mark chunks
 * dirty for no reason.
 */
export function pruneNoops(doc: MapDoc, patches: Patch[]): Patch[] {
  return patches.filter((patch) => {
    switch (patch.t) {
      case 'terrain':
        return doc.terrain[patch.field][patch.index] !== patch.value
      case 'paint':
        return doc.paint[patch.layer][patch.key] !== patch.value
      case 'object':
        return doc.objects[patch.id] !== patch.value
      default:
        return true
    }
  })
}

export class History {
  private undoStack: Edit[] = []
  private redoStack: Edit[] = []
  private limit: number

  constructor(limit = 200) {
    this.limit = limit
  }

  push(edit: Edit): void {
    this.undoStack.push(edit)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack.length = 0
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null
  }

  redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null
  }

  undo(doc: MapDoc): Edit | null {
    const edit = this.undoStack.pop()
    if (!edit) return null
    applyPatches(doc, edit.inverse)
    this.redoStack.push(edit)
    return edit
  }

  redo(doc: MapDoc): Edit | null {
    const edit = this.redoStack.pop()
    if (!edit) return null
    applyPatches(doc, edit.patches)
    this.undoStack.push(edit)
    return edit
  }

  clear(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
  }
}
