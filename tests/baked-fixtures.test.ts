import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `packages/fixtures/baked/` is a checked-in render of the sample map's
 * placeholder art (#47), produced by `pnpm bake` in a headless browser because
 * the generator draws with a canvas and Node has none. Nothing can redraw it
 * here to compare pixels, so this checks the half that can be checked without
 * a canvas: that the PNG files and `manifest.json` agree with each other.
 * `packages/fixtures/src/baked.test.ts` checks the other half — that the
 * manifest agrees with the sample map and sprite library as they are now.
 *
 * Repo-wide rather than in `fixtures` because reading the files needs
 * `node:fs`, and `fixtures` compiles with no Node types on purpose.
 */

const ROOT = new URL('..', import.meta.url).pathname
const BAKED = join(ROOT, 'packages/fixtures/baked')

interface Manifest {
  sheet: { file: string; width: number; height: number }
  sprites: Record<string, { frame: { width: number; height: number }; facings: string[] }>
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Width and height from the IHDR chunk, which the PNG spec fixes as the first chunk after the signature. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE)
  expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function referenced(manifest: Manifest): Array<{ file: string; width: number; height: number }> {
  return [
    manifest.sheet,
    ...Object.values(manifest.sprites).flatMap((sprite) =>
      sprite.facings.map((file) => ({ file, ...sprite.frame })),
    ),
  ]
}

describe('packages/fixtures/baked', () => {
  const manifest = JSON.parse(readFileSync(join(BAKED, 'manifest.json'), 'utf8')) as Manifest

  it('has every PNG the manifest names, at the size it says', () => {
    const wrong = referenced(manifest).flatMap(({ file, width, height }) => {
      const path = join(BAKED, file)
      if (!existsSync(path)) return [`${file}: missing — run \`pnpm bake\``]
      const size = pngSize(readFileSync(path))
      return size.width === width && size.height === height
        ? []
        : [`${file}: is ${size.width}x${size.height}, manifest says ${width}x${height}`]
    })
    expect(wrong).toEqual([])
  })

  it('has no PNG the manifest does not name', () => {
    // A sprite that leaves the library must take its files with it, or a
    // consumer reading the directory gets art the manifest cannot describe.
    const named = new Set(referenced(manifest).map(({ file }) => file))
    const onDisk = readdirSync(BAKED, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
      .map((entry) => relative(BAKED, join(entry.parentPath, entry.name)))
    expect(onDisk.filter((file) => !named.has(file))).toEqual([])
  })
})
