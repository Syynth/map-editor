import { applyPatches, createMap, frameOf, structureOf, type MapDoc, type Patch, type ReadonlyMapDoc } from '@papercut/document'
import type { FeatureSelection } from '@papercut/registry'
import { describe, expect, it } from 'vitest'

import type { FeatureDeps } from './deps'
import { SKETCH_DEFAULTS, type SketchParams } from './params'
import { CLOSE_RADIUS, nearestSketchPoint, sketchContract, sketchPointHeight } from './stroke'

/**
 * A stub of what the host hands the feature: the document, the parameter
 * slice, and where selection and patches go. Patches are applied straight to
 * the document here, as the stroke actor would after each tick, so a
 * multi-press outline reads back the way it will in the editor.
 */
function stub(doc: MapDoc, overrides: Partial<SketchParams> = {}) {
  let params: SketchParams = { ...SKETCH_DEFAULTS, ...overrides }
  const selections: Array<FeatureSelection | null> = []
  const deps: FeatureDeps = {
    doc: () => doc,
    params: () => params,
    setParams: (changes) => void (params = { ...params, ...changes }),
    apply: (_label, patches) => void applyPatches(doc, [...patches]),
    select: (selection) => void selections.push(selection),
  }
  const contract = sketchContract(deps)
  /** Press at a world point on the ground, run the tick, apply what came back. */
  const press = (x: number, z: number, modifiers = { shift: false, alt: false, ctrl: false }): Patch[] => {
    const sample = { pick: { surface: { structure: 'ground', kind: 0 as const, x: Math.floor(x), y: Math.floor(z), dir: 0, level: 0 }, point: { x, z } }, modifiers }
    const handler = contract.stroke(sample)
    const patches = [...(handler?.begin(sample) ?? [])]
    applyPatches(doc, patches)
    return patches
  }
  return { deps, current: () => params, selections, contract, press }
}

const onlySketch = (doc: ReadonlyMapDoc) => {
  const id = doc.structureOrder.find((each) => doc.structures[each]?.kind === 'sketch')
  return id ? structureOf(doc, id, 'sketch') : undefined
}

describe('drawing an outline', () => {
  it('the first press makes a sketch on the pressed structure with the point snapped; presses add points; the first point again closes it', () => {
    const doc = createMap(12, 12)
    const { press, current, selections } = stub(doc)

    press(2.3, 2.6)
    const sketch = onlySketch(doc)
    expect(sketch).toMatchObject({ parent: 'ground', closed: false })
    expect(sketch?.points).toEqual([{ x: 2, z: 3, smooth: true }])
    expect(current().drawing).toBe(sketch?.id)
    expect(selections.at(-1)).toEqual({ kind: 'structure', id: sketch?.id })

    press(6.1, 2.9, { shift: false, alt: true, ctrl: false })
    press(6, 7)
    expect(onlySketch(doc)?.points).toEqual([
      { x: 2, z: 3, smooth: true },
      { x: 6, z: 3, smooth: false },
      { x: 6, z: 7, smooth: true },
    ])

    // Back to the first point, within reach: the outline closes and the pen lifts.
    press(2 + CLOSE_RADIUS / 2, 3)
    expect(onlySketch(doc)?.closed).toBe(true)
    expect(onlySketch(doc)?.points).toHaveLength(3)
    expect(current().drawing).toBeNull()

    // The next press starts a second sketch rather than adding to the closed one.
    press(9, 9)
    expect(doc.structureOrder.filter((id) => doc.structures[id]?.kind === 'sketch')).toHaveLength(2)
  })

  it('snaps to half cells or not at all as the parameters say, and ctrl means free for one press', () => {
    const doc = createMap(12, 12)
    const half = stub(doc, { sketchSnap: 'half' })
    half.press(2.3, 2.6)
    expect(onlySketch(doc)?.points[0]).toMatchObject({ x: 2.5, z: 2.5 })
    half.press(4.26, 4.24, { shift: false, alt: false, ctrl: true })
    expect(onlySketch(doc)?.points[1]).toMatchObject({ x: 4.26, z: 4.24 })
  })

  it('the first point of a sketch closing on it needs three points', () => {
    const doc = createMap(12, 12)
    const { press } = stub(doc)
    press(2, 2)
    press(2.1, 2.1)
    expect(onlySketch(doc)?.closed).toBe(false)
    expect(onlySketch(doc)?.points).toHaveLength(2)
  })
})

describe('editing an outline', () => {
  const drawn = () => {
    const doc = createMap(12, 12)
    const drawer = stub(doc)
    for (const [x, z] of [
      [2, 2],
      [8, 2],
      [8, 8],
      [2, 8],
    ])
      drawer.press(x, z)
    drawer.press(2, 2)
    return doc
  }

  it('finds the nearest point within reach, in the sketch\'s own frame', () => {
    const doc = drawn()
    const hit = nearestSketchPoint(doc, 8.3, 7.8)
    expect(hit?.index).toBe(2)
    expect(nearestSketchPoint(doc, 5, 5)).toBeNull()
  })

  it('a press near a point selects it and a drag moves it, snapped; a press on nothing clears the selection', () => {
    const doc = drawn()
    const { contract, selections } = stub(doc, { sketchMode: 'edit' })
    const sketch = onlySketch(doc)
    if (!sketch) throw new Error('no sketch')

    const sample = (x: number, z: number, plane?: { x: number; z: number }) => ({
      pick: { surface: null, point: { x, z }, plane },
      modifiers: { shift: false, alt: false, ctrl: false },
    })
    const handler = contract.stroke(sample(8.2, 8.1))
    expect(handler?.begin(sample(8.2, 8.1))).toEqual([])
    expect(selections.at(-1)).toEqual({ kind: 'sketchPoint', structure: sketch.id, index: 2 })

    const moved = handler?.move(sample(0, 0, { x: 9.4, z: 9.6 })) ?? []
    applyPatches(doc, [...moved])
    expect(onlySketch(doc)?.points[2]).toMatchObject({ x: 9, z: 10 })

    const miss = contract.stroke(sample(5, 5))
    miss?.begin(sample(5, 5))
    expect(selections.at(-1)).toBeNull()
  })

  it('a handle the viewport found under the pointer wins over the surface the ray hit', () => {
    const doc = drawn()
    const { contract, selections } = stub(doc, { sketchMode: 'edit' })
    const sketch = onlySketch(doc)
    if (!sketch) throw new Error('no sketch')
    // The ray went on to the ground far from point 1; the dot under the pointer was point 1.
    const sample = { pick: { surface: null, point: { x: 40, z: 40 }, handle: { structure: sketch.id, index: 1 } }, modifiers: { shift: false, alt: false, ctrl: false } }
    const handler = contract.stroke(sample)
    handler?.begin(sample)
    expect(selections.at(-1)).toEqual({ kind: 'sketchPoint', structure: sketch.id, index: 1 })
    applyPatches(doc, [...(handler?.move({ ...sample, pick: { ...sample.pick, plane: { x: 9.2, z: 1.8 } } }) ?? [])])
    expect(onlySketch(doc)?.points[1]).toMatchObject({ x: 9, z: 2 })
  })

  it('a press on the cap away from any point grabs the whole sketch and moves it, snapped, points untouched', () => {
    const doc = drawn()
    const { contract } = stub(doc, { sketchMode: 'edit' })
    const sketch = onlySketch(doc)
    if (!sketch) throw new Error('no sketch')
    const cap = (x: number, z: number, plane?: { x: number; z: number }) => ({
      pick: { surface: { structure: sketch.id, kind: 3 as const, x: 0, y: 0, dir: 0, level: 0 }, point: { x, z }, plane },
      modifiers: { shift: false, alt: false, ctrl: false },
    })
    const handler = contract.stroke(cap(5, 5))
    handler?.begin(cap(5, 5))
    applyPatches(doc, [...(handler?.move(cap(0, 0, { x: 7.4, z: 6.6 })) ?? [])])
    const moved = onlySketch(doc)
    expect(moved?.placement).toEqual({ x: 2, z: 2, yaw: 0 })
    expect(moved?.points).toEqual(sketch.points)
    // The height under a point that was inside the outline follows the move.
    expect(frameOf(doc, sketch.id)).toMatchObject({ x: 2, z: 2 })
  })

  it('reports a closed sketch\'s points at its cap height, an open one\'s at its base', () => {
    const doc = drawn()
    const sketch = onlySketch(doc)
    if (!sketch) throw new Error('no sketch')
    // Ground is 2 half-tiles high; the default sketch is 3 layers.
    expect(frameOf(doc, sketch.id).y).toBeCloseTo(1)
    expect(sketchPointHeight(doc, sketch)).toBeCloseTo(1 + 1.5)
  })
})
