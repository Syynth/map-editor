/**
 * Mean luminance measurement, shared by scripts/probe.mjs (manual GPU
 * diagnosis) and scripts/tour.mjs (CI's automated black-frame guard). One
 * implementation instead of two: the whole point of a floor check is that it
 * measures the same thing probe.mjs already measured by hand when it found
 * the bloom-renders-black bug (see FINDINGS.md), so tour.mjs's assertion has
 * to be provably the same computation, not a lookalike that drifts.
 *
 * A screenshot round-trip rather than a WebGL readback: both scripts already
 * have a Playwright `page`, not a live reference to the GL context, and
 * decoding a PNG through a 2D canvas sidesteps `preserveDrawingBuffer` and
 * tainted-canvas restrictions a direct `readPixels` would have to fight.
 */
export async function meanLuminance(page, clip) {
  const shot = await page.screenshot({ clip })
  return page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable for the luminance measurement')
    ctx.drawImage(bitmap, 0, 0)
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let sum = 0
    for (let i = 0; i < pixels.length; i += 4) {
      sum += (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3
    }
    return sum / (pixels.length / 4)
  }, [...shot])
}
