/**
 * The DOM surface glTF export still asks for, supplied by Node.
 *
 * WHY this file exists at all. Issue #3 measured that nothing in
 * `@map-editor/runtime` creates a WebGL context, and this app is the forcing
 * function for that claim: it exports a `.glb` under plain `node`, with no
 * browser and no renderer. What #3 also measured is the obstacle that remains
 * — a *2D* canvas. `textures.ts` draws the placeholder sheet and sprites into
 * one, `export.ts`'s `atlasFor` packs facings with one, and `GLTFExporter`
 * encodes every texture through one more. Removing that need is a reshape
 * (raw RGBA crossing the boundary instead of a canvas), which #3 parks with
 * the texture-generation move into `packages/fixtures`. So this app supplies
 * the surface rather than changing the packages it wraps.
 *
 * Exactly three globals, because exactly three are reached for. Anything the
 * exporter asks for beyond them should fail loudly here rather than be
 * stubbed: a silent stub would let the CLI ship a `.glb` that is missing
 * whatever the stub swallowed.
 */

import { Canvas, createCanvas } from '@napi-rs/canvas'

/**
 * `GLTFExporter` reads its encoded PNG back through `FileReader`, which Node
 * has no global for (it has `Blob`, and the blob a canvas hands back already
 * exposes `arrayBuffer()`). The exporter only ever uses these two members.
 */
class HeadlessFileReader {
  result: ArrayBuffer | null = null
  onloadend: (() => void) | null = null

  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      this.result = buffer
      this.onloadend?.()
    })
  }
}

const headlessDocument = {
  createElement(tag: string): Canvas {
    if (tag !== 'canvas') {
      throw new Error(`export-cli: headless DOM has no <${tag}>, only <canvas>`)
    }
    // Both callers set width and height straight after; 1x1 is the same
    // starting size a real `document.createElement('canvas')` gives.
    const canvas = createCanvas(1, 1)

    // A name collision, not a hack. `GLTFExporter.processImage` duck-types a
    // `DataTexture` as `image.data !== undefined` and, when it matches, reads
    // `image.data` as raw RGBA bytes instead of drawing the canvas.
    // `@napi-rs/canvas` happens to put a `data()` method on `Canvas` (its own
    // raw-pixel accessor), so every canvas here matches that test and every
    // texture would be encoded down the wrong branch. Shadowing the inherited
    // method with `undefined` is what makes a canvas look like a canvas.
    // Without it the failure is loud today (`ImageData is not defined`), but
    // it is loud only by accident — supply that one global and the exporter
    // silently writes garbage.
    Object.defineProperty(canvas, 'data', { value: undefined })

    return canvas
  },
}

let installed = false

/**
 * Idempotent, and called from the export entry point rather than at import
 * time: a library that mutates `globalThis` when it is merely imported is a
 * library whose side effect no caller can see in a stack trace.
 */
export function installHeadlessDom(): void {
  if (installed) return
  installed = true

  // `Object.assign` rather than assignment per key: under the DOM lib these
  // names are already declared with browser types, and this is a deliberate
  // substitution of a Node-backed implementation, not a claim to be one.
  Object.assign(globalThis, {
    document: headlessDocument,
    // `GLTFExporter` gates its image path on `image instanceof
    // HTMLCanvasElement` and throws "Invalid image type" otherwise, so the
    // name has to resolve to the class the canvases above are instances of.
    HTMLCanvasElement: Canvas,
    FileReader: HeadlessFileReader,
  })
}
