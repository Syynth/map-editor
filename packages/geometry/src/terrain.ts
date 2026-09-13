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

import {
  type ReadonlyVoxel,
  CORNER_OFFSETS,
  DIR_VECTORS,
  HALF,
  NO_RAMP,
  NO_WATER,
  SURFACE_CLIFF,
  SURFACE_TOP,
  SURFACE_WATER,
  autotileMask,
  cellIndex,
  chunkBounds,
  cliffPaint,
  cornerHeights,
  encodeExtra,
  inBounds,
  tintPaint,
  topPaint,
  type ReadonlyMapDoc,
} from '@papercut/document'
import {
  cliffTile,
  defaultTopTile,
  rampTile,
  sheetLayoutFor,
  tileUv,
  type CliffBand,
  type SheetLayout,
} from './template'

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
   * Emit a convex polygon as a fan of triangles, corners in winding order as
   * for `quad`. Wall bands are clipped to arbitrary convex shapes — a slope
   * crossing a band leaves a triangle or a pentagon, not a quad.
   */
  polygon(
    corners: ReadonlyArray<readonly [number, number, number]>,
    cornerUvs: ReadonlyArray<readonly [number, number]>,
    shade: readonly number[],
    tint: readonly [number, number, number],
    address: readonly [number, number, number, number],
  ): void {
    if (corners.length < 3) return
    const base = this.vertexCount
    // The normal of the fan's widest turn, so a sliver at the first corner cannot zero it out.
    let nx = 0
    let ny = 0
    let nz = 0
    const [p0] = corners
    for (let i = 1; i + 1 < corners.length; i++) {
      const p1 = corners[i]
      const p2 = corners[i + 1]
      const ax = p1[0] - p0[0]
      const ay = p1[1] - p0[1]
      const az = p1[2] - p0[2]
      const bx = p2[0] - p0[0]
      const by = p2[1] - p0[1]
      const bz = p2[2] - p0[2]
      nx += ay * bz - az * by
      ny += az * bx - ax * bz
      nz += ax * by - ay * bx
    }
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len
    ny /= len
    nz /= len
    for (let i = 0; i < corners.length; i++) {
      this.positions.push(corners[i][0], corners[i][1], corners[i][2])
      this.normals.push(nx, ny, nz)
      this.uvs.push(cornerUvs[i][0], cornerUvs[i][1])
      const s = shade[i]
      this.colors.push(tint[0] * s, tint[1] * s, tint[2] * s)
    }
    for (let i = 1; i + 1 < corners.length; i++) {
      this.indices.push(base, base + i, base + i + 1)
      this.faceAddr.push(...address)
    }
  }

  /**
   * Emit a quad as two triangles. Corners must be given in winding order
   * p0, p1, p2, p3 such that (p1-p0) x (p2-p0) points outwards.
   *
   * UVs are given per corner rather than as a rectangle. Top quads and side
   * faces walk their corners along different axes, so there is no single
   * rectangle-to-corner mapping that serves both.
   */
  quad(
    corners: [number, number, number][],
    cornerUvs: [[number, number], [number, number], [number, number], [number, number]],
    shade: [number, number, number, number],
    tint: [number, number, number],
    address: [number, number, number, number],
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

/**
 * The neighbour's own edge along one of this cell's sides, corner for
 * corner: the heights at this cell's start and end corners of that side as
 * the NEIGHBOUR has them — level for a flat cell, sloped for a ramp. A side
 * face is drawn wherever this cell's edge stands above it, so a flat cell
 * beside a ramp walls off the triangle between the ramp's sloped edge and
 * its own level one, which comparing flat heights never saw (the ramp
 * keeps its height and lowers corners). Outside the volume the edge is at
 * the floor.
 */
function neighbourEdge(voxel: ReadonlyVoxel, x: number, y: number, dir: number): readonly [number, number] {
  const [dx, dy] = DIR_VECTORS[dir]
  const nx = x + dx
  const ny = y + dy
  if (!inBounds(voxel.size, nx, ny)) return [OUTSIDE_HEIGHT, OUTSIDE_HEIGHT]
  const corners = cornerHeights(voxel, nx, ny)
  const [start, end] = NEIGHBOUR_CORNERS[dir]
  return [corners[start], corners[end]]
}

function heightOutside(voxel: ReadonlyVoxel, x: number, y: number): number {
  if (!inBounds(voxel.size, x, y)) return OUTSIDE_HEIGHT
  return voxel.terrain.height[cellIndex(voxel.size, x, y)]
}

/** A point on a wall: `t` along the side from its start corner (0) to its end corner (1), `h` its height in half-tiles. */
type WallPoint = readonly [t: number, h: number]

/**
 * The wall on one side of a cell, exactly: the region between the
 * neighbour's edge below and this cell's edge above, both straight lines
 * along the side, where this cell's stands higher. Where the two lines cross
 * — a slope beside a level, or two slopes — the wall is the triangle on this
 * cell's side of the crossing; the neighbour walls the other side.
 */
function wallRegion(lowStart: number, lowEnd: number, topStart: number, topEnd: number): WallPoint[] {
  const start = topStart - lowStart
  const end = topEnd - lowEnd
  if (start <= 0 && end <= 0) return []
  if (start >= 0 && end >= 0) return [[0, lowStart], [1, lowEnd], [1, topEnd], [0, topStart]]
  const t = start / (start - end)
  const h = lowStart + (lowEnd - lowStart) * t
  return start > 0 ? [[0, lowStart], [t, h], [0, topStart]] : [[t, h], [1, lowEnd], [1, topEnd]]
}

/**
 * A convex wall region cut to the band between `bottom` and `top`
 * (Sutherland–Hodgman, one edge at a time). The previous band clipping
 * clamped each end of a sloped edge into the band and joined the ends with a
 * straight line, which is only right when the slope stays inside the band:
 * a slope crossing a band midway left a triangular hole under it and a fin
 * above it, half a band off — the gaps beside ramps.
 */
function clipToBand(polygon: readonly WallPoint[], bottom: number, top: number): WallPoint[] {
  const below = clipAgainst(polygon, (p) => p[1] - bottom)
  return clipAgainst(below, (p) => top - p[1])
}

/** Keep the part of a convex polygon where `inside` is non-negative. */
function clipAgainst(polygon: readonly WallPoint[], inside: (p: WallPoint) => number): WallPoint[] {
  const out: WallPoint[] = []
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    const da = inside(a)
    const db = inside(b)
    if (da >= 0) out.push(a)
    if ((da >= 0) !== (db >= 0)) {
      const s = da / (da - db)
      out.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s])
    }
  }
  // Points the clip produced twice, or a band the region only touches, would make zero-area triangles.
  const unique = out.filter((p, i) => {
    const q = out[(i + 1) % out.length]
    return Math.abs(p[0] - q[0]) > 1e-9 || Math.abs(p[1] - q[1]) > 1e-9
  })
  return unique.length >= 3 && area(unique) > 1e-9 ? unique : []
}

function area(polygon: readonly WallPoint[]): number {
  let sum = 0
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    sum += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(sum) / 2
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
function cornerShade(voxel: ReadonlyVoxel, x: number, y: number, vx: number, vy: number, h: number): number {
  let occluders = 0
  for (let dy = -1; dy <= 0; dy++) {
    for (let dx = -1; dx <= 0; dx++) {
      const nx = vx + dx
      const ny = vy + dy
      if (nx === x && ny === y) continue
      if (heightOutside(voxel, nx, ny) > h) occluders += 1
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

/**
 * For each side, the neighbour's corner indices that coincide with this
 * cell's start and end corners of that side (`SIDE_CORNERS`): a corner
 * offset `(ox, oy)` here is `(ox - dx, oy - dy)` in the neighbour.
 */
const NEIGHBOUR_CORNERS: ReadonlyArray<readonly [number, number]> = SIDE_CORNERS.map(([start, end], dir) => {
  const [dx, dy] = DIR_VECTORS[dir]
  const across = (corner: number): number => {
    const [ox, oy] = CORNER_OFFSETS[corner]
    return CORNER_OFFSETS.findIndex(([nx, ny]) => nx === ox - dx && ny === oy - dy)
  }
  return [across(start), across(end)] as const
})

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

function resolveTopTile(voxel: ReadonlyVoxel, layout: SheetLayout, x: number, y: number): number {
  // Layer order: painted override wins over the template's automatic default.
  const painted = topPaint(voxel.paint, x, y)
  if (painted !== undefined) return painted

  const index = cellIndex(voxel.size, x, y)
  const material = voxel.terrain.material[index]
  if (voxel.terrain.ramp[index] !== NO_RAMP) return rampTile(layout, material)
  return defaultTopTile(layout, material, autotileMask(voxel, x, y))
}

function resolveCliffTile(
  voxel: ReadonlyVoxel,
  layout: SheetLayout,
  x: number,
  y: number,
  dir: number,
  level: number,
  band: CliffBand,
): number {
  const painted = cliffPaint(voxel.paint, x, y, dir, level)
  if (painted !== undefined) return painted
  const material = voxel.terrain.material[cellIndex(voxel.size, x, y)]
  return cliffTile(layout, material, band)
}

export function meshTerrainChunk(doc: ReadonlyMapDoc, voxel: ReadonlyVoxel, key: string): TerrainChunkMesh {
  const bounds = chunkBounds(key, voxel.size.width, voxel.size.height)
  const solid = new BufferBuilder()
  const water = new BufferBuilder()
  const layout = sheetLayoutFor(doc)

  if (!bounds) {
    return { key, solid: solid.finish(), water: null }
  }

  for (let y = bounds.y0; y < bounds.y1; y++) {
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const index = cellIndex(voxel.size, x, y)
      const tint = unpackTint(tintPaint(voxel.paint, x, y))

      // --- corner heights, in half-tile units -------------------------------
      const cornerH = cornerHeights(voxel, x, y)

      // --- top quad ---------------------------------------------------------
      {
        const corners = CORNER_OFFSETS.map((offset, i) => {
          const vx = x + offset[0]
          const vy = y + offset[1]
          return [vx, cornerH[i] * HALF, vy] as [number, number, number]
        })
        const shade = CORNER_OFFSETS.map((offset, i) =>
          cornerShade(voxel, x, y, x + offset[0], y + offset[1], cornerH[i]),
        ) as [number, number, number, number]

        const [u0, v0, u1, v1] = tileUv(layout, resolveTopTile(voxel, layout, x, y))
        // Corner order is c00, c01, c11, c10. Sheets are authored top-down, so
        // increasing map +Z walks down the sheet, which is decreasing v.
        solid.quad(
          corners,
          [
            [u0, v1],
            [u0, v0],
            [u1, v0],
            [u1, v1],
          ],
          shade,
          tint,
          [SURFACE_TOP, x, y, 0],
        )
      }

      // --- side faces -------------------------------------------------------
      // A side is walled wherever this cell's edge stands above the
      // neighbour's edge along it, both taken corner for corner, so a ramp's
      // sloped edge and a flat neighbour's level one leave no triangle open
      // between them. A ramp's descending edge meets a neighbour at the same
      // height and draws nothing; over a drop it walls the drop.
      for (let dir = 0; dir < 4; dir++) {
        const [startCorner, endCorner] = SIDE_CORNERS[dir]
        const topStart = cornerH[startCorner]
        const topEnd = cornerH[endCorner]
        const [lowStart, lowEnd] = neighbourEdge(voxel, x, y, dir)
        const region = wallRegion(lowStart, lowEnd, topStart, topEnd)
        if (region.length === 0) continue

        const { origin, u } = SIDE_GEOMETRY[dir]
        const ox = x + origin[0]
        const oz = y + origin[1]

        const topLevel = Math.ceil(Math.max(topStart, topEnd)) - 1
        const bottomLevel = Math.floor(Math.min(lowStart, lowEnd))
        for (let level = bottomLevel; level <= topLevel; level++) {
          // The wall region cut to this half-tile band, exactly: a slope crossing the band is followed, not approximated.
          const piece = clipToBand(region, level, level + 1)
          if (piece.length === 0) continue

          const band: CliffBand = level === topLevel ? 'top' : level === bottomLevel ? 'bottom' : 'middle'
          const [u0, v0, u1, v1] = tileUv(layout, resolveCliffTile(voxel, layout, x, y, dir, level, band))

          // Bands sitting in a pit read darker at the bottom.
          const deep = 1 - AO_STRENGTH * Math.min(2, topLevel - level) * 0.5

          solid.polygon(
            piece.map(([t, h]) => [ox + u[0] * t, h * HALF, oz + u[1] * t] as const),
            // The texture keeps its scale however the band is cut: u along the side, v up the band.
            piece.map(([t, h]) => [u0 + (u1 - u0) * t, v0 + (h - level) * (v1 - v0)] as const),
            piece.map(([, h]) => deep + (1 - deep) * (h - level)),
            tint,
            [SURFACE_CLIFF, x, y, encodeExtra(dir, level)],
          )
        }
      }

      // --- water ------------------------------------------------------------
      const waterLevel = voxel.terrain.water[index]
      if (waterLevel !== NO_WATER) {
        const wy = waterLevel * HALF
        water.quad(
          [
            [x, wy, y],
            [x, wy, y + 1],
            [x + 1, wy, y + 1],
            [x + 1, wy, y],
          ],
          [
            [0, 1],
            [0, 0],
            [1, 0],
            [1, 1],
          ],
          [1, 1, 1, 1],
          [1, 1, 1],
          [SURFACE_WATER, x, y, 0],
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
