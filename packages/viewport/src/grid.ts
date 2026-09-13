/**
 * The terrain grid: a line around every cell of every voxel volume, hugging
 * the cell's top (sloped where the cell is a ramp) rather than lying on the
 * ground plane, where a raised cell would bury it.
 *
 * Built the way the terrain is meshed, and for the same reasons. Each volume
 * is a group placed by its frame, so moving a volume moves its grid without
 * touching a vertex. Each chunk of a volume is its own line buffer in the
 * volume's local space, so a stroke that dirties one chunk rewrites that
 * chunk's buffer and no other. And a rewrite reuses the buffer it has: a
 * chunk's cell count never changes while its volume keeps its size, so the
 * positions are written straight into the existing array, with no
 * allocation, and only that range goes back to the GPU.
 *
 * It replaced a rebuild that walked every cell of every volume on any change
 * at all, pushed eight freshly spread arrays per cell, uploaded a new
 * geometry and made a new material each time — the top allocation site in
 * sculpting, undo and redo, and the whole of a 128 × 128 map's frame budget
 * (`pnpm perf`, #131).
 */

import * as THREE from 'three'

import {
  NO_RAMP,
  RAMP_DROP,
  RAMP_LOW_CORNERS,
  allChunkKeys,
  cellIndex,
  chunkBounds,
  chunkKey,
  frameOf,
  parseStructureChunkKey,
  type ReadonlyMapDoc,
  type ReadonlyVoxel,
} from '@papercut/document'

/** Just above the top, so the line wins the depth test against the surface it lies on. */
const LIFT = 0.025
/** Four edges per cell, two vertices per edge, three numbers per vertex. */
const PER_CELL = 24

interface Volume {
  readonly group: THREE.Group
  readonly chunks: Map<string, THREE.LineSegments>
  width: number
  height: number
}

export class TerrainGrid {
  readonly group = new THREE.Group()
  private readonly material = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 })
  private readonly volumes = new Map<string, Volume>()
  /** One cell's corner heights, reused for every cell so writing a chunk allocates nothing. */
  private readonly corners = new Float64Array(4)

  /** Every volume and chunk, from scratch: after a document swap, when nothing about the old grid can be trusted. */
  rebuildAll(doc: ReadonlyMapDoc): void {
    for (const id of [...this.volumes.keys()]) this.drop(id)
    this.update(doc, [], doc.structureOrder)
  }

  /**
   * Bring the grid up to date with what changed: the chunks a stroke dirtied (`<structure>/<cx>,<cy>` keys), and the
   * structures that changed as a whole — resized, moved, added, removed. Every volume is re-placed afterwards, since a
   * structure moving moves whatever stands on it; placing a group is a handful of numbers.
   */
  update(doc: ReadonlyMapDoc, chunks: readonly string[], structures: readonly string[]): void {
    for (const id of structures) {
      const structure = doc.structures[id]
      if (!structure || structure.kind !== 'voxel') {
        this.drop(id)
        continue
      }
      const volume = this.ensure(id, structure)
      for (const key of allChunkKeys(structure.size.width, structure.size.height)) this.writeChunk(volume, structure, key)
    }
    const whole = new Set(structures)
    for (const key of chunks) {
      const { structure: id, cx, cy } = parseStructureChunkKey(key)
      if (whole.has(id)) continue
      const structure = doc.structures[id]
      if (!structure || structure.kind !== 'voxel') continue
      this.writeChunk(this.ensure(id, structure), structure, chunkKey(cx, cy))
    }
    for (const [id, volume] of this.volumes) {
      if (!doc.structures[id]) {
        this.drop(id)
        continue
      }
      const frame = frameOf(doc, id)
      volume.group.position.set(frame.x, frame.y, frame.z)
      // The scene's convention for a structure's group, so the lines sit on the terrain they outline.
      volume.group.rotation.y = (-frame.yaw * Math.PI) / 2
    }
  }

  /** How many line buffers the grid holds, per volume: for a test to see what a change touched. */
  chunkCount(id: string): number {
    return this.volumes.get(id)?.chunks.size ?? 0
  }

  /** The line buffer for one chunk of one volume, if it has one. */
  chunkLines(id: string, key: string): THREE.LineSegments | undefined {
    return this.volumes.get(id)?.chunks.get(key)
  }

  dispose(): void {
    for (const id of [...this.volumes.keys()]) this.drop(id)
    this.material.dispose()
  }

  private ensure(id: string, voxel: ReadonlyVoxel): Volume {
    let volume = this.volumes.get(id)
    // A resized volume's chunks have different cell counts, and some may not exist any more: start it over.
    if (volume && (volume.width !== voxel.size.width || volume.height !== voxel.size.height)) {
      this.drop(id)
      volume = undefined
    }
    if (!volume) {
      volume = { group: new THREE.Group(), chunks: new Map(), width: voxel.size.width, height: voxel.size.height }
      this.group.add(volume.group)
      this.volumes.set(id, volume)
    }
    return volume
  }

  private drop(id: string): void {
    const volume = this.volumes.get(id)
    if (!volume) return
    for (const lines of volume.chunks.values()) lines.geometry.dispose()
    this.group.remove(volume.group)
    this.volumes.delete(id)
  }

  private writeChunk(volume: Volume, voxel: ReadonlyVoxel, key: string): void {
    const bounds = chunkBounds(key, voxel.size.width, voxel.size.height)
    if (!bounds) return
    const cells = (bounds.x1 - bounds.x0) * (bounds.y1 - bounds.y0)
    let lines = volume.chunks.get(key)
    let attribute = lines?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!lines || !attribute || attribute.count * 3 !== cells * PER_CELL) {
      lines?.geometry.dispose()
      if (lines) volume.group.remove(lines)
      const geometry = new THREE.BufferGeometry()
      attribute = new THREE.BufferAttribute(new Float32Array(cells * PER_CELL), 3)
      attribute.setUsage(THREE.DynamicDrawUsage)
      geometry.setAttribute('position', attribute)
      lines = new THREE.LineSegments(geometry, this.material)
      volume.group.add(lines)
      volume.chunks.set(key, lines)
    }
    const out = attribute.array as Float32Array
    const corners = this.corners
    let i = 0
    for (let y = bounds.y0; y < bounds.y1; y++) {
      for (let x = bounds.x0; x < bounds.x1; x++) {
        cornersOf(voxel, x, y, corners)
        const c00 = corners[0]
        const c01 = corners[1]
        const c11 = corners[2]
        const c10 = corners[3]
        // (x, y) → (x, y+1) → (x+1, y+1) → (x+1, y) → back: the four edges as segments.
        i = vertex(out, i, x, c00, y)
        i = vertex(out, i, x, c01, y + 1)
        i = vertex(out, i, x, c01, y + 1)
        i = vertex(out, i, x + 1, c11, y + 1)
        i = vertex(out, i, x + 1, c11, y + 1)
        i = vertex(out, i, x + 1, c10, y)
        i = vertex(out, i, x + 1, c10, y)
        i = vertex(out, i, x, c00, y)
      }
    }
    attribute.needsUpdate = true
    // Culling reads the bounds, and a sculpted chunk's bounds moved: recomputed in place, no allocation.
    lines.geometry.computeBoundingSphere()
  }
}

/** A cell's four corner heights in world units, in `CORNER_OFFSETS` order, written into `out`: `cornerHeights` without the array. */
function cornersOf(voxel: ReadonlyVoxel, x: number, y: number, out: Float64Array): void {
  const index = cellIndex(voxel.size, x, y)
  const h = voxel.terrain.height[index]
  out[0] = h
  out[1] = h
  out[2] = h
  out[3] = h
  const ramp = voxel.terrain.ramp[index]
  if (ramp !== NO_RAMP) {
    const [a, b] = RAMP_LOW_CORNERS[ramp]
    out[a] = h - RAMP_DROP
    out[b] = h - RAMP_DROP
  }
  for (let corner = 0; corner < 4; corner++) out[corner] = out[corner] * 0.5 + LIFT
}

function vertex(out: Float32Array, i: number, x: number, h: number, z: number): number {
  out[i] = x
  out[i + 1] = h
  out[i + 2] = z
  return i + 3
}

