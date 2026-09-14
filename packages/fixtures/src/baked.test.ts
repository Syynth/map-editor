import { describe, expect, it } from 'vitest'

import manifest from '../baked/manifest.json'
import { createSampleProject } from './sample'
import { spriteFootprints } from './textures'

/**
 * The checked-in bake under `../baked/` has to describe the sample map and the
 * sprite library as they are NOW, or a headless consumer loads yesterday's
 * art against today's layout. Nothing here can redraw the pixels (that takes
 * a canvas — see `scripts/bake-fixtures.mjs`), so the check is everything
 * that determines them short of the painting itself: the density, the
 * materials, and each sprite's footprint and
 * facing count. Change any of those and this fails until `pnpm bake` is
 * re-run. `tests/baked-fixtures.test.ts` covers the files themselves.
 */
describe('the checked-in bake', () => {
  const project = createSampleProject()
  const density = project.resolution.texelDensity

  it('was baked from the sample project as it is now', () => {
    expect(manifest.texelDensity).toBe(density)
    expect(manifest.materials).toEqual(project.materials.map(({ name, color }) => ({ name, color })))
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
            width: Math.round(sprite.widthTiles * density),
            height: Math.round(sprite.heightTiles * density),
          },
          facings: Array.from({ length: sprite.facings }, (_, index) => `sprites/${sprite.name}.${index}.png`),
        },
      ]),
    )
    expect(manifest.sprites).toEqual(expected)
  })
})
