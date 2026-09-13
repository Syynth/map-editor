import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { TOP_PITCH, ViewCube, cubePieces, pieceGeometry, viewOf } from './cube'

describe('the view cube', () => {
  it('has a piece for every face, edge and corner, and no view for the underside', () => {
    const pieces = cubePieces()
    expect(pieces).toHaveLength(26)
    expect(pieces.filter((piece) => piece.kind === 'face')).toHaveLength(6)
    expect(pieces.filter((piece) => piece.kind === 'edge')).toHaveLength(12)
    expect(pieces.filter((piece) => piece.kind === 'corner')).toHaveLength(8)
    expect(pieces.filter((piece) => piece.view === null).map((piece) => piece.id)).toEqual(pieces.filter((piece) => piece.axes[1] < 0).map((piece) => piece.id))
    expect(pieces.filter((piece) => piece.view !== null)).toHaveLength(17)
  })

  it('names the views the rig places a camera by: +z is the front at yaw 0, +x the right at yaw 90', () => {
    expect(viewOf([0, 0, 1])).toEqual({ yaw: 0, pitch: 0 })
    expect(viewOf([1, 0, 0])).toEqual({ yaw: 90, pitch: 0 })
    expect(viewOf([0, 0, -1])).toEqual({ yaw: -180, pitch: 0 })
    expect(viewOf([-1, 0, 0])).toEqual({ yaw: -90, pitch: 0 })
    expect(viewOf([0, 1, 0])).toEqual({ yaw: 0, pitch: TOP_PITCH })
    expect(viewOf([1, 1, 1])?.yaw).toBe(45)
    expect(viewOf([1, 1, 1])?.pitch).toBeCloseTo(35.264, 2)
    expect(viewOf([1, 1, 0])?.pitch).toBeCloseTo(45, 9)
  })

  it('winds every piece outward and tiles the cube closed', () => {
    let area = 0
    for (const piece of cubePieces()) {
      const geometry = pieceGeometry(piece, 0.25)
      const positions = geometry.getAttribute('position')
      const outward = new THREE.Vector3(...piece.axes)
      for (let i = 0; i < positions.count; i += 3) {
        const a = new THREE.Vector3().fromBufferAttribute(positions, i)
        const b = new THREE.Vector3().fromBufferAttribute(positions, i + 1)
        const c = new THREE.Vector3().fromBufferAttribute(positions, i + 2)
        const normal = b.sub(a).cross(c.sub(a))
        expect(normal.dot(outward)).toBeGreaterThan(0)
        area += normal.length() / 2
      }
    }
    // The surface of a chamfered cube: six 1.5² faces, twelve 1.5 × (0.25√2) strips, eight triangles of side 0.25√2.
    const strip = 1.5 * 0.25 * Math.SQRT2
    const corner = (Math.sqrt(3) / 4) * (0.25 * Math.SQRT2) ** 2
    expect(area).toBeCloseTo(6 * 1.5 * 1.5 + 12 * strip + 8 * corner, 6)
  })

  it('picks the piece under the cursor for the camera it is turned to', () => {
    const cube = new ViewCube()
    cube.orient(0, 0)
    expect(cube.pieceAt(0.5, 0.5)?.id).toBe('+z')
    cube.orient(90, 0)
    expect(cube.pieceAt(0.5, 0.5)?.id).toBe('+x')
    cube.orient(0, TOP_PITCH)
    expect(cube.pieceAt(0.5, 0.5)?.id).toBe('+y')
    // Off the cube entirely.
    expect(cube.pieceAt(0.02, 0.02)).toBeNull()
    // From the default three-quarter view, the near corner is dead centre.
    cube.orient(45, 35.264)
    expect(cube.pieceAt(0.5, 0.5)?.id).toBe('+x+y+z')
    cube.dispose()
  })

  it('knows when the camera already sits at a view, across the yaw wrap', () => {
    expect(ViewCube.atView({ yaw: 179.8, pitch: 0.2 }, { yaw: -180, pitch: 0 })).toBe(true)
    expect(ViewCube.atView({ yaw: 44, pitch: 35 }, { yaw: 45, pitch: 35.264 })).toBe(false)
  })
})
