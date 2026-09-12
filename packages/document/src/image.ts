/**
 * Raw pixels, the type that crosses the texture boundary (#32, #47).
 *
 * Everything that draws — the placeholder generator in `fixtures`, the
 * artist's sheet loader in the editor — hands its result over as this, and
 * everything that uploads or encodes — the runtime's textures, glTF export —
 * takes exactly this. Nothing in between names a canvas, which is what lets
 * `runtime` compile without `DOM` in its `lib` and lets a headless caller
 * supply pixels from wherever it got them.
 *
 * It lives in `document` because it is data, not rendering: the same reason
 * `MapObject.sprite` is a name here and nothing more. `Uint8ClampedArray` is
 * the one concession to the browser — it is what `getImageData` produces and
 * what a PNG decoder can fill — and it is an ECMAScript type, not a DOM one.
 * The `ArrayBuffer` parameter says the view is over a plain buffer, never a
 * `SharedArrayBuffer`: that is what `ImageData` insists on for the trip back
 * into a canvas, and it is what every producer here has anyway.
 */

export interface RgbaImage {
  width: number
  height: number
  /** Row-major, top row first, four bytes per pixel, `width * height * 4` long. */
  data: Uint8ClampedArray<ArrayBuffer>
}

/**
 * One placeholder or artist-supplied sprite: its facings as images plus the
 * footprint the runtime sizes the quad from. Produced by `fixtures`, consumed
 * by `runtime`; neither may import the other, so the shape is named here.
 */
export interface SpriteAsset {
  name: string
  /** One image per facing. Index 0 faces the camera at the default yaw. */
  facings: RgbaImage[]
  /** Footprint in tiles, used to size the quad. */
  widthTiles: number
  heightTiles: number
  /** Windows and lamps glow at night. */
  emissive: boolean
}
