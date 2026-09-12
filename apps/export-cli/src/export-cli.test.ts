/**
 * The headless claim, as a test.
 *
 * This is the only test in the repo that runs the glTF exporter through the
 * REAL `GLTFExporter` (`packages/runtime/src/export.test.ts` mocks it out —
 * see the comment there), and it exists because the app's whole reason to be
 * is a property nothing else checks: a `.glb` comes out under plain Node,
 * with no browser and no WebGL context. Vitest's default environment is
 * `node`, so the DOM this asserts against is genuinely absent rather than a
 * jsdom stand-in.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { serialize } from '@map-editor/document'
import { createSampleMap } from '@map-editor/fixtures'

import { exportMapFile } from './index'

async function exportSampleMap(): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'map-editor-export-'))
  const inputPath = join(dir, 'sample.json')
  const outputPath = join(dir, 'sample.glb')
  // Through a real file, not a document handed over in memory: reading the
  // same serialised form the editor writes is half of what the CLI does.
  await writeFile(inputPath, serialize(createSampleMap()))

  const result = await exportMapFile(inputPath, outputPath, { merge: false })
  const glb = await readFile(outputPath)
  expect(glb.byteLength).toBe(result.bytes)
  return glb
}

it('writes a binary glTF for the sample map with no WebGL context', async () => {
  const glb = await exportSampleMap()

  // The glb header: magic, container version, and a total length that has to
  // agree with the file, which is what makes "non-empty" mean "complete".
  expect(glb.subarray(0, 4).toString('latin1')).toBe('glTF')
  expect(glb.readUInt32LE(4)).toBe(2)
  expect(glb.readUInt32LE(8)).toBe(glb.byteLength)

  // Nothing along the way reached for a renderer. `installNodeFileReader`
  // installs exactly one global and this is not it.
  expect('WebGLRenderingContext' in globalThis).toBe(false)
  expect('document' in globalThis).toBe(false)
})

it('embeds its textures as real PNGs, decoded from the checked-in bake', async () => {
  const glb = await exportSampleMap()

  const jsonLength = glb.readUInt32LE(12)
  const json: unknown = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'))
  const { images, bufferViews } = json as {
    images: { bufferView: number; mimeType: string }[]
    bufferViews: { byteOffset: number; byteLength: number }[]
  }
  const binOffset = 20 + jsonLength + 8
  const bin = glb.subarray(binOffset, binOffset + glb.readUInt32LE(20 + jsonLength))

  expect(images.length).toBeGreaterThan(0)
  for (const image of images) {
    expect(image.mimeType).toBe('image/png')
    const view = bufferViews[image.bufferView]
    const png = bin.subarray(view.byteOffset, view.byteOffset + view.byteLength)
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
    // A PNG header carries its dimensions at a fixed offset; a zero-sized one
    // would still have a valid signature.
    expect(png.readUInt32BE(16)).toBeGreaterThan(0)
    expect(png.readUInt32BE(20)).toBeGreaterThan(0)
  }
})

it('rejects a map its own loader cannot read, without writing a partial file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'map-editor-export-'))
  const inputPath = join(dir, 'bad.json')
  const outputPath = join(dir, 'bad.glb')
  await writeFile(inputPath, '{ "not": "a map" }')

  await expect(exportMapFile(inputPath, outputPath, { merge: false })).rejects.toThrow()
  await expect(readFile(outputPath)).rejects.toThrow()
})
