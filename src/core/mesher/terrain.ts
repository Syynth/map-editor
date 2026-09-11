/**
 * The terrain mesher.
 *
 * A pure function from document data to vertex buffers. No three.js, no DOM,
 * no globals. That is what keeps it unit-testable in node, benchmarkable on
 * its own, and movable into a Web Worker as a wiring change rather than a
 * rewrite — which is why the brief's "meshing in a worker" question does not
 * have to be answered before anything else can be built.
 *
 * Geometry emitted per cell:
 *
 *   - one top quad, flat or sloped if the cell is a ramp
 *   - for each of four sides, one quad per half-tile level between the
 *     neighbour's height and this cell's, clipped to the sloped top when the
 *     cell is a ramp
 *   - one water quad if the column holds water
 *
 * Every emitted triangle carries the stable surface address it came from, so
 * picking can turn a hit back into a document coordinate.
 *
 * Ambient occlusion is baked into vertex colours, multiplied by the cell's
 * tint. The brief wants AO doing the soft HD-2D shading cheaply, and wants
 * tint quantised to the cell rather than smoothly splatted, because smooth
 * blending looks mushy next to pixel art.
 */

import { autotileMask } from '../autotile'
import { chunkBounds } from '../chunks'
import {
  DIR_VECTORS,
  HALF,
  NO_RAMP,
  NO_WATER,
  cellIndex,
  inBounds,
  type MapDoc,
} from '../document'
import { CORNER_OFFSETS, cornerHeights } from '../terrain'
import { cliffPaint, tintPaint, topPaint } from '../paint'
import {
  SURFACE_CLIFF,
  SURFACE_TOP,
  SURFACE_WATER,
  encodeExtra,
} from '../surface'
import {
  cliffTile,
  defaultTopTile,
  rampTile,
  sheetLayoutFor,
  tileUv,
  type CliffBand,
  type SheetLayout,
} from '../template'

export interface MeshBuffers {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  colors: Float32Array
  indices: Uint32Array
  /** Four ints per triangle: kind, x, y, extra. See surface.ts. */
  faceAddr: Int32Array
  triangleCount: number
}

export interface TerrainChunkMesh {
  key: string
  solid: MeshBuffers
  water: MeshBuffers | null
}

/** Height treated as existing outside the map, so borders read as an island. */
const OUTSIDE_HEIGHT = 0

/** How much each occluding neighbour darkens a corner. */
const AO_STRENGTH = 0.17

class BufferBuilder {
  positions: number[] = []
  normals: number[] = []
  uvs: number[] = []
  colors: number[] = []
  indices: number[] = []
  faceAddr: number[] = []

  get vertexCount(): number {
    return this.positions.length / 3
  }

  /**
   * Emit a quad as two triangles. Corners must be given in winding order
   * p0, p1, p2, p3 such that (p1-p0) x (p2-p0) points outwards.
   */
  quad(
    corners: [number, number, number][],
    uv: [number, number, number, number],
    shade: [number, number, number, number],
    tint: [number, number, number],
    address: [number, number, number, number],
    /** Override the v coordinate per corner, for bands clipped by a ramp. */
    vOverride?: [number, number, number, number],
  ): void {
    const base = this.vertexCount
    const [p0, p1, p2] = corners

    const ax = p1[0] - p0[0]
    const ay = p1[1] - p0[1]
    const az = p1[2] - p0[2]
    const bx = p2[0] - p0[0]
    const by = p2[1] - p0[1]
    const bz = p2[2] - p0[2]
    let nx = ay * bz - az * by
    let ny = az * bx - ax * bz
    let nz = ax * by - ay * bx
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len
    ny /= len
    nz /= len

    const [u0, v0, u1, v1] = uv
    const vs = vOverride ?? [v0, v0, v1, v1]
    const cornerUvs: [number, number][] = [
      [u0, vs[0]],
      [u1, vs[1]],
      [u1, vs[2]],
      [u0, vs[3]],
    ]

    for (let i = 0; i < 4; i++) {
      this.positions.push(corners[i][0], corners[i][1], corners[i][2])
      this.normals.push(nx, ny, nz)
      this.uvs.push(cornerUvs[i][0], cornerUvs[i][1])
      const s = shade[i]
      this.colors.push(tint[0] * s, tint[1] * s, tint[2] * s)
    }

    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    for (let t = 0; t < 2; t++) this.faceAddr.push(...address)
  }

  finish(): MeshBuffers {
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      colors: new Float32Array(this.colors),
      indices: new Uint32Array(this.indices),
      faceAddr: new Int32Array(this.faceAddr),
      triangleCount: this.indices.length / 3,
    }
  }

  get isEmpty(): boolean {
    return this.indices.length === 0
  }
}

function heightOutside(doc: MapDoc, x: number, y: number): number {
  if (!inBounds(doc.size, x, y)) return OUTSIDE_HEIGHT
  return doc.terrain.height[cellIndex(doc.size, x, y)]
}

function unpackTint(packed: number | undefined): [number, number, number] {
  if (packed === undefined) return [1, 1, 1]
  return [
    ((packed >> 16) & 0xff) / 255,
    ((packed >> 8) & 0xff) / 255,
    (packed & 0xff) / 255,
  ]
}

/**
 * Corner occlusion for a top-surface vertex. Looks at the three cells that
 * share the grid vertex with this cell and counts the ones standing above it.
 */
function cornerShade(doc: MapDoc, x: number, y: number, vx: number, vy: number, h: number): number {
  let occluders = 0
  for (let dy = -1; dy <= 0; dy++) {
    for (let dx = -1; dx <= 0; dx++) {
      const nx = vx + dx
      const ny = vy + dy
      if (nx === x && ny === y) continue
      if (heightOutside(doc, nx, ny) > h) occluders += 1
    }
  }
  return 1 - AO_STRENGTH * occluders
}

/** [startCorner, endCorner] walked by each side, matching its u axis. */
const SIDE_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [2, 3],
  [1, 2],
  [0, 1],
  [3, 0],
]

/** Face origin and u axis per side, chosen so u x +Y is the outward normal. */
const SIDE_GEOMETRY: ReadonlyArray<{
  origin: readonly [number, number]
  u: readonly [number, number]
}> = [
  { origin: [1, 1], u: [0, -1] },
  { origin: [0, 1], u: [1, 0] },
  { origin: [0, 0], u: [0, 1] },
  { origin: [1, 0], u: [-1, 0] },
]

function resolveTopTile(doc: MapDoc, layout: SheetLayout, x: number, y: number): number {
  // Layer order: painted override wins over the template's automatic default.
  const painted = topPaint(doc.paint, x, y)
  if (painted !== undefined) return painted

  const index = cellIndex(doc.size, x, y)
  const material = doc.terrain.material[index]
  if (doc.terrain.ramp[index] !== NO_RAMP) return rampTile(layout, material)
  return defaultTopTile(layout, material, autotileMask(doc, x, y))
}

function resolveCliffTile(
  doc: MapDoc,
  layout: SheetLayout,
  x: number,
  y: number,
  dir: number,
  level: number,
  band: CliffBand,
): number {
  const painted = cliffPaint(doc.paint, x, y, dir, level)
  if (painted !== undefined) return painted
  const material = doc.terrain.material[cellIndex(doc.size, x, y)]
  return cliffTile(layout, material, band)
}

export function meshTerrainChunk(doc: MapDoc, key: string): TerrainChunkMesh {
  const bounds = chunkBounds(key, doc.size.width, doc.size.height)
  const solid = new BufferBuilder()
  const water = new BufferBuilder()
  const layout = sheetLayoutFor(doc)

  if (!bounds) {
    return { key, solid: solid.finish(), water: null }
  }

  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const index = cellIndex(doc.size, x, y)
      const ramp = doc.terrain.ramp[index]
      const tint = unpackTint(tintPaint(doc.paint, x, y))

      // --- corner heights, in half-tile units -------------------------------
      const cornerH = cornerHeights(doc, x, y)

      // --- top quad ---------------------------------------------------------
      {
        const corners = CORNER_OFFSETS.map((offset, i) => {
          const vx = x + offset[0]
          const vy = y + offset[1]
          return [vx, cornerH[i] * HALF, vy] as [number, number, number]
        })
        const shade = CORNER_OFFSETS.map((offset, i) =>
          cornerShade(doc, x, y, x + offset[0], y + offset[1], cornerH[i]),
        ) as [number, number, number, number]

        const uv = tileUv(layout, resolveTopTile(doc, layout, x, y))
        // Sheets are authored top-down: +Z on the map is downward on the sheet.
        const [u0, v0, u1, v1] = uv
        solid.quad(
          corners,
          [u0, v1, u1, v0],
          shade,
          tint,
          [SURFACE_TOP, x, y, 0],
          [v1, v0, v0, v1],
        )
      }

      // --- side faces -------------------------------------------------------
      for (let dir = 0; dir < 4; dir++) {
        // The descending face of a ramp meets the ground; nothing to draw.
        if (ramp === dir) continue

        const [dx, dy] = DIR_VECTORS[dir]
        const neighbour = heightOutside(doc, x + dx, y + dy)

        const [startCorner, endCorner] = SIDE_CORNERS[dir]
        const topStart = cornerH[startCorner]
        const topEnd = cornerH[endCorner]
        const maxTop = Math.max(topStart, topEnd)
        if (neighbour >= maxTop) continue

        const { origin, u } = SIDE_GEOMETRY[dir]
        const ox = x + origin[0]
        const oz = y + origin[1]
        const ex = ox + u[0]
        const ez = oz + u[1]

        const topLevel = Math.ceil(maxTop) - 1
        for (let level = neighbour; level <= topLevel; level++) {
          const bottom = level
          const top = level + 1
          // Clip the band to the (possibly sloped) top edge of this side.
          const clipStart = Math.min(top, topStart)
          const clipEnd = Math.min(top, topEnd)
          if (clipStart <= bottom && clipEnd <= bottom) continue

          const hStart = Math.max(clipStart, bottom)
          const hEnd = Math.max(clipEnd, bottom)

          const band: CliffBand =
            level === topLevel ? 'top' : level === neighbour ? 'bottom' : 'middle'
          const uv = tileUv(layout, resolveCliffTile(doc, layout, x, y, dir, level, band))
          const [u0, v0, u1, v1] = uv

          // Keep the texture from stretching when a band is clipped short.
          const vStart = v0 + (hStart - bottom) * (v1 - v0)
          const vEnd = v0 + (hEnd - bottom) * (v1 - v0)

          // Bands sitting in a pit read darker at the bottom.
          const deep = 1 - AO_STRENGTH * Math.min(2, topLevel - level) * 0.5
          const shade: [number, number, number, number] = [deep, deep, 1, 1]

          solid.quad(
            [
              [ox, bottom * HALF, oz],
              [ex, bottom * HALF, ez],
              [ex, hEnd * HALF, ez],
              [ox, hStart * HALF, oz],
            ],
            [u0, v0, u1, v1],
            shade,
            tint,
            [SURFACE_CLIFF, x, y, encodeExtra(dir, level)],
            [v0, v0, vEnd, vStart],
          )
        }
      }

      // --- water ------------------------------------------------------------
      const waterLevel = doc.terrain.water[index]
      if (waterLevel !== NO_WATER) {
        const wy = waterLevel * HALF
        water.quad(
          [
            [x, wy, y],
            [x, wy, y + 1],
            [x + 1, wy, y + 1],
            [x + 1, wy, y],
          ],
          [0, 0, 1, 1],
          [1, 1, 1, 1],
          [1, 1, 1],
          [SURFACE_WATER, x, y, 0],
          [1, 0, 0, 1],
        )
      }
    }
  }

  return {
    key,
    solid: solid.finish(),
    water: water.isEmpty ? null : water.finish(),
  }
}
