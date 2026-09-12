import { describe, expect, it } from 'vitest'

import {
  cellIndex,
  cliffKey,
  createMap,
  readAddress,
  SURFACE_CLIFF,
  SURFACE_TOP,
  type MapDoc,
} from '@map-editor/document'
import { meshTerrainChunk } from './terrain'

function setHeight(doc: MapDoc, x: number, y: number, h: number): void {
  doc.terrain.height[cellIndex(doc.size, x, y)] = h
}

describe('paint survives sculpt', () => {
  it('keeps cliff paint dormant when the cliff is lowered, and restores it', () => {
    // Built directly, and no store at all: this is a fact about the mesher and
    // the paint addressing, and a test may construct a document (#10). The
    // write path is an actor in another package now — reaching for one here
    // would only re-test that actor.
    const doc = createMap(8, 8)
    setHeight(doc, 3, 3, 8)

    // Paint the band at absolute level 6 on the east face.
    const key = cliffKey(3, 3, 0, 6)
    doc.paint.cliff[key] = 42
    expect(doc.paint.cliff[key]).toBe(42)

    // Sculpt the cliff down below that band. The face stops being meshed.
    setHeight(doc, 3, 3, 4)
    const lowered = meshTerrainChunk(doc, '0,0')
    const levels = new Set<number>()
    for (let tri = 0; tri < lowered.solid.triangleCount; tri++) {
      const address = readAddress(lowered.solid.faceAddr, tri)
      if (address.kind === SURFACE_CLIFF && address.x === 3 && address.y === 3) {
        levels.add(address.level)
      }
    }
    expect(levels.has(6)).toBe(false)

    // The paint is still there. Nothing garbage-collected it.
    expect(doc.paint.cliff[key]).toBe(42)

    // Raise it back and the artist's work reappears at the same address.
    setHeight(doc, 3, 3, 8)
    const restored = meshTerrainChunk(doc, '0,0')
    let found = false
    for (let tri = 0; tri < restored.solid.triangleCount; tri++) {
      const address = readAddress(restored.solid.faceAddr, tri)
      if (address.kind === SURFACE_CLIFF && address.x === 3 && address.y === 3 && address.level === 6) {
        found = true
      }
    }
    expect(found).toBe(true)
    expect(doc.paint.cliff[key]).toBe(42)
  })
})

describe('mesher', () => {
  it('emits a top quad per cell and addresses it back to the cell', () => {
    const doc = createMap(4, 4)
    const mesh = meshTerrainChunk(doc, '0,0')
    const tops = new Set<string>()
    for (let tri = 0; tri < mesh.solid.triangleCount; tri++) {
      const address = readAddress(mesh.solid.faceAddr, tri)
      if (address.kind === SURFACE_TOP) tops.add(`${address.x},${address.y}`)
    }
    expect(tops.size).toBe(16)
  })

  it('emits one cliff band per half-tile level of the drop', () => {
    const doc = createMap(4, 4)
    setHeight(doc, 1, 1, 6)
    const mesh = meshTerrainChunk(doc, '0,0')
    const east = new Set<number>()
    for (let tri = 0; tri < mesh.solid.triangleCount; tri++) {
      const address = readAddress(mesh.solid.faceAddr, tri)
      if (address.kind === SURFACE_CLIFF && address.x === 1 && address.y === 1 && address.dir === 0) {
        east.add(address.level)
      }
    }
    // Neighbour sits at 2, this cell at 6: bands at 2, 3, 4, 5.
    expect([...east].sort((a, b) => a - b)).toEqual([2, 3, 4, 5])
  })

  it('suppresses the cliff on a ramp’s descending side', () => {
    const doc = createMap(4, 4)
    setHeight(doc, 1, 1, 4)
    doc.terrain.ramp[cellIndex(doc.size, 1, 1)] = 0
    const mesh = meshTerrainChunk(doc, '0,0')
    for (let tri = 0; tri < mesh.solid.triangleCount; tri++) {
      const address = readAddress(mesh.solid.faceAddr, tri)
      if (address.kind === SURFACE_CLIFF && address.x === 1 && address.y === 1) {
        expect(address.dir).not.toBe(0)
      }
    }
  })

  it('gives every quad a non-degenerate UV rectangle', () => {
    // Regression: top quads and side faces walk their corners along different
    // axes, and a shared rectangle-to-corner mapping collapsed the top quad's
    // UVs onto two points, which streaked the whole terrain.
    const doc = createMap(4, 4)
    setHeight(doc, 1, 1, 6)
    const { solid } = meshTerrainChunk(doc, '0,0')

    for (let quad = 0; quad < solid.positions.length / 3 / 4; quad++) {
      const us: number[] = []
      const vs: number[] = []
      for (let corner = 0; corner < 4; corner++) {
        const index = (quad * 4 + corner) * 2
        us.push(solid.uvs[index])
        vs.push(solid.uvs[index + 1])
      }
      // A tile occupies a rectangle, so both axes must actually vary.
      expect(Math.max(...us) - Math.min(...us)).toBeGreaterThan(1e-6)
      expect(Math.max(...vs) - Math.min(...vs)).toBeGreaterThan(1e-6)
      // And all four corners must be distinct points in UV space.
      const unique = new Set(us.map((u, i) => `${u.toFixed(6)},${vs[i].toFixed(6)}`))
      expect(unique.size).toBe(4)
    }
  })

  it('maps the sheet the right way up on a top quad', () => {
    const doc = createMap(4, 4)
    const { solid } = meshTerrainChunk(doc, '0,0')
    // Corner order is c00, c01, c11, c10. c00 is the sheet's top-left, which
    // in GL coordinates is the largest v.
    const v00 = solid.uvs[1]
    const v01 = solid.uvs[3]
    const u00 = solid.uvs[0]
    const u11 = solid.uvs[4]
    expect(v00).toBeGreaterThan(v01)
    expect(u11).toBeGreaterThan(u00)
  })

  it('produces finite, consistent buffers', () => {
    const doc = createMap(8, 8)
    setHeight(doc, 2, 2, 7)
    doc.terrain.ramp[cellIndex(doc.size, 3, 2)] = 1
    const { solid } = meshTerrainChunk(doc, '0,0')
    expect(solid.positions.length / 3).toBe(solid.normals.length / 3)
    expect(solid.positions.length / 3).toBe(solid.uvs.length / 2)
    expect(solid.positions.length / 3).toBe(solid.colors.length / 3)
    expect(solid.faceAddr.length / 4).toBe(solid.triangleCount)
    expect([...solid.positions].every(Number.isFinite)).toBe(true)
    expect([...solid.normals].every(Number.isFinite)).toBe(true)
  })
})
