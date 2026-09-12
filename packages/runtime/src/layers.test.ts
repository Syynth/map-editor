import { NO_WATER, cellIndex, createMap, tintKey } from '@map-editor/document'
import { describe, expect, it } from 'vitest'

import { CUT_TINT, GHOST_TINT, layerView, withinLayers } from './layers'

describe('the layer view', () => {
  it('is the document itself with no range', () => {
    const doc = createMap(4, 4)
    expect(layerView(doc, null)).toBe(doc)
  })

  it('clamps columns to the ceiling and tints their caps; tints columns under the floor; drops water over the ceiling', () => {
    const doc = createMap(4, 4)
    const at = (x: number, y: number) => cellIndex(doc.size, x, y)
    doc.terrain.height[at(0, 0)] = 9 // above the ceiling: cut
    doc.terrain.height[at(1, 0)] = 5 // inside
    doc.terrain.height[at(2, 0)] = 1 // under the floor: ghosted
    doc.terrain.water[at(3, 0)] = 8 // water over the ceiling
    doc.terrain.water[at(1, 0)] = 6 // water inside

    const view = layerView(doc, { lo: 2, hi: 6 })
    expect(view).not.toBe(doc)
    expect(view.terrain.height[at(0, 0)]).toBe(6)
    expect(view.paint.tint[tintKey(0, 0)]).toBe(CUT_TINT)
    expect(view.terrain.height[at(1, 0)]).toBe(5)
    expect(view.paint.tint[tintKey(1, 0)]).toBeUndefined()
    expect(view.terrain.height[at(2, 0)]).toBe(1)
    expect(view.paint.tint[tintKey(2, 0)]).toBe(GHOST_TINT)
    expect(view.terrain.water[at(3, 0)]).toBe(NO_WATER)
    expect(view.terrain.water[at(1, 0)]).toBe(6)
    // The document itself is untouched.
    expect(doc.terrain.height[at(0, 0)]).toBe(9)
    expect(doc.paint.tint[tintKey(0, 0)]).toBeUndefined()
  })

  it('places an object by its base height', () => {
    expect(withinLayers(null, 99, 0.5)).toBe(true)
    expect(withinLayers({ lo: 2, hi: 6 }, 3 * 0.5, 0.5)).toBe(true)
    expect(withinLayers({ lo: 2, hi: 6 }, 7 * 0.5, 0.5)).toBe(false)
    expect(withinLayers({ lo: 2, hi: 6 }, 1 * 0.5, 0.5)).toBe(false)
  })
})
