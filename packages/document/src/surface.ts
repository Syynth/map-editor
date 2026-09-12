/**
 * Surface addressing: what a pick names.
 *
 * A picked triangle resolves to a surface on a structure — a voxel cell's
 * top, one band of one cliff face, a water quad — so every tool means the
 * same thing by "what is under the cursor". The per-triangle encoding
 * (`faceAddr`, four ints) is the mesher's; the structure the mesh belongs to
 * is known to whoever built the mesh, so it rides alongside rather than
 * inside the ints.
 */

export const SURFACE_TOP = 0
export const SURFACE_CLIFF = 1
export const SURFACE_WATER = 2

export type SurfaceKind = typeof SURFACE_TOP | typeof SURFACE_CLIFF | typeof SURFACE_WATER

export interface SurfaceAddress {
  /** The structure the surface belongs to. */
  structure: string
  kind: SurfaceKind
  x: number
  y: number
  /** Cliff faces: which side (0 E, 1 S, 2 W, 3 N). */
  dir: number
  /** Cliff faces: which half-tile band. */
  level: number
}

const LEVEL_BIAS = 32768

export function encodeExtra(dir: number, level: number): number {
  return (dir << 17) | (level + LEVEL_BIAS)
}

export function decodeExtra(extra: number): { dir: number; level: number } {
  return { dir: extra >> 17, level: (extra & 0x1ffff) - LEVEL_BIAS }
}

export function readAddress(faceAddr: Int32Array, tri: number, structure: string): SurfaceAddress {
  const base = tri * 4
  const { dir, level } = decodeExtra(faceAddr[base + 3])
  return {
    structure,
    kind: faceAddr[base] as SurfaceKind,
    x: faceAddr[base + 1],
    y: faceAddr[base + 2],
    dir,
    level,
  }
}

export function sameSurface(a: SurfaceAddress | null, b: SurfaceAddress | null): boolean {
  if (!a || !b) return a === b
  return a.structure === b.structure && a.kind === b.kind && a.x === b.x && a.y === b.y && a.dir === b.dir && a.level === b.level
}

export function describeSurface(address: SurfaceAddress | null): string {
  if (!address) return '—'
  if (address.kind === SURFACE_TOP) return `top (${address.x}, ${address.y})`
  if (address.kind === SURFACE_WATER) return `water (${address.x}, ${address.y})`
  const sides = ['E', 'S', 'W', 'N']
  return `cliff (${address.x}, ${address.y}) ${sides[address.dir]} level ${address.level}`
}
