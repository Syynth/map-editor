/**
 * The editor store.
 *
 * The document is held mutably and edits bump a revision counter, rather than
 * the document being replaced immutably on every change. That is a deliberate
 * trade: a brush stroke writes a handful of cells sixty times a second, and
 * deep-cloning parallel arrays of tens of thousands of entries per tick is
 * exactly the wrong cost to pay for reference equality. React subscribes to
 * the revision through `useSyncExternalStore` instead.
 *
 * The store also tracks which chunks a change dirtied, so the viewport can
 * remesh only what moved.
 */

import {
  applyPatches,
  pruneNoops,
  History,
  type Patch,
} from './edits'
import type { MapDoc } from './document'
import { CHUNK_SIZE, chunkKey } from './chunks'

type Listener = () => void

export class EditorStore {
  doc: MapDoc
  revision = 0
  history = new History()

  private listeners = new Set<Listener>()
  private dirtyChunks = new Set<string>()
  private stroke: { label: string; patches: Patch[]; inverse: Patch[] } | null = null

  constructor(doc: MapDoc) {
    this.doc = doc
    this.markAllDirty()
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): number => this.revision

  private emit(): void {
    this.revision += 1
    for (const listener of this.listeners) listener()
  }

  /** Replace the whole document, as on load or new map. Clears history. */
  replace(doc: MapDoc): void {
    this.doc = doc
    this.history.clear()
    this.stroke = null
    this.markAllDirty()
    this.emit()
  }

  markAllDirty(): void {
    const { width, height } = this.doc.size
    for (let cy = 0; cy < Math.ceil(height / CHUNK_SIZE); cy++) {
      for (let cx = 0; cx < Math.ceil(width / CHUNK_SIZE); cx++) {
        this.dirtyChunks.add(chunkKey(cx, cy))
      }
    }
  }

  takeDirtyChunks(): string[] {
    const out = [...this.dirtyChunks]
    this.dirtyChunks.clear()
    return out
  }

  hasDirtyChunks(): boolean {
    return this.dirtyChunks.size > 0
  }

  /**
   * A cell edit can change the mesh of the chunk next door — cliff faces are
   * emitted against a neighbour's height, and baked AO samples diagonals — but
   * only when the edited cell actually sits on a chunk border.
   *
   * Dirtying the whole 3x3 neighbourhood unconditionally costs about 6.9 ms a
   * tick on a 128x128 map, which is 40% of a frame. Restricting it to border
   * cells makes the common case one chunk at ~1 ms and leaves the 9-chunk
   * worst case for the rare stroke that lands exactly on a chunk corner.
   */
  private dirtyCell(x: number, y: number): void {
    const cx = Math.floor(x / CHUNK_SIZE)
    const cy = Math.floor(y / CHUNK_SIZE)
    this.dirtyChunks.add(chunkKey(cx, cy))

    const lx = x - cx * CHUNK_SIZE
    const ly = y - cy * CHUNK_SIZE
    const west = lx === 0
    const east = lx === CHUNK_SIZE - 1
    const north = ly === 0
    const south = ly === CHUNK_SIZE - 1
    if (!west && !east && !north && !south) return

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === -1 && !west) continue
        if (dx === 1 && !east) continue
        if (dy === -1 && !north) continue
        if (dy === 1 && !south) continue
        this.dirtyChunks.add(chunkKey(cx + dx, cy + dy))
      }
    }
  }

  private dirtyFromPatch(patch: Patch): void {
    if (patch.t === 'terrain') {
      const width = this.doc.size.width
      this.dirtyCell(patch.index % width, Math.floor(patch.index / width))
    } else if (patch.t === 'paint') {
      const [x, y] = patch.key.split(',').map(Number)
      this.dirtyCell(x, y)
    } else if (patch.t === 'doc' && (patch.field === 'materials' || patch.field === 'texelDensity')) {
      this.markAllDirty()
    }
  }

  /**
   * Apply an edit. Inside a stroke the patches accumulate into one undo entry;
   * outside one they commit immediately.
   */
  apply(label: string, patches: Patch[]): void {
    const pruned = pruneNoops(this.doc, patches)
    if (pruned.length === 0) return

    const inverse = applyPatches(this.doc, pruned)
    for (const patch of pruned) this.dirtyFromPatch(patch)

    if (this.stroke) {
      this.stroke.patches.push(...pruned)
      // Inverses accumulate front-to-back so replaying the list unwinds the
      // whole stroke in reverse order.
      this.stroke.inverse.unshift(...inverse)
    } else {
      this.history.push({ label, patches: pruned, inverse })
    }
    this.emit()
  }

  /** Coalesce everything until `endStroke` into a single undo entry. */
  beginStroke(label: string): void {
    if (this.stroke) this.endStroke()
    this.stroke = { label, patches: [], inverse: [] }
  }

  endStroke(): void {
    const stroke = this.stroke
    this.stroke = null
    if (!stroke || stroke.patches.length === 0) return
    this.history.push(stroke)
    this.emit()
  }

  get inStroke(): boolean {
    return this.stroke !== null
  }

  undo(): void {
    if (this.stroke) this.endStroke()
    const command = this.history.undo(this.doc)
    if (!command) return
    for (const patch of command.inverse) this.dirtyFromPatch(patch)
    this.emit()
  }

  redo(): void {
    const command = this.history.redo(this.doc)
    if (!command) return
    for (const patch of command.patches) this.dirtyFromPatch(patch)
    this.emit()
  }
}
