import { describe, expect, it } from 'vitest'

import { snapTo } from './snap'

describe('snapTo', () => {
  it('puts a corner-anchored value on the grid line and a centre-anchored one in the middle of the cell', () => {
    expect(snapTo(2.4, 'grid')).toBe(2)
    expect(snapTo(2.6, 'grid')).toBe(3)
    expect(snapTo(2.4, 'grid', 'centre')).toBe(2.5)
    expect(snapTo(2.99, 'grid', 'centre')).toBe(2.5)
    expect(snapTo(-0.2, 'grid', 'centre')).toBe(-0.5)
  })

  it('half cells and free are the same lattice for both anchors', () => {
    expect(snapTo(2.3, 'half')).toBe(2.5)
    expect(snapTo(2.3, 'half', 'centre')).toBe(2.5)
    expect(snapTo(2.337, 'free')).toBe(2.34)
    expect(snapTo(2.337, 'free', 'centre')).toBe(2.34)
  })
})
