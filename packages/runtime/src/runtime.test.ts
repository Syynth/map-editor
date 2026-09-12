import { describe, expect, it } from 'vitest'

import {
  createMap,
  defaultCameraRig,
  defaultFacing,
  type CameraRig,
  type MapObject,
  rootVoxel,
  type MapDoc,
  type ReadonlyMapDoc,
  type VoxelStructure,
} from '@map-editor/document'
import { pickFacing, resolveDisplayMode } from './billboard'
import {
  clampToBounds,
  sampleYawEnvelope,
  withinBounds,
  wrapDegrees,
  yawWithinBounds,
} from './camera'
import { analyseCoverage } from './coverage'

/** The root voxel volume a fresh level has, mutable for setup: `createMap` names it `ground`. */
const ground = (doc: ReadonlyMapDoc | MapDoc): VoxelStructure => rootVoxel(doc) as VoxelStructure


function rig(overrides: Partial<CameraRig['bounds']> = {}, rest: Partial<CameraRig> = {}): CameraRig {
  const base = defaultCameraRig()
  return { ...base, ...rest, bounds: { ...base.bounds, ...overrides } }
}

function object(overrides: Partial<MapObject> = {}): MapObject {
  return {
    id: 'o1',
    name: 'Thing',
    sprite: 'tree',
    position: [0, 0, 0],
    rotationY: 0,
    scale: 1,
    display: 'fixed',
    facing: defaultFacing(),
    anchorCell: null,
    seed: 0,
    locked: false,
    hidden: false,
    ...overrides,
  }
}

describe('angles', () => {
  it('wraps into -180..180', () => {
    expect(wrapDegrees(190)).toBeCloseTo(-170)
    expect(wrapDegrees(-190)).toBeCloseTo(170)
    expect(wrapDegrees(0)).toBe(0)
  })
})

describe('camera bounds', () => {
  it('treats a full circle as never out of bounds', () => {
    const free = rig({ yawMin: -180, yawMax: 180 })
    expect(yawWithinBounds(free, 179.99)).toBe(true)
    expect(yawWithinBounds(free, -180)).toBe(true)
  })

  it('honours a narrow yaw range', () => {
    const narrow = rig({ yawMin: 20, yawMax: 70 })
    expect(yawWithinBounds(narrow, 45)).toBe(true)
    expect(yawWithinBounds(narrow, 90)).toBe(false)
  })

  it('handles a range that wraps past 180', () => {
    const wrapped = rig({ yawMin: 150, yawMax: -150 })
    expect(yawWithinBounds(wrapped, 175)).toBe(true)
    expect(yawWithinBounds(wrapped, -175)).toBe(true)
    expect(yawWithinBounds(wrapped, 0)).toBe(false)
  })

  it('clamps to the nearer edge around the circle', () => {
    const narrow = rig({ yawMin: 20, yawMax: 70 })
    expect(clampToBounds(narrow, { yaw: 10, pitch: 30, distance: 20 }).yaw).toBe(20)
    expect(clampToBounds(narrow, { yaw: 90, pitch: 30, distance: 20 }).yaw).toBe(70)
  })

  it('clamps pitch and distance', () => {
    const r = rig({ pitchMin: 20, pitchMax: 60, distMin: 8, distMax: 40 })
    const out = clampToBounds(r, { yaw: 0, pitch: 90, distance: 100 })
    expect(out.pitch).toBe(60)
    expect(out.distance).toBe(40)
  })

  it('reports when free orbit has left the game envelope', () => {
    const r = rig({ yawMin: 20, yawMax: 70 })
    expect(withinBounds(r, { yaw: 45, pitch: 35, distance: 22 })).toBe(true)
    expect(withinBounds(r, { yaw: 120, pitch: 35, distance: 22 })).toBe(false)
  })

  it('snaps yaw to detents when the rig asks for them', () => {
    const snapped = rig({}, { yawSnapDeg: 90 })
    expect(clampToBounds(snapped, { yaw: 100, pitch: 35, distance: 22 }).yaw).toBe(90)
  })

  it('samples only the detents a snapped rig can reach', () => {
    const snapped = rig({}, { yawSnapDeg: 90 })
    expect(sampleYawEnvelope(snapped).sort((a, b) => a - b)).toEqual([-180, -90, 0, 90])
  })

  it('samples across a bounded range', () => {
    const narrow = rig({ yawMin: 30, yawMax: 60 })
    const yaws = sampleYawEnvelope(narrow, 4)
    expect(yaws[0]).toBeCloseTo(30)
    expect(yaws.at(-1)).toBeCloseTo(60)
  })
})

describe('facing selection', () => {
  it('keeps a single-image sprite on its only image', () => {
    expect(pickFacing(object(), 137, null)).toEqual({ index: 0, mirrored: false })
  })

  it('picks the nearest of four facings', () => {
    const statue = object({ facing: { ...defaultFacing(), facings: 4, mirror: false } })
    expect(pickFacing(statue, 0, null).index).toBe(0)
    expect(pickFacing(statue, 90, null).index).toBe(1)
    expect(pickFacing(statue, 180, null).index).toBe(2)
  })

  it('mirrors the right-hand art for the left side', () => {
    const statue = object({ facing: { ...defaultFacing(), facings: 4, mirror: true } })
    const left = pickFacing(statue, -90, null)
    expect(left.mirrored).toBe(true)
    expect(left.index).toBe(1)
  })

  it('holds the current facing inside the hysteresis band', () => {
    const statue = object({
      facing: { ...defaultFacing(), facings: 4, mirror: false, hysteresisDeg: 10 },
    })
    // 46 degrees is just past the 45 degree boundary between facings 0 and 1.
    expect(pickFacing(statue, 46, 0).index).toBe(0)
    // Far enough past it and the facing finally changes.
    expect(pickFacing(statue, 70, 0).index).toBe(1)
  })

  it('does not stick when there is no hysteresis configured', () => {
    const statue = object({
      facing: { ...defaultFacing(), facings: 4, mirror: false, hysteresisDeg: 0 },
    })
    expect(pickFacing(statue, 46, 0).index).toBe(1)
  })
})

describe('display mode resolution', () => {
  it('uses a cheap fixed plane when the camera barely rotates', () => {
    const locked = rig({ yawMin: 40, yawMax: 50 })
    expect(resolveDisplayMode(object({ display: 'auto' }), locked)).toBe('fixed')
  })

  it('billboards a single-image sprite when the camera orbits freely', () => {
    const free = rig({ yawMin: -180, yawMax: 180 })
    expect(resolveDisplayMode(object({ display: 'auto' }), free)).toBe('billboardY')
  })

  it('leaves a multi-facing sprite as a fixed plane, since it has real sides', () => {
    const free = rig({ yawMin: -180, yawMax: 180 })
    const statue = object({ display: 'auto', facing: { ...defaultFacing(), facings: 4 } })
    expect(resolveDisplayMode(statue, free)).toBe('fixed')
  })

  it('never overrides an explicit choice', () => {
    const free = rig({ yawMin: -180, yawMax: 180 })
    expect(resolveDisplayMode(object({ display: 'extruded' }), free)).toBe('extruded')
  })
})

describe('coverage readout', () => {
  function mapWith(objects: MapObject[], cameraRig: CameraRig) {
    const doc = createMap(8, 8)
    doc.camera = cameraRig
    for (const entry of objects) {
      doc.objects[entry.id] = entry
      doc.objectOrder.push(entry.id)
    }
    return doc
  }

  it('flags a flat plane that a rotating camera sees edge-on', () => {
    const free = rig({ yawMin: -180, yawMax: 180 })
    const doc = mapWith([object({ id: 'a', display: 'fixed' })], free)
    const report = analyseCoverage(doc, free)
    expect(report.objects[0].edgeOn).toBe(true)
    expect(report.readsWrong).toBe(1)
    expect(report.objects[0].suggestion).toMatch(/edge-on/i)
  })

  it('clears the same plane once the camera is locked down', () => {
    const locked = rig({ yawMin: 40, yawMax: 50 })
    const doc = mapWith([object({ id: 'a', display: 'fixed', rotationY: 45 })], locked)
    const report = analyseCoverage(doc, locked)
    expect(report.objects[0].edgeOn).toBe(false)
    expect(report.readsWrong).toBe(0)
  })

  it('flags a sprite that vanishes when seen from behind', () => {
    const free = rig({ yawMin: -180, yawMax: 180 })
    const doc = mapWith(
      [object({ id: 'a', display: 'billboardY', facing: { ...defaultFacing(), back: 'none' } })],
      free,
    )
    // A Y billboard always faces the camera, so 'none' costs it nothing.
    expect(analyseCoverage(doc, free).invisible).toBe(0)

    const flat = mapWith(
      [object({ id: 'b', display: 'fixed', facing: { ...defaultFacing(), back: 'none' } })],
      free,
    )
    expect(analyseCoverage(flat, free).invisible).toBe(1)
  })

  it('prices the fix in images the artist has to draw', () => {
    const free = rig({ yawMin: -180, yawMax: 180 })
    const doc = mapWith(
      [object({ id: 'a', display: 'fixed' }), object({ id: 'b', display: 'fixed', rotationY: 90 })],
      free,
    )
    const report = analyseCoverage(doc, free)
    // Four facings needs three images (left mirrors right). Each object
    // already has one, so each needs two more.
    expect(report.extraImagesToFix).toBe(4)
  })

  it('counts cliff faces no permitted angle can ever see', () => {
    const locked = rig({ yawMin: 0, yawMax: 0 })
    const doc = createMap(8, 8)
    ground(doc).terrain.height[27] = 8
    const report = analyseCoverage(doc, locked)
    expect(report.hiddenSurfaces.totalFaces).toBeGreaterThan(0)
    expect(report.hiddenSurfaces.hiddenFaces).toBeGreaterThan(0)

    // Let the camera go all the way round and nothing is permanently hidden.
    const free = rig({ yawMin: -180, yawMax: 180 })
    expect(analyseCoverage(doc, free).hiddenSurfaces.hiddenFaces).toBe(0)
  })
})
