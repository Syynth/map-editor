import {
  SURFACE_CLIFF,
  SURFACE_TOP,
  cellIndex,
  createMap,
  topKey,
  type Patch,
  type ReadonlyMapDoc,
  type SurfaceAddress,
  type MapDoc,
  type VoxelStructure,
} from '@map-editor/document'
import { describe, expect, it } from 'vitest'

import { terrainContract } from './stroke'
import type { FeatureDeps } from './deps'
import type { TerrainParams } from './verbs'

/** The root voxel volume a fresh level has, mutable for setup: `createMap` names it `ground`. */
const ground = (doc: ReadonlyMapDoc | MapDoc): VoxelStructure => doc.structures.ground as VoxelStructure


/**
 * The contract on its own, with a stub for the deps the host supplies. That
 * this file needs no host, no actor and no React is the extraction's point:
 * #35 puts a feature beside the host rather than under it, so the behavior a
 * terrain stroke has must be testable from the feature alone.
 */
const defaults: TerrainParams = {
  terrainMode: 'sculpt',
  sculptVerb: 'raise',
  paintVerb: 'tile',
  strokeShape: 'brush',
  brush: { size: 1, shape: 'square' },
  material: 0,
  tile: 0,
  tint: 0xffffff,
  rampDir: -1,
  sculptDeadZone: 0.2,
}

function stub(doc: ReadonlyMapDoc, overrides: Partial<TerrainParams> = {}) {
  let params: TerrainParams = { ...defaults, ...overrides }
  const applied: Array<{ label: string; patches: readonly Patch[] }> = []
  const deps: FeatureDeps = {
    doc: () => doc,
    params: () => params,
    setParams: (changes) => void (params = { ...params, ...changes }),
    apply: (label, patches) => void applied.push({ label, patches }),
    select: () => undefined,
  }
  return { deps, applied, current: () => params }
}

const top = (x: number, y: number): SurfaceAddress => ({ structure: 'ground', x, y, kind: SURFACE_TOP, dir: 0, level: 0 })
const sample = (address: SurfaceAddress | null, modifiers: Partial<{ shift: boolean; alt: boolean; ctrl: boolean }> = {}) => ({
  pick: { surface: address },
  modifiers: { shift: false, alt: false, ctrl: false, ...modifiers },
})
/** A mid-stroke tick with the pointer at `(x, z)` on the press plane; the ray hits `address`, which a sculpt stroke must ignore. */
const planeSample = (x: number, z: number, address: SurfaceAddress | null = null) => ({
  pick: { surface: address, plane: { x, z } },
  modifiers: { shift: false, alt: false, ctrl: false },
})

describe('a sculpt stroke steers by the press plane, with a dead zone', () => {
  it("does not re-fire on the cell it just raised when the ray now hits that cell's new face", () => {
    const doc = createMap(8, 8)
    const { deps } = stub(doc)
    const handler = terrainContract(deps).stroke(sample(top(1, 1)))
    expect(handler?.begin(sample(top(1, 1)))).toHaveLength(1)
    // The pointer has barely moved; the pick now says "cliff face of (1,1)".
    const face: SurfaceAddress = { structure: 'ground', x: 1, y: 1, kind: SURFACE_CLIFF, dir: 2, level: 1 }
    expect(handler?.move(planeSample(1.5, 1.6, face))).toEqual([])
    expect(handler?.move(planeSample(1.9, 1.9, face))).toEqual([])
  })

  it('moves to the next cell only once the pointer is the dead zone past the boundary', () => {
    const doc = createMap(8, 8)
    const { deps } = stub(doc, { sculptDeadZone: 0.2 })
    const handler = terrainContract(deps).stroke(sample(top(1, 1)))
    handler?.begin(sample(top(1, 1)))
    expect(handler?.move(planeSample(2.1, 1.5))).toEqual([]) // over the line, inside the dead zone
    expect(handler?.move(planeSample(2.25, 1.5))).toHaveLength(1) // past it
    // Back across the same line: the dead zone applies in both directions.
    expect(handler?.move(planeSample(1.9, 1.5))).toEqual([])
    expect(handler?.move(planeSample(1.7, 1.5))).toHaveLength(1)
  })

  it('a dead zone of zero is the exact boundary, and a corner crossing must clear both edges', () => {
    const doc = createMap(8, 8)
    const { deps } = stub(doc, { sculptDeadZone: 0 })
    const handler = terrainContract(deps).stroke(sample(top(1, 1)))
    handler?.begin(sample(top(1, 1)))
    expect(handler?.move(planeSample(2.0, 1.5))).toHaveLength(1)
    const { deps: deps2 } = stub(createMap(8, 8), { sculptDeadZone: 0.25 })
    const handler2 = terrainContract(deps2).stroke(sample(top(1, 1)))
    handler2?.begin(sample(top(1, 1)))
    expect(handler2?.move(planeSample(2.3, 2.1))).toEqual([]) // past x's zone, not z's
    expect(handler2?.move(planeSample(2.3, 2.3))).toHaveLength(1)
  })

  it('ramp and paint keep steering by the pick, since they target faces', () => {
    const doc = createMap(8, 8)
    const { deps } = stub(doc, { terrainMode: 'paint', paintVerb: 'material', material: 1 })
    const handler = terrainContract(deps).stroke(sample(top(1, 1)))
    handler?.begin(sample(top(1, 1)))
    // The plane says (1,1) still; the pick says (3,3). Paint follows the pick.
    const patches = handler?.move(planeSample(1.5, 1.5, top(3, 3)))
    expect(patches).toHaveLength(1)
    expect(patches?.[0]).toMatchObject({ t: 'voxel', id: 'ground', field: 'material', index: cellIndex(ground(doc).size, 3, 3), value: 1 })
  })
})

describe('the terrain tool contract', () => {
  it('applies nothing itself: every phase answers with patches', () => {
    const doc = createMap(8, 8)
    const { deps, applied } = stub(doc)
    const handler = terrainContract(deps).stroke(sample(top(1, 1)))

    expect(handler?.begin(sample(top(1, 1)))).toHaveLength(1)
    expect(applied).toEqual([])
    expect(ground(doc).terrain.height[cellIndex(ground(doc).size, 1, 1)]).toBe(2)
  })

  it('skips a move that stays on the cell the last tick edited', () => {
    const { deps } = stub(createMap(8, 8))
    const handler = terrainContract(deps).stroke(sample(top(1, 1)))
    handler?.begin(sample(top(1, 1)))

    expect(handler?.move(sample(top(1, 1)))).toEqual([])
    expect(handler?.move(sample(top(2, 1)))).toHaveLength(1)
  })

  it('holds a rectangle open until release, and grows it from the press', () => {
    const { deps } = stub(createMap(8, 8), { strokeShape: 'rect' })
    const handler = terrainContract(deps).stroke(sample(top(1, 1)))

    expect(handler?.begin(sample(top(1, 1)))).toEqual([])
    expect(handler?.move(sample(top(3, 2)))).toEqual([])
    // 3x2 cells, anchored where the press landed — the anchor is the
    // handler's, which is what makes it die with the stroke.
    expect(handler?.end(sample(top(3, 2)))).toHaveLength(6)
  })

  it('reads the brush width per tick, so widening mid-drag takes effect', () => {
    const { deps } = stub(createMap(8, 8))
    const handler = terrainContract(deps).stroke(sample(top(1, 1)))
    expect(handler?.begin(sample(top(1, 1)))).toHaveLength(1)

    deps.setParams({ brush: { size: 3, shape: 'square' } })

    expect(handler?.move(sample(top(4, 4)))).toHaveLength(9)
  })

  it('alt picks a tile up instead of editing, and only on the press', () => {
    const doc = createMap(8, 8)
    ground(doc).paint.top[topKey(2, 2)] = 9
    const { deps, current } = stub(doc, { terrainMode: 'paint', paintVerb: 'tile' })
    const handler = terrainContract(deps).stroke(sample(top(2, 2), { alt: true }))

    expect(handler?.begin(sample(top(2, 2), { alt: true }))).toEqual([])
    expect(current().tile).toBe(9)

    // A move with alt still held changes nothing further: the eyedropper is a
    // click, not a drag.
    ground(doc).paint.top[topKey(3, 3)] = 4
    expect(handler?.move(sample(top(3, 3), { alt: true }))).toEqual([])
    expect(current().tile).toBe(9)
  })

  it('turns a clicked cliff face into a ramp descending the way it points', () => {
    const cliff: SurfaceAddress = { structure: 'ground', x: 2, y: 2, kind: SURFACE_CLIFF, dir: 3, level: 1 }
    const doc = createMap(8, 8)
    const { deps } = stub(doc, { sculptVerb: 'ramp' })
    const handler = terrainContract(deps).stroke(sample(cliff))

    // `rampDir` is -1 — "click a cliff" — so the direction comes from the face.
    expect(handler?.begin(sample(cliff))).toEqual([{ t: 'voxel', id: 'ground', field: 'ramp', index: cellIndex(ground(doc).size, 2, 2), value: 3 }])
  })

  it('declines a press that missed the terrain', () => {
    const { deps } = stub(createMap(8, 8))
    expect(terrainContract(deps).stroke(sample(null))).toBeUndefined()
  })
})
