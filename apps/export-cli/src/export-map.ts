/**
 * Map file in, `.glb` out.
 *
 * This is the whole app: it owns no export logic of its own and deliberately
 * cannot acquire any. Everything that decides what lands in the file lives
 * behind `@map-editor/runtime/export`, so what the CLI writes and what the
 * editor's export button writes are the same bytes — which is the property
 * that makes a headless export worth having.
 */

import { readFile, writeFile } from 'node:fs/promises'

import { deserialize } from '@map-editor/document'
import { exportGltf } from '@map-editor/runtime/export'

import { loadBakedAssets } from './baked-assets'
import { encodePngPure } from './encode-png'
import { installNodeFileReader } from './node-file-reader'

export interface ExportMapOptions {
  /** Merge static geometry per chunk for fewer draw calls, losing identity. */
  merge: boolean
}

export interface ExportMapResult {
  /** The document's own name, so a caller can report what it exported. */
  name: string
  bytes: number
}

export async function exportMapFile(
  inputPath: string,
  outputPath: string,
  options: ExportMapOptions,
): Promise<ExportMapResult> {
  installNodeFileReader()

  // `deserialize` is the same loader the editor uses, migrations and all, so a
  // map the editor can open is a map the CLI can export — and one it cannot is
  // rejected here with `LoadError` rather than half-exported.
  const doc = deserialize(await readFile(inputPath, 'utf8'))

  // The pre-baked stand-in for `generateTerrainSheet` / `generateSprites`:
  // this app has no canvas to draw them live with, which is the whole point
  // (#48). A future flag for an artist's own sheet would decode it through
  // the same `fast-png`, into the same `RgbaImage` shape, right here.
  const { sheet, sprites } = await loadBakedAssets()

  const bytes = new Uint8Array(await exportGltf(doc, { merge: options.merge, sheet, sprites, textures: {}, encodePng: encodePngPure }))
  await writeFile(outputPath, bytes)

  return { name: doc.name, bytes: bytes.byteLength }
}
