/**
 * Sketch meshing.
 *
 * A sketch is a closed profile on a horizontal plane, extruded to one height
 * (ruling of 2026-09-12, "Sketch workflow"). This turns it into the parts its
 * two materials dress: the cap (a fill, with a rim band along the outline)
 * and the wall (a body, with a top band where it meets the cap and a bottom
 * band where it meets the ground). Each part is its own buffer so each can
 * carry its own texture.
 *
 * Profile points are corner or smooth; smooth points are rounded by
 * corner-cutting (Chaikin's scheme, with corners held fixed) rather than by
 * handles the artist would have to drag. Bands are quads along the outline
 * with arc-length UVs, so an edge texture tiles along the wall the way a
 * Ferr2D edge does, and the outline's orientation is normalised so walls
 * always face outward whichever way the points were clicked.
 */

import { outlineOf, type LipStyle, type Outline, type Profile, type ProfilePoint, type WallProfile, type WallProfilePoint } from '@map-editor/document'

import type { MeshBuffers } from './terrain'

export { outlineOf }
export type { LipStyle, Outline, Profile, ProfilePoint, WallProfile, WallProfilePoint }

/** How an edge texture repeats along the outline: on a fixed length, or stretched so a whole number of copies meet at the seam. */
export type EdgeRepeat = 'tile' | 'stretch'

export interface EdgeSpec {
  /** Across the band, in world units. */
  readonly width: number
  /** Along the outline: world units per texture repeat. */
  readonly segment: number
  readonly repeat: EdgeRepeat
}

export interface CapMaterialSpec {
  /** Texture repeats per world unit across the fill. */
  readonly fillScale: number
  readonly rim: EdgeSpec
}

export interface WallMaterialSpec {
  readonly bodyScale: number
  readonly top: EdgeSpec
  readonly bottom: EdgeSpec
}

/** A starting profile: a straight taper, or a concave curve that keeps most of the flare near the ground, the way a cut-earth cliff reads. */
export function wallProfilePreset(shape: 'straight' | 'curve' | 'plumb', flare: number): WallProfile {
  switch (shape) {
    case 'plumb':
      return { points: [{ out: 0, t: 0 }, { out: 0, t: 1 }], smooth: false }
    case 'straight':
      return { points: [{ out: flare, t: 0 }, { out: 0, t: 1 }], smooth: false }
    case 'curve':
      return {
        points: [
          { out: flare, t: 0 },
          { out: flare * 0.55, t: 0.2 },
          { out: flare * 0.22, t: 0.45 },
          { out: flare * 0.05, t: 0.75 },
          { out: 0, t: 1 },
        ],
        smooth: true,
      }
  }
}

export interface SketchMeshOptions {
  readonly height: number
  readonly cap: CapMaterialSpec
  readonly wall: WallMaterialSpec
  readonly lip: LipStyle
  readonly profile?: WallProfile
  /** Chaikin rounds per smooth point; 3 is visually round at island scale. */
  readonly rounds?: number
}

export interface SketchMesh {
  readonly outline: Outline
  readonly cap: MeshBuffers
  readonly rim: MeshBuffers
  readonly wallBody: MeshBuffers
  readonly wallTop: MeshBuffers
  readonly wallBottom: MeshBuffers
}

type Vec2 = readonly [number, number]

/** Outward unit normal of the edge leaving point `i`. */
function edgeNormal(points: readonly Vec2[], i: number): Vec2 {
  const [x0, z0] = points[i]
  const [x1, z1] = points[(i + 1) % points.length]
  const dx = x1 - x0
  const dz = z1 - z0
  const len = Math.hypot(dx, dz) || 1
  // For positive signed area in (x, z), (dz, -dx) points away from the interior.
  return [dz / len, -dx / len]
}

/** Outward miter direction at point `i`, scaled so an offset of `d` along it moves both adjacent edges by `d`. */
function miter(points: readonly Vec2[], i: number): Vec2 {
  const n0 = edgeNormal(points, (i - 1 + points.length) % points.length)
  const n1 = edgeNormal(points, i)
  const dot = n0[0] * n1[0] + n0[1] * n1[1]
  // (n0 + n1) / (1 + n0·n1) moves both adjacent edges by exactly the offset.
  // A spike (dot -> -1) would send it to infinity, so its length is capped at
  // twice the offset: the corner gets clipped rather than the band a mile long.
  const mx = n0[0] + n1[0]
  const mz = n0[1] + n1[1]
  const len = Math.hypot(mx, mz)
  if (len < 1e-6) return n1
  const scale = Math.min(2, len / Math.max(1e-6, 1 + dot))
  return [(mx / len) * scale, (mz / len) * scale]
}

function inset(points: readonly Vec2[], d: number): Vec2[] {
  return points.map((p, i) => {
    const m = miter(points, i)
    return [p[0] - m[0] * d, p[1] - m[1] * d] as const
  })
}

// --- triangulation -----------------------------------------------------------

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const s = (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0])
  const t = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
  if (s < 0 !== t < 0 && s !== 0 && t !== 0) return false
  const d = (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0])
  return d === 0 || d < 0 === (s + t <= 0)
}

/** Ear clipping over a simple polygon with positive signed area. Returns index triples. */
export function triangulate(points: readonly Vec2[]): number[] {
  const remaining = points.map((_, i) => i)
  const out: number[] = []
  const convex = (a: Vec2, b: Vec2, c: Vec2): boolean => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0
  let guard = 0
  while (remaining.length > 3 && guard++ < 10_000) {
    let clipped = false
    for (let k = 0; k < remaining.length; k++) {
      const ia = remaining[(k - 1 + remaining.length) % remaining.length]
      const ib = remaining[k]
      const ic = remaining[(k + 1) % remaining.length]
      const a = points[ia]
      const b = points[ib]
      const c = points[ic]
      if (!convex(a, b, c)) continue
      let empty = true
      for (const j of remaining) {
        if (j === ia || j === ib || j === ic) continue
        if (pointInTriangle(points[j], a, b, c)) {
          empty = false
          break
        }
      }
      if (!empty) continue
      out.push(ia, ib, ic)
      remaining.splice(k, 1)
      clipped = true
      break
    }
    // A degenerate polygon (collinear run, self-touch) has no ear; drop a
    // vertex rather than spin, so a bad sketch still produces something.
    if (!clipped) remaining.splice(0, 1)
  }
  if (remaining.length === 3) out.push(remaining[0], remaining[1], remaining[2])
  return out
}

// --- buffers -----------------------------------------------------------------

class PartBuilder {
  private positions: number[] = []
  private normals: number[] = []
  private uvs: number[] = []
  private colors: number[] = []
  private indices: number[] = []
  private faceAddr: number[] = []

  private vertex(p: readonly [number, number, number], n: readonly [number, number, number], uv: Vec2): number {
    this.positions.push(p[0], p[1], p[2])
    this.normals.push(n[0], n[1], n[2])
    this.uvs.push(uv[0], uv[1])
    this.colors.push(1, 1, 1)
    return this.positions.length / 3 - 1
  }

  /** A triangle wound to face `n`, whichever order the corners came in. */
  tri(
    corners: readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]],
    uvs: readonly [Vec2, Vec2, Vec2],
    n: readonly [number, number, number],
    segment: number,
  ): void {
    const [a, b, c] = corners
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    let cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx
    const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0
    if (flip) {
      cx = -cx
      cy = -cy
      cz = -cz
    }
    // The face's own normal, so a flared wall shades as the slope it is; the
    // hint only says which side is out.
    const len = Math.hypot(cx, cy, cz)
    const fn: readonly [number, number, number] = len > 1e-9 ? [cx / len, cy / len, cz / len] : n
    const i0 = this.vertex(a, fn, uvs[0])
    const i1 = this.vertex(b, fn, uvs[1])
    const i2 = this.vertex(c, fn, uvs[2])
    if (flip) this.indices.push(i0, i2, i1)
    else this.indices.push(i0, i1, i2)
    this.faceAddr.push(0, segment, 0, 0)
  }

  quad(
    corners: readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]],
    uvs: readonly [Vec2, Vec2, Vec2, Vec2],
    n: readonly [number, number, number],
    segment: number,
  ): void {
    this.tri([corners[0], corners[1], corners[2]], [uvs[0], uvs[1], uvs[2]], n, segment)
    this.tri([corners[0], corners[2], corners[3]], [uvs[0], uvs[2], uvs[3]], n, segment)
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
}

/** Texture u at arc length `s` for a band: on its own segment length, or stretched so whole copies meet at the seam. */
function bandU(spec: EdgeSpec, s: number, perimeter: number): number {
  if (spec.repeat === 'tile') return s / spec.segment
  const copies = Math.max(1, Math.round(perimeter / spec.segment))
  return (s / perimeter) * copies
}

/** Nudge to keep a band off the face it lies on. */
const LIFT = 0.006

// --- parts -------------------------------------------------------------------

function buildCap(outline: Outline, y: number, capPoints: readonly Vec2[], fillScale: number): MeshBuffers {
  const b = new PartBuilder()
  const tris = triangulate(capPoints)
  for (let t = 0; t < tris.length; t += 3) {
    const corners = [capPoints[tris[t]], capPoints[tris[t + 1]], capPoints[tris[t + 2]]] as const
    b.tri(
      [
        [corners[0][0], y, corners[0][1]],
        [corners[1][0], y, corners[1][1]],
        [corners[2][0], y, corners[2][1]],
      ],
      [
        [corners[0][0] * fillScale, corners[0][1] * fillScale],
        [corners[1][0] * fillScale, corners[1][1] * fillScale],
        [corners[2][0] * fillScale, corners[2][1] * fillScale],
      ],
      [0, 1, 0],
      -1,
    )
  }
  void outline
  return b.finish()
}

/** A band lying flat on the cap between the outline and its inset. */
function buildRimOnCap(outline: Outline, y: number, outer: readonly Vec2[], spec: EdgeSpec, vOuter: number, vInner: number): MeshBuffers {
  const b = new PartBuilder()
  const inner = inset(outer, spec.width)
  const n = outline.points.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const s0 = outline.arc[i]
    const s1 = i + 1 === n ? outline.perimeter : outline.arc[j]
    const u0 = bandU(spec, s0, outline.perimeter)
    const u1 = bandU(spec, s1, outline.perimeter)
    b.quad(
      [
        [outer[i][0], y + LIFT, outer[i][1]],
        [outer[j][0], y + LIFT, outer[j][1]],
        [inner[j][0], y + LIFT, inner[j][1]],
        [inner[i][0], y + LIFT, inner[i][1]],
      ],
      [
        [u0, vOuter],
        [u1, vOuter],
        [u1, vInner],
        [u0, vInner],
      ],
      [0, 1, 0],
      i,
    )
  }
  return b.finish()
}

const PLUMB: WallProfile = wallProfilePreset('plumb', 0)

/** The profile's polyline as drawn, or rounded (Chaikin on the open polyline, endpoints held) when it is smooth. */
export function wallProfilePolyline(profile: WallProfile, rounds = 3): WallProfilePoint[] {
  let pts = [...profile.points].sort((a, b) => a.t - b.t)
  if (!profile.smooth || pts.length < 3) return pts
  for (let r = 0; r < rounds; r++) {
    const next: WallProfilePoint[] = [pts[0]]
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      if (i > 0) next.push({ out: a.out * 0.75 + b.out * 0.25, t: a.t * 0.75 + b.t * 0.25 })
      if (i < pts.length - 2) next.push({ out: a.out * 0.25 + b.out * 0.75, t: a.t * 0.25 + b.t * 0.75 })
    }
    next.push(pts[pts.length - 1])
    pts = next
  }
  return pts
}

/** Outward offset of the wall at height fraction `t`, read off the polyline. */
function flareAt(polyline: readonly WallProfilePoint[], t: number): number {
  if (polyline.length === 0) return 0
  if (t <= polyline[0].t) return polyline[0].out
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i]
    const b = polyline[i + 1]
    if (t <= b.t) {
      const span = b.t - a.t
      return span < 1e-9 ? b.out : a.out + ((t - a.t) / span) * (b.out - a.out)
    }
  }
  return polyline[polyline.length - 1].out
}

/** The outline at height fraction `t`, pushed out by the profile's offset there. */
function ring(outline: Outline, polyline: readonly WallProfilePoint[], t: number): readonly Vec2[] {
  const d = flareAt(polyline, t)
  return d === 0 ? outline.points : inset(outline.points, -d)
}

/** The height fractions a strip between `t0` and `t1` needs rows at: its ends plus every profile point between them. */
function rowsBetween(polyline: readonly WallProfilePoint[], t0: number, t1: number): number[] {
  const rows = [t0]
  for (const p of polyline) if (p.t > t0 + 1e-6 && p.t < t1 - 1e-6) rows.push(p.t)
  rows.push(t1)
  return rows
}

/**
 * A strip of the wall between height fractions `t0` and `t1`, as `steps`
 * rows of quads following the profile; `v` maps a height fraction to the
 * texture's v, so a band and the body can share one profile and differ only
 * in how their texture runs up it.
 */
function buildWallStrip(
  outline: Outline,
  height: number,
  polyline: readonly WallProfilePoint[],
  t0: number,
  t1: number,
  u: (s: number) => number,
  v: (t: number) => number,
  lift = 0,
): MeshBuffers {
  const b = new PartBuilder()
  const pts = outline.points
  const n = pts.length
  const rows = rowsBetween(polyline, t0, t1)
  for (let row = 0; row < rows.length - 1; row++) {
    const ta = rows[row]
    const tb = rows[row + 1]
    const lower = ring(outline, polyline, ta)
    const upper = ring(outline, polyline, tb)
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const [nx, nz] = edgeNormal(pts, i)
      const s0 = outline.arc[i]
      const s1 = i + 1 === n ? outline.perimeter : outline.arc[j]
      const ox = nx * lift
      const oz = nz * lift
      b.quad(
        [
          [lower[i][0] + ox, ta * height, lower[i][1] + oz],
          [lower[j][0] + ox, ta * height, lower[j][1] + oz],
          [upper[j][0] + ox, tb * height, upper[j][1] + oz],
          [upper[i][0] + ox, tb * height, upper[i][1] + oz],
        ],
        [
          [u(s0), v(ta)],
          [u(s1), v(ta)],
          [u(s1), v(tb)],
          [u(s0), v(tb)],
        ],
        [nx, 0, nz],
        i,
      )
    }
  }
  return b.finish()
}

/** A band on the wall between heights `y0` and `y1`, texture v from `v0` at the bottom to `v1` at the top. */
function buildWallBand(outline: Outline, height: number, polyline: readonly WallProfilePoint[], y0: number, y1: number, spec: EdgeSpec, v0: number, v1: number): MeshBuffers {
  const t0 = y0 / height
  const t1 = y1 / height
  return buildWallStrip(
    outline,
    height,
    polyline,
    t0,
    t1,
    (s) => bandU(spec, s, outline.perimeter),
    (t) => v0 + ((t - t0) / (t1 - t0 || 1)) * (v1 - v0),
    LIFT,
  )
}

/** The wall body from the ground to `top`, texture in world units. */
function buildWallBody(outline: Outline, height: number, polyline: readonly WallProfilePoint[], top: number, scale: number): MeshBuffers {
  return buildWallStrip(outline, height, polyline, 0, top / height, (s) => s * scale, (t) => t * height * scale)
}

/** A 45° chamfer from the outline at `y - size` up and in to the inset at `y`, carrying the top band. */
function buildBevel(outline: Outline, y: number, size: number, spec: EdgeSpec): MeshBuffers {
  // The bevel starts at the top outline: a flare below it is the body's.
  const b = new PartBuilder()
  const pts = outline.points
  const inner = inset(pts, size)
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const [nx, nz] = edgeNormal(pts, i)
    const s0 = outline.arc[i]
    const s1 = i + 1 === n ? outline.perimeter : outline.arc[j]
    const u0 = bandU(spec, s0, outline.perimeter)
    const u1 = bandU(spec, s1, outline.perimeter)
    const k = Math.SQRT1_2
    b.quad(
      [
        [pts[i][0], y - size, pts[i][1]],
        [pts[j][0], y - size, pts[j][1]],
        [inner[j][0], y, inner[j][1]],
        [inner[i][0], y, inner[i][1]],
      ],
      [
        [u0, 0],
        [u1, 0],
        [u1, 1],
        [u0, 1],
      ],
      [nx * k, k, nz * k],
      i,
    )
  }
  return b.finish()
}

/** The rim folded over the lip: the inner part lies on the cap, the outer hangs down the wall. */
function buildSkirt(outline: Outline, y: number, profile: readonly WallProfilePoint[], spec: EdgeSpec): { cap: MeshBuffers; wall: MeshBuffers } {
  const half = spec.width / 2
  // v runs 1 at the inner edge on the cap to 0 at the bottom of the hanging part.
  const cap = buildRimOnCap(outline, y, outline.points, { ...spec, width: half }, 0.5, 1)
  const wall = buildWallBand(outline, y, profile, y - half, y, spec, 0, 0.5)
  return { cap, wall }
}

const EMPTY: MeshBuffers = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  uvs: new Float32Array(0),
  colors: new Float32Array(0),
  indices: new Uint32Array(0),
  faceAddr: new Int32Array(0),
  triangleCount: 0,
}

export function meshSketch(profile: Profile, options: SketchMeshOptions): SketchMesh {
  const outline = outlineOf(profile.points, options.rounds ?? 3)
  const h = options.height
  const { cap, wall, lip } = options
  const wallProfile = wallProfilePolyline(options.profile ?? PLUMB)
  if (outline.points.length < 3) {
    return { outline, cap: EMPTY, rim: EMPTY, wallBody: EMPTY, wallTop: EMPTY, wallBottom: EMPTY }
  }

  switch (lip) {
    case 'flat':
      return {
        outline,
        cap: buildCap(outline, h, outline.points, cap.fillScale),
        rim: buildRimOnCap(outline, h, outline.points, cap.rim, 1, 0),
        wallBody: buildWallBody(outline, h, wallProfile, h, wall.bodyScale),
        wallTop: buildWallBand(outline, h, wallProfile, h - wall.top.width, h, wall.top, 0, 1),
        wallBottom: buildWallBand(outline, h, wallProfile, 0, wall.bottom.width, wall.bottom, 0, 1),
      }
    case 'skirt': {
      const skirt = buildSkirt(outline, h, wallProfile, cap.rim)
      return {
        outline,
        cap: buildCap(outline, h, outline.points, cap.fillScale),
        rim: skirt.cap,
        wallBody: buildWallBody(outline, h, wallProfile, h, wall.bodyScale),
        wallTop: skirt.wall,
        wallBottom: buildWallBand(outline, h, wallProfile, 0, wall.bottom.width, wall.bottom, 0, 1),
      }
    }
    case 'bevel': {
      const size = wall.top.width
      const capPoints = inset(outline.points, size)
      return {
        outline,
        cap: buildCap(outline, h, capPoints, cap.fillScale),
        rim: buildRimOnCap(outline, h, capPoints, cap.rim, 1, 0),
        wallBody: buildWallBody(outline, h, wallProfile, h - size, wall.bodyScale),
        wallTop: buildBevel(outline, h, size, wall.top),
        wallBottom: buildWallBand(outline, h, wallProfile, 0, wall.bottom.width, wall.bottom, 0, 1),
      }
    }
  }
}
