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

import { installHeadlessDom } from './headless-dom'

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
  installHeadlessDom()

  // `deserialize` is the same loader the editor uses, migrations and all, so a
  // map the editor can open is a map the CLI can export — and one it cannot is
  // rejected here with `LoadError` rather than half-exported.
  const doc = deserialize(await readFile(inputPath, 'utf8'))

  const blob = await exportGltf(doc, { merge: options.merge })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  await writeFile(outputPath, bytes)

  return { name: doc.name, bytes: bytes.byteLength }
}
