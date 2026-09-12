/**
 * Structures: what a level is made of.
 *
 * A level is a scene graph of structures (ruling of 2026-09-12, "The level
 * is a scene graph of structures"). Each structure has a kind, a placement
 * relative to the structure it sits in, and kind-specific data. Any kind can
 * be the child of any kind: a sketch extrusion placed inside a voxel volume,
 * a voxel volume standing on a sketch's cap. Objects, camera and atmosphere
 * stay level-level; everything terrain-shaped — data, edits, meshing,
 * height-at-point, picking, tools, materials — is answered per kind.
 *
 * This module holds the data and what can be derived from it without
 * geometry: the tree, and a sketch's outline (which is what the sketch
 * MEANS, so the height query and the mesher must agree on it). What each
 * kind does with triangles is registered in the layer that does it: the
 * mesher in `geometry`, the scene in `runtime`, the tools in a `feature-*`.
 */

import type { DeepReadonly, MapSize, PaintLayers, TerrainData } from './document'

/** A quarter-turn count: 0 east, 1 south, 2 west, 3 north. Voxel kinds turn in quarters or every cell-based tool breaks. */
export type QuarterTurn = 0 | 1 | 2 | 3

/**
 * Where a structure sits, relative to its parent's frame — its parent's
 * origin, at the height of its parent's top there. Integers for a voxel
 * volume so cells stay on the grid; a sketch is free.
 */
export interface Placement {
  x: number
  z: number
  yaw: QuarterTurn
}

export interface StructureBase {
  id: string
  name: string
  /** The structure this one sits in, or `null` at the root. */
  parent: string | null
  placement: Placement
}

/**
 * Cells stacked in layers on a grid — the ground the Terrain tool sculpts
 * and paints. One height per column today; to hold true voxel occupancy per
 * #100. Its `size` is its own, resizable at its edges; the level has no size.
 */
export interface VoxelStructure extends StructureBase {
  kind: 'voxel'
  size: MapSize
  terrain: TerrainData
  paint: PaintLayers
}

/** One point of a sketch's outline: a corner keeps its exact position and angle; a smooth point is rounded. */
export interface ProfilePoint {
  x: number
  z: number
  smooth: boolean
}

/** A closed outline: the last point joins the first. */
export interface Profile {
  points: ProfilePoint[]
}

/** One point of a wall's side profile: outward offset from the outline (`out`, world units; negative undercuts) at height fraction `t` (0 ground, 1 lip). */
export interface WallProfilePoint {
  out: number
  t: number
}

/** The wall's silhouette from the ground (`t` 0) to the lip (`t` 1, where `out` is 0 by definition), swept around the outline. */
export interface WallProfile {
  points: WallProfilePoint[]
  smooth: boolean
}

/** How a sketch's cap meets its wall: a hard edge, the rim folded over the lip, or a chamfer carrying the top band. */
export type LipStyle = 'flat' | 'skirt' | 'bevel'

/**
 * A closed outline on a horizontal sketch plane, extruded to one height. The
 * plane is the parent's top (or the ground at the root); the height is in
 * layers, like everything vertical. Materials are named entries in the
 * level's library — a cap material and a wall material — so the sketch
 * carries what it is dressed in by reference, never the textures.
 */
export interface SketchStructure extends StructureBase {
  kind: 'sketch'
  points: ProfilePoint[]
  /** An open sketch is still being drawn: it has no cap and no wall yet. */
  closed: boolean
  layers: number
  wall: WallProfile
  lip: LipStyle
  capMaterial: string
  wallMaterial: string
}

export type Structure = VoxelStructure | SketchStructure
export type StructureKind = Structure['kind']
export type ReadonlyStructure = DeepReadonly<Structure>
export type ReadonlyVoxel = DeepReadonly<VoxelStructure>
export type ReadonlySketch = DeepReadonly<SketchStructure>

export interface StructureTree {
  structures: Record<string, Structure>
  /** Draw and list order; every id in `structures`, each once. */
  structureOrder: string[]
}
export type ReadonlyStructureTree = DeepReadonly<StructureTree>

type OfKind<K extends StructureKind> = DeepReadonly<Extract<Structure, { kind: K }>>

export function structureOf<K extends StructureKind>(tree: ReadonlyStructureTree, id: string, kind: K): OfKind<K> | undefined {
  const s = tree.structures[id]
  return s && s.kind === kind ? (s as OfKind<K>) : undefined
}

export function childrenOf(tree: ReadonlyStructureTree, parent: string | null): ReadonlyStructure[] {
  const out: ReadonlyStructure[] = []
  for (const id of tree.structureOrder) {
    const s = tree.structures[id]
    if (s && s.parent === parent) out.push(s)
  }
  return out
}

/** Every id below `id`, depth-first — what a delete takes along. */
export function descendantsOf(tree: ReadonlyStructureTree, id: string): string[] {
  const out: string[] = []
  const walk = (parent: string) => {
    for (const child of childrenOf(tree, parent)) {
      out.push(child.id)
      walk(child.id)
    }
  }
  walk(id)
  return out
}

/** The chain above `id`, nearest parent first; empty at the root. Stops on a cycle rather than spinning. */
export function ancestorsOf(tree: ReadonlyStructureTree, id: string): string[] {
  const out: string[] = []
  let current = tree.structures[id]?.parent ?? null
  while (current && !out.includes(current) && current !== id) {
    out.push(current)
    current = tree.structures[current]?.parent ?? null
  }
  return out
}

/**
 * TRANSITIONAL: the one voxel structure a level is assumed to have while
 * the runtime, viewport and tools still address "the terrain" rather than a
 * structure. Every caller is a site the per-structure step removes. Throws
 * when there is none: that is a level the old code cannot show, and a silent
 * empty grid would hide it.
 */
export function rootVoxel(tree: ReadonlyStructureTree): ReadonlyVoxel {
  for (const id of tree.structureOrder) {
    const s = tree.structures[id]
    if (s && s.kind === 'voxel' && s.parent === null) return s
  }
  throw new Error('This level has no root voxel structure; the grid-only code paths cannot show it yet.')
}

// --- outline ------------------------------------------------------------------

type Vec2 = readonly [number, number]

export interface Outline {
  /** x, z pairs, counter-clockwise seen from above, no repeated closing point. */
  readonly points: readonly Vec2[]
  /** Arc length at each point; the last edge closes to `perimeter`. */
  readonly arc: readonly number[]
  readonly perimeter: number
  readonly area: number
}

/** Chaikin corner-cutting with corner points held fixed. */
function round(points: readonly DeepReadonly<ProfilePoint>[], rounds: number): DeepReadonly<ProfilePoint>[] {
  let current = [...points]
  for (let r = 0; r < rounds; r++) {
    const next: DeepReadonly<ProfilePoint>[] = []
    for (let i = 0; i < current.length; i++) {
      const a = current[i]
      const b = current[(i + 1) % current.length]
      if (a.smooth) next.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25, smooth: true })
      else next.push(a)
      if (b.smooth) next.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75, smooth: true })
    }
    current = next
  }
  return current
}

function signedArea(points: readonly Vec2[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const [x0, z0] = points[i]
    const [x1, z1] = points[(i + 1) % points.length]
    sum += x0 * z1 - x1 * z0
  }
  return sum / 2
}

/**
 * The outline a sketch's points mean: smooth points rounded, corners held,
 * orientation normalised (positive signed area in x, z) so whichever way the
 * points were clicked, "outward" means the same thing to everyone.
 */
export function outlineOf(points: readonly DeepReadonly<ProfilePoint>[], rounds = 3): Outline {
  let pts: Vec2[] = round(points, rounds).map((p) => [p.x, p.z] as const)
  const area = signedArea(pts)
  if (area < 0) pts = pts.reverse()
  const arc: number[] = []
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    arc.push(s)
    const [x0, z0] = pts[i]
    const [x1, z1] = pts[(i + 1) % pts.length]
    s += Math.hypot(x1 - x0, z1 - z0)
  }
  return { points: pts, arc, perimeter: s, area: Math.abs(area) }
}

/** Even-odd ray test: is (x, z) inside the outline? */
export function pointInOutline(outline: Outline, x: number, z: number): boolean {
  const pts = outline.points
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i]
    const [xj, zj] = pts[j]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}
