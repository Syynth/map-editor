/**
 * The command line: `map-export <input.json> <output.glb> [--merge]`.
 *
 * Argument handling by hand, and it stays that way until there is a flag that
 * needs more: a parser library here would be the app's only runtime dependency
 * that is not the thing it exists to wrap.
 *
 * The `#!` line is added by the build (see `vite.config.ts`), because the
 * shipped entry point is the bundle, not this file.
 */

import { exportMapFile } from './export-map'

const USAGE = `usage: map-export <input.json> <output.glb> [--merge]

  --merge   merge static terrain geometry per chunk: fewer draw calls, and the
            per-chunk nodes stop being addressable in the exported file.
`

async function main(argv: string[]): Promise<number> {
  const paths: string[] = []
  let merge = false

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE)
      return 0
    } else if (arg === '--merge') {
      merge = true
    } else if (arg.startsWith('-')) {
      process.stderr.write(`map-export: unknown option ${arg}\n${USAGE}`)
      return 1
    } else {
      paths.push(arg)
    }
  }

  if (paths.length !== 2) {
    process.stderr.write(USAGE)
    return 1
  }

  const [inputPath, outputPath] = paths
  try {
    const result = await exportMapFile(inputPath, outputPath, { merge })
    process.stdout.write(`${outputPath}: ${result.bytes} bytes from "${result.name}"\n`)
    return 0
  } catch (error) {
    // A bad path or a map this build cannot load is a user error, not a crash
    // to read a stack trace out of.
    process.stderr.write(`map-export: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

process.exitCode = await main(process.argv.slice(2))
