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
// back on its own.
const GPU_ARGS = ['--use-angle=default']

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

/**
 * Launch args for `chromium.launch`. `extraSoftwareArgs` covers a flag one
 * script needs only in its software path (screenshot.mjs's
 * --ignore-gpu-blocklist); real GPU mode drops the software stack entirely,
 * so it never applies there.
 */
export function chromiumArgs(gpu, extraSoftwareArgs = []) {
  return gpu ? GPU_ARGS : [...SOFTWARE_ARGS, ...extraSoftwareArgs]
}
