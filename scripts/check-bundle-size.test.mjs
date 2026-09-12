import { describe, expect, it } from 'vitest'

import { DEFAULT_LIMIT_BYTES, oversizedChunks } from './check-bundle-size.mjs'

// The exact regression this exists for (#57): a chunk regrows past 500 kB and
// nothing in the gate goes red. This exercises the pure decision function
// directly rather than a real `vite build`, so it stays fast and does not
// need a checked-in oversized fixture bundle.
describe('oversizedChunks', () => {
  it('flags a chunk over the 500 kB ceiling', () => {
    const sizes = [{ file: 'vendor-three-abcd1234.js', bytes: 600_000 }]

    expect(oversizedChunks(sizes)).toEqual(sizes)
  })

  it('passes chunks at or under the ceiling', () => {
    const sizes = [{ file: 'index-abcd1234.js', bytes: DEFAULT_LIMIT_BYTES }]

    expect(oversizedChunks(sizes)).toEqual([])
  })

  it('reports only the offenders out of a mixed build', () => {
    const small = { file: 'index-abcd1234.js', bytes: 89_000 }
    const big = { file: 'vendor-three-abcd1234.js', bytes: 700_000 }

    expect(oversizedChunks([small, big])).toEqual([big])
  })
})
