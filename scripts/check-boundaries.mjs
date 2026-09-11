#!/usr/bin/env node
/**
 * Enforces the layer import direction:  core <- runtime <- editor
 *
 * - src/core    may not import from runtime or editor, and may not import three or react.
 * - src/runtime may not import from editor, and may not import react.
 * - src/editor  may import anything.
 *
 * This is the cheap version of splitting into workspace packages. When the
 * headless exporter CLI needs to import core on its own, promote these folders
 * to real packages and delete this script.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')

/** @type {Record<string, {layers: string[], packages: string[]}>} */
const FORBIDDEN = {
  core: { layers: ['runtime', 'editor'], packages: ['three', 'react', 'react-dom'] },
  runtime: { layers: ['editor'], packages: ['react', 'react-dom'] },
  editor: { layers: [], packages: [] },
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

function layerOf(file) {
  const rel = relative(SRC, file)
  return rel.split('/')[0]
}

function specifiers(source) {
  const found = []
  for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(source)) !== null) found.push(m[1])
  }
  return found
}

const violations = []

for (const file of walk(SRC)) {
  const layer = layerOf(file)
  const rules = FORBIDDEN[layer]
  if (!rules) continue
  const source = readFileSync(file, 'utf8')

  for (const spec of specifiers(source)) {
    // Cross-layer imports, written either as an alias or a relative climb.
    for (const bad of rules.layers) {
      if (spec.startsWith(`@${bad}/`) || spec.includes(`/${bad}/`) || spec.startsWith(`${bad}/`)) {
        violations.push(`${relative(ROOT, file)}: ${layer} may not import ${bad} ("${spec}")`)
      }
    }
    // Package bans. Match the package root or a subpath, never a prefix collision.
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (rules.packages.includes(pkg)) {
      violations.push(`${relative(ROOT, file)}: ${layer} may not import "${pkg}"`)
    }
  }
}

if (violations.length > 0) {
  console.error('Layer boundary violations:\n')
  for (const v of violations) console.error('  ' + v)
  console.error(`\n${violations.length} violation(s). core <- runtime <- editor, never backwards.`)
  process.exit(1)
}

console.log('Layer boundaries OK (core <- runtime <- editor)')
