/**
 * Commands and undo.
 *
 * Every edit in the editor is a list of patches applied to the document. The
 * applier reads the previous value of each address it touches and builds the
 * inverse as it goes, so a tool gets undo and redo by describing what it wants
 * to change and nothing else. No tool writes an `undo()` method.
 *
 * Patches are intentionally addressed at the same granularity as the document:
 * one cell field, one paint key, one object. That keeps the inverse exact and
 * makes a brush stroke a flat list of small writes which coalesce cleanly.
 */

import type { MapDoc, MapObject } from './document'

export type TerrainField = 'height' | 'material' | 'ramp' | 'water'
export type PaintLayer = 'top' | 'cliff' | 'tint'
export type DocField = 'name' | 'texelDensity' | 'filtering' | 'camera' | 'atmosphere' | 'materials'

export type Patch =
  | { t: 'terrain'; field: TerrainField; index: number; value: number }
  | { t: 'paint'; layer: PaintLayer; key: string; value: number | undefined }
  | { t: 'object'; id: string; value: MapObject | undefined }
  | { t: 'objectOrder'; value: string[] }
  | { t: 'doc'; field: DocField; value: unknown }

export interface Command {
  label: string
  patches: Patch[]
  inverse: Patch[]
}

/** Apply one patch, returning the patch that undoes it. */
function applyPatch(doc: MapDoc, patch: Patch): Patch {
  switch (patch.t) {
    case 'terrain': {
      const arr = doc.terrain[patch.field]
      const before = arr[patch.index]
      arr[patch.index] = patch.value
      return { t: 'terrain', field: patch.field, index: patch.index, value: before }
    }
    case 'paint': {
      const layer = doc.paint[patch.layer]
      const before = layer[patch.key]
      if (patch.value === undefined) delete layer[patch.key]
      else layer[patch.key] = patch.value
      return { t: 'paint', layer: patch.layer, key: patch.key, value: before }
    }
    case 'object': {
      const before = doc.objects[patch.id]
      if (patch.value === undefined) delete doc.objects[patch.id]
      else doc.objects[patch.id] = patch.value
      return { t: 'object', id: patch.id, value: before }
    }
    case 'objectOrder': {
      const before = doc.objectOrder
      doc.objectOrder = patch.value
      return { t: 'objectOrder', value: before }
    }
    case 'doc': {
      const before = (doc as unknown as Record<string, unknown>)[patch.field]
      ;(doc as unknown as Record<string, unknown>)[patch.field] = patch.value
      return { t: 'doc', field: patch.field, value: before }
    }
  }
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
  private undoStack: Command[] = []
  private redoStack: Command[] = []
  private limit: number

  constructor(limit = 200) {
    this.limit = limit
  }

  push(command: Command): void {
    this.undoStack.push(command)
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

  undo(doc: MapDoc): Command | null {
    const command = this.undoStack.pop()
    if (!command) return null
    applyPatches(doc, command.inverse)
    this.redoStack.push(command)
    return command
  }

  redo(doc: MapDoc): Command | null {
    const command = this.redoStack.pop()
    if (!command) return null
    applyPatches(doc, command.patches)
    this.undoStack.push(command)
    return command
  }

  clear(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
  }
}
