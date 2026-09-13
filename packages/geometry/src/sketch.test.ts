import { describe, expect, it } from 'vitest'

import { meshSketch, outlineOf, triangulate, wallProfilePolyline, wallProfilePreset, type Profile } from './sketch'

const square: Profile = {
  points: [
    { x: 0, z: 0, smooth: false },
    { x: 4, z: 0, smooth: false },
    { x: 4, z: 4, smooth: false },
    { x: 0, z: 4, smooth: false },
  ],
}
const specs = {
  cap: { fillScale: 1, rim: { width: 0.5, segment: 2, repeat: 'stretch' as const } },
  wall: { bodyScale: 1, top: { width: 0.5, segment: 2, repeat: 'tile' as const }, bottom: { width: 0.5, segment: 2, repeat: 'stretch' as const } },
}

describe('outline', () => {
  it('normalises orientation so a profile clicked either way round meshes the same', () => {
    const cw: Profile = { points: [...square.points].reverse() }
    expect(outlineOf(cw.points).points).toEqual(outlineOf(square.points).points)
    expect(outlineOf(cw.points).area).toBe(16)
    expect(outlineOf(square.points).area).toBe(16)
    expect(outlineOf(square.points).perimeter).toBe(16)
  })

  it('rounds smooth points and leaves corners exactly where they were', () => {
    const rounded = outlineOf(square.points.map((p, i) => ({ ...p, smooth: i > 0 })), 2)
    expect(rounded.points.length).toBeGreaterThan(4)
    expect(rounded.points).toContainEqual([0, 0])
    expect(rounded.points).not.toContainEqual([4, 4])
    expect(rounded.area).toBeLessThan(16)
  })
})

describe('triangulate', () => {
  it('produces n − 2 triangles for a concave polygon', () => {
    const l = [
      [0, 0],
      [4, 0],
      [4, 1],
      [1, 1],
      [1, 4],
      [0, 4],
    ] as const
    expect(triangulate(l).length / 3).toBe(4)
  })
})

describe('meshSketch', () => {
  it('walls face outward whichever lip style is used', () => {
    for (const lip of ['flat', 'skirt', 'bevel'] as const) {
      const mesh = meshSketch(square, { height: 2, ...specs, lip })
      const { positions, normals, triangleCount } = mesh.wallBody
      expect(triangleCount).toBeGreaterThan(0)
      for (let i = 0; i < positions.length; i += 3) {
        const away = (positions[i] - 2) * normals[i] + (positions[i + 2] - 2) * normals[i + 2]
        expect(away).toBeGreaterThan(0)
      }
    }
  })

  it('stretch bands end on a whole number of texture copies; tile bands on the perimeter over the segment', () => {
    const mesh = meshSketch(square, { height: 2, ...specs, lip: 'flat' })
    const maxU = (uvs: Float32Array) => Math.max(...Array.from(uvs).filter((_, i) => i % 2 === 0))
    expect(maxU(mesh.rim.uvs)).toBe(8) // 16 / 2, already whole
    expect(maxU(mesh.wallTop.uvs)).toBe(8)
    const odd = meshSketch(square, { height: 2, cap: specs.cap, wall: { ...specs.wall, bottom: { width: 0.5, segment: 3, repeat: 'stretch' } }, lip: 'flat' })
    expect(maxU(odd.wallBottom.uvs)).toBe(5) // round(16 / 3)
  })

  it('sweeps a drawn wall profile: the base sits outside the lip by the profile’s offset', () => {
    const mesh = meshSketch(square, { height: 2, ...specs, lip: 'flat', profile: wallProfilePreset('straight', 1) })
    const xs = Array.from(mesh.wallBody.positions).filter((_, i) => i % 3 === 0)
    expect(Math.min(...xs)).toBeCloseTo(-1)
    expect(Math.max(...xs)).toBeCloseTo(5)
    const ys = Array.from(mesh.wallBody.positions).filter((_, i) => i % 3 === 1)
    expect(Math.max(...ys)).toBe(2)
  })

  it('a smooth profile keeps its endpoints', () => {
    const poly = wallProfilePolyline(wallProfilePreset('curve', 1))
    expect(poly[0]).toEqual({ out: 1, t: 0 })
    expect(poly[poly.length - 1]).toEqual({ out: 0, t: 1 })
    expect(poly.length).toBeGreaterThan(5)
  })
})
