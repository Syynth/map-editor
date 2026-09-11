/**
 * Surface addresses.
 *
 * Picking resolves a ray to a *surface and a cell on it*, not a point in
 * space. The mesher emits an address alongside every triangle so a raycast
 * hit can be turned straight back into a document coordinate, which is what
 * lets a paint stroke write to the stable keys in paint.ts.
 */

export const SURFACE_TOP = 0
export const SURFACE_CLIFF = 1
export const SURFACE_WATER = 2

export type SurfaceKind = typeof SURFACE_TOP | typeof SURFACE_CLIFF | typeof SURFACE_WATER

export interface SurfaceAddress {
  kind: SurfaceKind
  x: number
  y: number
  /** Cliff only. */
  dir: number
  /** Cliff only: absolute half-tile level of the band. */
  level: number
}

const LEVEL_BIAS = 32768

export function encodeExtra(dir: number, level: number): number {
  return (dir << 17) | (level + LEVEL_BIAS)
}

export function decodeExtra(extra: number): { dir: number; level: number } {
  return { dir: extra >> 17, level: (extra & 0x1ffff) - LEVEL_BIAS }
}

/** Read the address of triangle `tri` out of a packed faceAddr array. */
export function readAddress(faceAddr: Int32Array, tri: number): SurfaceAddress {
  const base = tri * 4
  const { dir, level } = decodeExtra(faceAddr[base + 3])
  return {
    kind: faceAddr[base] as SurfaceKind,
    x: faceAddr[base + 1],
    y: faceAddr[base + 2],
    dir,
    level,
  }
}

export function sameSurface(a: SurfaceAddress | null, b: SurfaceAddress | null): boolean {
  if (!a || !b) return a === b
  return a.kind === b.kind && a.x === b.x && a.y === b.y && a.dir === b.dir && a.level === b.level
}

export function describeSurface(address: SurfaceAddress | null): string {
  if (!address) return '—'
  if (address.kind === SURFACE_TOP) return `top (${address.x}, ${address.y})`
  if (address.kind === SURFACE_WATER) return `water (${address.x}, ${address.y})`
  const sides = ['E', 'S', 'W', 'N']
  return `cliff (${address.x}, ${address.y}) ${sides[address.dir]} level ${address.level}`
}
