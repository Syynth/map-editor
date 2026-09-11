/** Chunking. Only dirty chunks get remeshed while the artist brushes. */

export const CHUNK_SIZE = 16

export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`
}

export function parseChunkKey(key: string): { cx: number; cy: number } {
  const [cx, cy] = key.split(',').map(Number)
  return { cx, cy }
}

export interface ChunkBounds {
  cx: number
  cy: number
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Cell range covered by a chunk, clipped to the map. Empty if off-map. */
export function chunkBounds(
  key: string,
  width: number,
  height: number,
): ChunkBounds | null {
  const { cx, cy } = parseChunkKey(key)
  const x0 = cx * CHUNK_SIZE
  const y0 = cy * CHUNK_SIZE
  if (x0 >= width || y0 >= height || x0 < 0 || y0 < 0) return null
  return {
    cx,
    cy,
    x0,
    y0,
    x1: Math.min(x0 + CHUNK_SIZE, width),
    y1: Math.min(y0 + CHUNK_SIZE, height),
  }
}

export function allChunkKeys(width: number, height: number): string[] {
  const keys: string[] = []
  for (let cy = 0; cy < Math.ceil(height / CHUNK_SIZE); cy++) {
    for (let cx = 0; cx < Math.ceil(width / CHUNK_SIZE); cx++) {
      keys.push(chunkKey(cx, cy))
    }
  }
  return keys
}
