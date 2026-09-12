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
 *
 * Two faces (#13). `reader` is what everyone sees: the document as
 * `ReadonlyMapDoc`, the revision, the subscription, and the undo-stack
 * queries a toolbar needs. `writer` is the five verbs plus `replace`, and the
 * document actor is the only thing constructed with it — `createDocumentStore`
 * is deliberately absent from the package barrel, so nothing outside
 * `packages/document` can obtain a writer at all. `doc` itself is `private`:
 * the field that used to be the enforcement hole is now unreachable from
 * outside this class, and the type system, not a convention, is what keeps a
 * consumer from writing through the reader.
 *
 * The verbs are still public methods on the class for one reason: `App.tsx`
 * calls `store.apply` directly today, and #66 keeps it doing so until step 7
 * rewires the app onto the host actor. That is a temporary second write path,
 * not a design — the class leaves the barrel with it.
 */

import {
  applyPatches,
  pruneNoops,
  History,
  type Patch,
} from './edits'
import type { MapDoc, ReadonlyMapDoc } from './document'
import { CHUNK_SIZE, chunkKey } from './chunks'

type Listener = () => void

/**
 * The read path. `doc` is the live document — mutated in place by the writer,
 * never replaced except by `replace` — so a consumer that caches it must key
 * on `revision`, which is the only thing that changes identity.
 */
export interface DocumentReader {
  readonly doc: ReadonlyMapDoc
  readonly revision: number
  subscribe(listener: Listener): () => void
  /** `useSyncExternalStore`'s second argument: the revision, as a value. */
  getSnapshot(): number
  canUndo(): boolean
  canRedo(): boolean
  undoLabel(): string | null
  redoLabel(): string | null
}

/**
 * The write path. Every mutation of the document goes through one of these
 * six calls, and the document actor is the only holder (#13). `Patch` is not
 * in the barrel either, so the type of `apply`'s second argument is namable
 * only inside this package — a consumer sends the actor what an op returned.
 */
export interface DocumentWriter {
  apply(label: string, patches: Patch[]): void
  beginStroke(label: string): void
  endStroke(): void
  undo(): void
  redo(): void
  replace(doc: MapDoc): void
}

export class EditorStore implements DocumentWriter {
  private doc: MapDoc
  revision = 0
  private history = new History()

  private listeners = new Set<Listener>()
  private dirtyChunks = new Set<string>()
  private stroke: { label: string; patches: Patch[]; inverse: Patch[] } | null = null

  /**
   * One object for the store's lifetime, so a consumer can hold it and so the
   * getters read live state — `reader.doc` after `replace` is the new
   * document, and `reader.revision` is never stale.
   */
  readonly reader: DocumentReader

  constructor(doc: MapDoc) {
    this.doc = doc
    this.markAllDirty()
    // A getter's `this` is the reader object, so the store's fields are read
    // through arrows, which bind `this` lexically. `private doc` is reachable
    // here because this is the class body — the one place it may be.
    const currentDoc = (): ReadonlyMapDoc => this.doc
    const currentRevision = (): number => this.revision
    this.reader = {
      get doc(): ReadonlyMapDoc {
        return currentDoc()
      },
      get revision(): number {
        return currentRevision()
      },
      subscribe: this.subscribe,
      getSnapshot: this.getSnapshot,
      canUndo: () => this.history.canUndo(),
      canRedo: () => this.history.canRedo(),
      undoLabel: () => this.history.undoLabel(),
      redoLabel: () => this.history.redoLabel(),
    }
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

/**
 * The one place a `writer` comes from. Not in the barrel: the document actor
 * (`actor.ts`) and this package's tests are its only callers, which is what
 * makes "exactly one module holds the write handle" a fact `grep` can check
 * rather than a convention (#13).
 *
 * `writer` is a narrowed view of the store, not the store: a holder gets the
 * six verbs and nothing else — no `reader`, no dirty-chunk bookkeeping — so
 * the two faces cannot be confused for each other by structure alone.
 */
export function createDocumentStore(doc: MapDoc): { reader: DocumentReader; writer: DocumentWriter } {
  const store = new EditorStore(doc)
  return { reader: store.reader, writer: writerOf(store) }
}

/**
 * The store's write face, for the actor factory that is handed an existing
 * `EditorStore` rather than a fresh document — `App.tsx` still owns the
 * store's construction until #66 step 7, and the actor has to write the same
 * instance the app reads.
 */
export function writerOf(store: EditorStore): DocumentWriter {
  return {
    apply: (label, patches) => store.apply(label, patches),
    beginStroke: (label) => store.beginStroke(label),
    endStroke: () => store.endStroke(),
    undo: () => store.undo(),
    redo: () => store.redo(),
    replace: (doc) => store.replace(doc),
  }
}
