/**
 * The export CLI's public surface.
 *
 * An app rather than a package, but it exports the one function `cli.ts` wraps
 * so that a caller — today, its own test — can drive an export without going
 * through `process.argv`. Written out rather than `export *`, matching the
 * packages.
 */

export { exportMapFile } from './export-map'
export type { ExportMapOptions, ExportMapResult } from './export-map'
