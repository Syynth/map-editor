/**
 * The CLI's halves of `@papercut/project`'s seams: Node's filesystem as a
 * `ProjectFs`, `fast-png` as the image codec, and the walk-up from a map
 * file to the project folder that governs it.
 *
 * A map is exported under its project (rulings of 2026-09-14): the nearest
 * `papercut.json` above it says what its materials are and which sheets they
 * draw from. A map with no project above it — a fixture written to a temp
 * folder, say — exports under the default project, which is what every map
 * made before there were projects paints with.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { PROJECT_FILE, type RgbaImage } from '@papercut/document'
import type { ImageCodec, ProjectFs } from '@papercut/project'
import { decode, encode } from 'fast-png'

export const nodeFs: ProjectFs = {
  readFile: async (path) => new Uint8Array(await readFile(path)),
  readTextFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, data) => writeFile(path, data),
  readDir: async (path) => (await readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name, kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'other' })),
  exists: async (path) => {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  },
  mkdir: async (path, options) => {
    await mkdir(path, options)
  },
}

/** `fast-png` both ways; a PNG that is not 8-bit RGBA — grey, RGB, or a palette with RGBA entries, which is what RPG Maker's sheets are — is widened to it, since the atlas wants exactly that. */
export const fastPngCodec: ImageCodec = {
  encode: (image: RgbaImage) => Promise.resolve(encode({ width: image.width, height: image.height, data: image.data, channels: 4 })),
  decode: (bytes) => {
    const png = decode(bytes)
    if (png.depth !== 8) return Promise.reject(new Error(`a ${png.depth}-bit PNG; sheets are 8-bit`))
    const pixels = png.width * png.height
    const data = new Uint8ClampedArray(pixels * 4)
    const source = png.data
    if (png.palette) {
      for (let i = 0; i < pixels; i++) {
        const entry = png.palette[source[i]] ?? [0, 0, 0, 0]
        data[i * 4] = entry[0]
        data[i * 4 + 1] = entry[1]
        data[i * 4 + 2] = entry[2]
        data[i * 4 + 3] = entry[3] ?? (png.transparency && source[i] < png.transparency.length ? png.transparency[source[i]] : 255)
      }
    } else if (png.channels === 4) data.set(source)
    else {
      for (let i = 0; i < pixels; i++) {
        const base = i * png.channels
        const grey = png.channels < 3
        data[i * 4] = source[base]
        data[i * 4 + 1] = grey ? source[base] : source[base + 1]
        data[i * 4 + 2] = grey ? source[base] : source[base + 2]
        data[i * 4 + 3] = png.channels === 2 ? source[base + 1] : 255
      }
    }
    return Promise.resolve({ width: png.width, height: png.height, data })
  },
}

/** The folder of the nearest `papercut.json` at or above `mapPath`'s folder, or `null` when none governs it. */
export async function findProjectFolder(mapPath: string): Promise<string | null> {
  let folder = dirname(resolve(mapPath))
  for (;;) {
    if (await nodeFs.exists(join(folder, PROJECT_FILE))) return folder
    const parent = dirname(folder)
    if (parent === folder) return null
    folder = parent
  }
}
