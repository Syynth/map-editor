/**
 * The pure-JS half of `ExportOptions.encodePng` (`@map-editor/runtime/export`).
 *
 * The editor's own encoder wraps a canvas's `toBlob`; this one wraps
 * `fast-png`'s `encode`, whose only dependencies are `fflate` and `iobuffer`
 * — neither native, per the 2026-09-11 no-native-binaries ruling that cut
 * this app in the first place. `encode` is synchronous; `PngEncoder` is typed
 * `Promise<Uint8Array>` because the canvas-backed encoder genuinely is async,
 * so this one wraps its result in `Promise.resolve` to satisfy the one shape
 * both callers share.
 */

import { encode } from 'fast-png'

import type { RgbaImage } from '@map-editor/document'
import type { ExportOptions } from '@map-editor/runtime/export'

// `PngEncoder` itself lives in runtime's `./images`, a module not on
// `@map-editor/runtime`'s `exports` map (only `.` and `./export` are, per
// `tests/dependency-direction.test.ts`'s wildcard check) — indexing off
// `ExportOptions`, which IS exported, gets the same type without reaching
// past the boundary.
export const encodePngPure: ExportOptions['encodePng'] = (image: RgbaImage) =>
  Promise.resolve(encode({ width: image.width, height: image.height, data: image.data, channels: 4 }))
