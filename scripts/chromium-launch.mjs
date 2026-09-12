/**
 * Chromium launch policy shared by tour.mjs, probe.mjs and screenshot.mjs.
 *
 * All three want the same answer to "software renderer or a real GPU?", and
 * duplicating the flag parsing three times is how one of them quietly drifts
 * from the others (--gpu honoured here, silently ignored there). One place
 * instead — see issue #26.
 */

const SOFTWARE_ARGS = ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']

// Headless Chromium does not default to the platform's real GPU backend —
// measured on macOS, where `chromium.launch()` with no args at all still
// resolves ANGLE to SwiftShader. `--use-angle=default` tells ANGLE to pick
// its normal hardware backend (Metal here, GL/Vulkan on Linux) the way a
// headed browser already does, instead of leaving headless mode to fall
// back on its own. --ignore-gpu-blocklist belongs here, not on the software
// side: the blocklist gates hardware GPU use, and SwiftShader is what fires
// when it does — under SOFTWARE_ARGS the flag is a no-op, but here it is
// what stops a blocklisted Linux headless/container GPU from silently
// landing back on SwiftShader anyway.
const GPU_ARGS = ['--use-angle=default', '--ignore-gpu-blocklist']

/**
 * SwiftShader is the default because it is the only renderer CI and every
 * contributor's machine are guaranteed to have. --gpu (or TOUR_GPU=1) opts
 * into whatever driver is actually installed, which is the only way to see
 * post-processing run for real rather than through the software fallback
 * these scripts otherwise force.
 */
export function wantsGpu(argv = process.argv.slice(2)) {
  return argv.includes('--gpu') || process.env.TOUR_GPU === '1'
}

/** Positional args with --gpu removed, so it can never be misread as an output dir. */
export function stripGpuFlag(argv = process.argv.slice(2)) {
  return argv.filter((arg) => arg !== '--gpu')
}

/** Launch args for `chromium.launch`. */
export function chromiumArgs(gpu) {
  return gpu ? GPU_ARGS : SOFTWARE_ARGS
}
