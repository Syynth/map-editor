/**
 * The one DOM constructor three's own glTF writer reaches for that Node has
 * no global for.
 *
 * `GLTFWriter.writeAsync` (three 0.186.0, `GLTFExporter.js`) merges its
 * buffers into a `Blob` and reads the bytes back out through
 * `FileReader.readAsArrayBuffer`, twice, on the `binary: true` path
 * `exportGltf` (`@map-editor/runtime/export`) always takes — lines 679 and
 * 697 for the merged buffer, 723 and 731 for the finished `.glb`. `Blob`
 * itself Node has had as a global since v18; `FileReader` it does not, and
 * never will — it is a browser progress-event wrapper around exactly the
 * `arrayBuffer()` method `Blob` already exposes.
 *
 * This is NOT the shim the 2026-09-11 "no native binary dependencies for
 * tooling" ruling (docs/decision-log.md) argues against re-adding. That
 * ruling is about the 2D canvas #47 removed from the texture path — code
 * that draws pixels and therefore needs a real implementation to draw them
 * correctly. Nothing here draws anything or interprets a byte: it is a
 * synchronous `Blob.arrayBuffer()` call reshaped into the two-property,
 * callback-shaped object three's writer expects, over a `Blob` Node already
 * implements correctly. `readAsDataURL` — the other `FileReader` method
 * `GLTFExporter.js` can call, on its non-binary path — is deliberately not
 * implemented: `exportGltf` never asks for anything but `binary: true`, so a
 * three upgrade that started relying on it should throw here, loudly,
 * rather than silently succeed against a guess at what a data URL is for.
 */
export class NodeFileReader {
  result: ArrayBuffer | null = null
  onloadend: (() => void) | null = null

  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      this.result = buffer
      this.onloadend?.()
    })
  }
}

let installed = false

/**
 * Idempotent, and called from the export entry point rather than at import
 * time, matching every other globalThis mutation this repo has made for the
 * same reason (see the pre-#47 `installHeadlessDom`, which this replaces): a
 * side effect on `globalThis` should be visible in a stack trace that starts
 * from the call that caused it, not from whichever module happened to import
 * this one first.
 */
export function installNodeFileReader(): void {
  if (installed) return
  installed = true
  Object.assign(globalThis, { FileReader: NodeFileReader })
}
