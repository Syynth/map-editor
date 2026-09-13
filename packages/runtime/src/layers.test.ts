import { describe, expect, it } from 'vitest'

import { withinLayers } from './layers'

describe('the layer view', () => {
  it('places an object by its base height', () => {
    expect(withinLayers(null, 99, 0.5)).toBe(true)
    expect(withinLayers({ lo: 2, hi: 6 }, 3 * 0.5, 0.5)).toBe(true)
    expect(withinLayers({ lo: 2, hi: 6 }, 7 * 0.5, 0.5)).toBe(false)
    expect(withinLayers({ lo: 2, hi: 6 }, 1 * 0.5, 0.5)).toBe(false)
  })
})
