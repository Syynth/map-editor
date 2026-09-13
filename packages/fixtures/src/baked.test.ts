import { describe, expect, it } from 'vitest'

import { BLOCK_COLUMNS, BLOCK_ROWS } from '@papercut/geometry'
import manifest from '../baked/manifest.json'
import { createSampleMap } from './sample'
import { spriteFootprints } from './textures'

/**
 * The checked-in bake under `../baked/` has to describe the sample map and the
 * sprite library as they are NOW, or a headless consumer loads yesterday's
 * art against today's layout. Nothing here can redraw the pixels (that takes
 * a canvas — see `scripts/bake-fixtures.mjs`), so the check is everything
 * that determines them short of the painting itself: the density, the
 * materials, the sheet's layout-derived size, and each sprite's footprint and
 * facing count. Change any of those and this fails until `pnpm bake` is
 * re-run. `tests/baked-fixtures.test.ts` covers the files themselves.
 */
describe('the checked-in bake', () => {
  const doc = createSampleMap()

  it('was baked from the sample map as it is now', () => {
    expect(manifest.texelDensity).toBe(doc.texelDensity)
    expect(manifest.materials).toEqual(doc.materials.map(({ name, color }) => ({ name, color })))
    expect(manifest.sheet).toEqual({
      file: 'sheet.png',
      width: doc.materials.length * BLOCK_COLUMNS * doc.texelDensity,
      height: BLOCK_ROWS * doc.texelDensity,
    })
  })

  it('carries every sprite the library defines, at its current footprint', () => {
    // Frame size follows `sprite()` in textures.ts: tiles times density, rounded.
    const expected = Object.fromEntries(
      spriteFootprints().map((sprite) => [
        sprite.name,
        {
          widthTiles: sprite.widthTiles,
          heightTiles: sprite.heightTiles,
          emissive: sprite.emissive,
          frame: {
            width: Math.round(sprite.widthTiles * doc.texelDensity),
            height: Math.round(sprite.heightTiles * doc.texelDensity),
          },
          facings: Array.from({ length: sprite.facings }, (_, index) => `sprites/${sprite.name}.${index}.png`),
        },
      ]),
    )
    expect(manifest.sprites).toEqual(expected)
  })
})
