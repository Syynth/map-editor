import { SURFACE_CLIFF, SURFACE_TOP, cellIndex, createMap, topKey, type Patch, type ReadonlyMapDoc, type SurfaceAddress } from '@map-editor/document'
import { describe, expect, it } from 'vitest'

import { terrainContract } from './stroke'
import type { FeatureDeps } from './deps'
import type { TerrainParams } from './verbs'

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
}

function stub(doc: ReadonlyMapDoc, overrides: Partial<TerrainParams> = {}) {
  let params: TerrainParams = { ...defaults, ...overrides }
  const applied: Array<{ label: string; patches: readonly Patch[] }> = []
  const deps: FeatureDeps = {
    doc: () => doc,
    params: () => params,
    setParams: (changes) => void (params = { ...params, ...changes }),
    apply: (label, patches) => void applied.push({ label, patches }),
  }
  return { deps, applied, current: () => params }
}

const top = (x: number, y: number): SurfaceAddress => ({ x, y, kind: SURFACE_TOP, dir: 0, level: 0 })
const sample = (address: SurfaceAddress | null, modifiers: Partial<{ shift: boolean; alt: boolean; ctrl: boolean }> = {}) => ({
  pick: { surface: address },
  modifiers: { shift: false, alt: false, ctrl: false, ...modifiers },
})

describe('the terrain tool contract', () => {
  it('applies nothing itself: every phase answers with patches', () => {
    const doc = createMap(8, 8)
    const { deps, applied } = stub(doc)
    const handler = terrainContract(deps).stroke(sample(top(1, 1)))

    expect(handler?.begin(sample(top(1, 1)))).toHaveLength(1)
    expect(applied).toEqual([])
    expect(doc.terrain.height[cellIndex(doc.size, 1, 1)]).toBe(2)
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
    doc.paint.top[topKey(2, 2)] = 9
    const { deps, current } = stub(doc, { terrainMode: 'paint', paintVerb: 'tile' })
    const handler = terrainContract(deps).stroke(sample(top(2, 2), { alt: true }))

    expect(handler?.begin(sample(top(2, 2), { alt: true }))).toEqual([])
    expect(current().tile).toBe(9)

    // A move with alt still held changes nothing further: the eyedropper is a
    // click, not a drag.
    doc.paint.top[topKey(3, 3)] = 4
    expect(handler?.move(sample(top(3, 3), { alt: true }))).toEqual([])
    expect(current().tile).toBe(9)
  })

  it('turns a clicked cliff face into a ramp descending the way it points', () => {
    const cliff: SurfaceAddress = { x: 2, y: 2, kind: SURFACE_CLIFF, dir: 3, level: 1 }
    const doc = createMap(8, 8)
    const { deps } = stub(doc, { sculptVerb: 'ramp' })
    const handler = terrainContract(deps).stroke(sample(cliff))

    // `rampDir` is -1 — "click a cliff" — so the direction comes from the face.
    expect(handler?.begin(sample(cliff))).toEqual([{ t: 'terrain', field: 'ramp', index: cellIndex(doc.size, 2, 2), value: 3 }])
  })

  it('declines a press that missed the terrain', () => {
    const { deps } = stub(createMap(8, 8))
    expect(terrainContract(deps).stroke(sample(null))).toBeUndefined()
  })
})
