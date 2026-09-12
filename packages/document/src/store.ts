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
 * A stroke is bracketed by `beginStroke`/`endStroke`, and its ticks arrive by
 * their own verb: `applyStrokeTick` APPLIES but does not RECORD, so terrain
 * deforms mid-drag while the undo entry is the compacted record the stroke
 * actor hands to `endStroke` (#11 — the actor owns the compaction map, one
 * `{ first, last }` per address, bounded by cells touched rather than by
 * ticks). The store used to accumulate every tick's patches and `unshift`
 * every inverse here, which is where the measured 3,780 patches over 260
 * addresses (14.5x) came from; that path is gone, not compacted in place,
 * because keeping both would leave two owners of the same record.
 *
 * `apply` therefore means the SAME THING whether or not a stroke is open: it
 * always pushes an entry. Making "inside a stroke" a property of `apply`
 * instead of a separate verb is what turned a mid-drag `Delete object` — the
 * window keydown listener fires during a pointer drag — into a write recorded
 * in neither the history nor the stroke's compaction map: applied, and
 * unwindable by nothing. A stroke tick never reaches `apply` now, so the
 * always-record rule has no exception to lose.
 *
 * The other half of the contract lives on `undo`/`redo`: both are REFUSED
 * while a stroke is open, and `canUndo`/`canRedo` report false, because the
 * entry the drag will produce does not exist yet.
 *
 * What always-record does NOT license is a concurrent `apply` at an address
 * the open stroke has already written. Two entries over one address unwind
 * in an order that never happened — the mid-drag `Delete object` and the
 * drag of that same object would leave `doc.objects` holding an object
 * `doc.objectOrder` has forgotten. So the stroke keeps the addresses it has
 * touched until it closes and a colliding `apply` is refused whole; `apply`
 * carries the reasoning, including why the other direction needs nothing.
 *
 * The verbs are still public methods on the class for one reason: `App.tsx`
 * calls `store.apply` directly today, and #66 keeps it doing so until step 7
 * rewires the app onto the host actor. That is a temporary second write path,
 * not a design — the class leaves the barrel with it.
 */

import {
  applyPatches,
  patchAddress,
  pruneNoops,
  History,
  type Patch,
  type StrokeRecord,
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
  /**
   * `this: void` on both: they are handed to `useSyncExternalStore` detached
   * from the reader (`useDocument` in `editor-host` does exactly that), so
   * the type says they may be, and the store binds them as arrows to keep it
   * true.
   */
  subscribe(this: void, listener: Listener): () => void
  /** `useSyncExternalStore`'s second argument: the revision, as a value. */
  getSnapshot(this: void): number
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
  /** One tick of an open stroke: applied and dirtied, recorded by nothing. */
  applyStrokeTick(patches: Patch[]): void
  beginStroke(label: string): void
  /** Close the stroke with its compacted record; `null` when it touched nothing. */
  endStroke(record: StrokeRecord | null): void
  undo(): void
  redo(): void
  replace(doc: MapDoc): void
}

/**
 * The open stroke's bookkeeping: its label, and every address its ticks have
 * written so far. The set is what `apply` arbitrates against, and it does not
 * outlive the stroke — `beginStroke` makes it and `endStroke` drops it.
 */
interface OpenStroke {
  readonly label: string
  readonly addresses: Set<string>
}

export class EditorStore implements DocumentWriter {
  private doc: MapDoc
  revision = 0
  private history = new History()

  private listeners = new Set<Listener>()
  private dirtyChunks = new Set<string>()
  private stroke: OpenStroke | null = null

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
      // False while a stroke is open: the entry it will produce does not exist
      // yet, so an undo now would skip past the drag in progress and leave its
      // applied patches with no record to unwind them.
      canUndo: () => this.stroke === null && this.history.canUndo(),
      canRedo: () => this.stroke === null && this.history.canRedo(),
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
   * Apply an edit as its own undo entry — ALWAYS, stroke open or not. An app
   * write that lands mid-drag (the Delete keybinding fires during a pointer
   * drag: `keydown` is on `window`, and pointer capture does not stop it) is
   * an ordinary edit that happens to be concurrent with a stroke, and it gets
   * an ordinary entry. A stroke's own ticks come through `applyStrokeTick`.
   *
   * The one thing a concurrent `apply` may NOT do is address what the open
   * stroke addresses, and that is refused here rather than trusted to the
   * caller. Two entries over one address are two INDEPENDENT records whose
   * order on the stack does not match the order the writes happened in, and
   * unwinding them puts the document in a state neither entry describes:
   * delete the object being dragged and `apply` records "object A gone,
   * objectOrder without A" while `endStroke` records "object A at the drag's
   * end"; the first undo pops the stroke, writes `doc.objects[A]` and leaves
   * `objectOrder` — owned only by the other entry — without it. An orphan.
   *
   * Folding the concurrent write into the open stroke is what the store used
   * to do, and it was order-correct, but compaction moved the stroke's record
   * out to the actor (#11) and there is nothing here to fold into any more.
   * So the collision is refused instead: the stroke claimed the address
   * first and keeps it until it closes. `inStroke` lets a caller see that
   * coming and skip its own bookkeeping — `App.tsx` leaves the selection
   * alone rather than clearing it for a delete this would refuse.
   *
   * Only that direction. An `apply` at an address the stroke has NOT touched
   * yet is fine even if the drag later crosses it, because the stroke records
   * its before-value lazily, at the tick that first writes the address: the
   * value it would restore is the one this `apply` left, and the two entries
   * unwind newest-first in exactly the order they were written. It is the
   * address the stroke got to FIRST that makes the stack disagree with time,
   * because the stroke's before-value for it predates an entry sitting under
   * the stroke's own on the stack.
   */
  apply(label: string, patches: Patch[]): void {
    const pruned = pruneNoops(this.doc, patches)
    if (pruned.length === 0) return
    // All or nothing: applying the half that does not collide would split an
    // edit that is only correct whole (`removeObject` is the object AND the
    // order) and record a document state no undo restores.
    const stroke = this.stroke
    if (stroke && pruned.some((patch) => stroke.addresses.has(patchAddress(patch)))) return

    const inverse = applyPatches(this.doc, pruned)
    for (const patch of pruned) this.dirtyFromPatch(patch)

    this.history.push({ label, patches: pruned, inverse })
    this.emit()
  }

  /**
   * One tick of the open stroke: apply and dirty, record nothing — the
   * stroke's single entry arrives with `endStroke`, compacted by the actor.
   *
   * Refused when no stroke is open. The only way to get here without one is a
   * `replace` mid-drag, and those patches address the document that was
   * replaced — indices into terrain arrays that may not even be in bounds any
   * more — which is the same reason `endStroke` drops a late record.
   */
  applyStrokeTick(patches: Patch[]): void {
    const stroke = this.stroke
    if (!stroke) return
    const pruned = pruneNoops(this.doc, patches)
    if (pruned.length === 0) return

    applyPatches(this.doc, pruned)
    for (const patch of pruned) {
      this.dirtyFromPatch(patch)
      stroke.addresses.add(patchAddress(patch))
    }
    this.emit()
  }

  /**
   * Open a stroke: `applyStrokeTick` lands without a history entry until
   * `endStroke`. Emits because `canUndo` just changed, and the toolbar reads it.
   */
  beginStroke(label: string): void {
    this.stroke = { label, addresses: new Set() }
    this.emit()
  }

  /**
   * Close the stroke, pushing the record the stroke actor compacted under the
   * label `beginStroke` gave. A record arriving with no stroke open — after a
   * `replace` mid-drag — is dropped: it describes a document that is gone.
   */
  endStroke(record: StrokeRecord | null): void {
    const stroke = this.stroke
    this.stroke = null
    if (!stroke) return
    if (record && record.patches.length > 0) this.history.push({ label: stroke.label, ...record })
    this.emit()
  }

  /** Whether a stroke is open, so a caller can skip a write `apply` would refuse rather than half-do it. */
  get inStroke(): boolean {
    return this.stroke !== null
  }

  /** Refused mid-stroke, for the reason `canUndo` gives; the old close-and-undo left the rest of the drag unrecorded. */
  undo(): void {
    if (this.stroke) return
    const command = this.history.undo(this.doc)
    if (!command) return
    for (const patch of command.inverse) this.dirtyFromPatch(patch)
    this.emit()
  }

  redo(): void {
    if (this.stroke) return
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
 * `EditorStore` rather than a fresh document — `main.tsx` still constructs the
 * store and hands it to both `createHost` and `App` until #66 step 7, and the
 * actor has to write the same instance the app reads.
 */
export function writerOf(store: EditorStore): DocumentWriter {
  return {
    apply: (label, patches) => store.apply(label, patches),
    applyStrokeTick: (patches) => store.applyStrokeTick(patches),
    beginStroke: (label) => store.beginStroke(label),
    endStroke: (record) => store.endStroke(record),
    undo: () => store.undo(),
    redo: () => store.redo(),
    replace: (doc) => store.replace(doc),
  }
}
