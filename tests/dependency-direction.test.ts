import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The dependency direction is a decision (#3), and pnpm does not enforce it.
 *
 * pnpm's strict `node_modules` stops a package importing something it has not
 * DECLARED, which is real and free. It says nothing about a declaration that
 * points the wrong way: adding `"@map-editor/runtime": "workspace:*"` to
 * `packages/document/package.json` resolves cleanly and inverts the graph with
 * no error anywhere. #20 recorded that correction to #3 and asked for a test;
 * this is it. It replaces `scripts/check-boundaries.mjs`, which matched import
 * specifiers with a regex against a `src/{core,runtime,editor}` tree that no
 * longer exists — so it inspected zero files and passed unconditionally.
 *
 * The table below is the SPEC rather than a snapshot: it carries the rungs #3
 * decided for packages nobody has written yet, marked `planned`. Three
 * properties keep it from decaying into an allowlist that admits anything:
 *
 *   - a workspace package with no entry FAILS, so a new package cannot be
 *     silently unchecked — whoever adds it has to place it on the ladder;
 *   - a `planned` entry that now exists on disk FAILS, so a rung assigned
 *     before the package was written has to be confirmed against what it
 *     actually imports;
 *   - a non-`planned` entry missing from disk FAILS, so a renamed or deleted
 *     package cannot leave a stale rule behind.
 */

type Placement =
  | { kind: 'layer'; rank: number; planned?: boolean }
  | { kind: 'side'; rank: number; visibleTo: readonly string[]; planned?: boolean }
  | { kind: 'tooling' }
  | { kind: 'app' }
  | { kind: 'root' }

/** `planned` is spelled on two kinds; this asks the question once. */
function isPlanned(placement: Placement): boolean {
  return 'planned' in placement && placement.planned === true
}

/**
 * `registry <- document <- geometry <- runtime <- viewport <- editor-host`,
 * with `ui` and `viewport-contrib` off the side (#3).
 *
 * A layer package may depend only on a STRICTLY lower rung. That rule alone
 * does NOT express "off the side": a low rung is reachable from every rung
 * above it, so parking the React+Mantine package at rung 1 would license
 * `runtime` — the package a game embeds — and `viewport` to pull it in, the
 * exact inversion #12 forbids when it asks `viewport` to take chrome colors as
 * numbers "while never depending on `ui`". A side package therefore carries its
 * own kind: `rank` still bounds what it may depend ON, and `visibleTo` names
 * the only things allowed to depend on IT. `feature-*` packages join that list
 * when they land.
 *
 * `ui` ranks alongside `document` because it depends on `registry` for
 * declarations and must never reach the document model — the inverted arrow #3
 * used to place the registry at the bottom. `fixtures` needs no such kind: it
 * sits at rung 4 with `viewport`, and being a peer rather than a floor is
 * already what makes it "unreachable from `runtime` or the exporter" as #3
 * requires.
 *
 * `feature-terrain` is deliberately absent even though #3 names it. #3 puts the
 * stroke framework in `editor-host` and also requires a feature be replaceable
 * from outside the tree, and it does not settle whether a feature therefore
 * sits above or below the host. Guessing a rung here would manufacture a
 * decision; leaving it out means creating the package fails this test until
 * someone makes one.
 */
const PLACEMENT: Record<string, Placement> = {
  'map-editor': { kind: 'root' },

  '@map-editor/registry': { kind: 'layer', rank: 0, planned: true },
  '@map-editor/document': { kind: 'layer', rank: 1 },
  // Visible only to apps and (once it exists) the editor host: the chrome
  // vocabulary is the editor's, not the runtime's. Entries are PLACEMENT keys,
  // except the literal 'app', which stands for any package of that kind.
  '@map-editor/ui': { kind: 'side', rank: 1, visibleTo: ['app', '@map-editor/editor-host'] },
  '@map-editor/geometry': { kind: 'layer', rank: 2 },
  '@map-editor/runtime': { kind: 'layer', rank: 3 },
  '@map-editor/viewport-contrib': { kind: 'layer', rank: 3, planned: true },
  '@map-editor/viewport': { kind: 'layer', rank: 4 },
  '@map-editor/fixtures': { kind: 'layer', rank: 4 },
  '@map-editor/editor-host': { kind: 'layer', rank: 5, planned: true },

  // Tooling describes the system from outside it, so it sits off the ladder
  // entirely rather than at the bottom of it: a rung of 0 would let any layer
  // package depend on the lint rules.
  '@map-editor/eslint-rules': { kind: 'tooling' },

  '@map-editor/editor': { kind: 'app' },
  // '@map-editor/export-cli' was cut 2026-09-11: producing a .glb headlessly needed a
  // native canvas (@napi-rs/canvas), and the owner ruled no native binaries over a dev
  // CLI. It returns as { kind: 'app' } once export has a canvas-free texture path.
}

interface PackageJson {
  name?: unknown
  dependencies?: unknown
  devDependencies?: unknown
  peerDependencies?: unknown
  optionalDependencies?: unknown
  exports?: unknown
}

interface Project {
  name: string
  /** Repo-relative directory, `.` for the root package. */
  dir: string
  /** Declared dependencies on other workspace projects, from all four fields. */
  workspaceDeps: string[]
}

const ROOT = new URL('..', import.meta.url).pathname

function readPackageJson(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as PackageJson
}

function names(field: unknown): string[] {
  return typeof field === 'object' && field !== null ? Object.keys(field) : []
}

/**
 * A runtime import of `foo` can also arrive as a type-only import satisfied by
 * `@types/foo` alone (no runtime package present) — DefinitelyTyped's scoped
 * naming (`@scope/x` -> `@types/scope__x`) is the one irregular part.
 */
function typesTwin(name: string): string {
  const scoped = /^@([^/]+)\/(.+)$/.exec(name)
  return scoped ? `@types/${scoped[1]}__${scoped[2]}` : `@types/${name}`
}

/**
 * The directories `pnpm-workspace.yaml` actually globs, so that adding a third
 * root (`features/*`, say) cannot leave a whole tree of packages unwalked. Only
 * a `<dir>/*` glob is understood; anything else is reported rather than
 * silently skipped, because a shape this cannot read is a shape it cannot check.
 */
function workspaceRoots(): { dirs: string[]; unreadable: string[] } {
  const lines = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8').split('\n')
  const start = lines.findIndex((line) => line.startsWith('packages:'))
  const dirs: string[] = []
  const unreadable: string[] = []
  for (const line of lines.slice(start + 1)) {
    // A non-indented, non-comment, non-blank line is the next top-level key.
    if (/^\S/.test(line) && !line.startsWith('#')) break
    const entry = /^\s+-\s*'?([^'\s]+)'?\s*$/.exec(line)
    if (!entry) continue
    const glob = /^([\w.-]+)\/\*$/.exec(entry[1])
    if (glob) dirs.push(glob[1])
    else unreadable.push(entry[1])
  }
  return { dirs, unreadable }
}

function discover(): Project[] {
  const dirs = ['.']
  for (const root of workspaceRoots().dirs) {
    if (!existsSync(join(ROOT, root))) continue
    for (const entry of readdirSync(join(ROOT, root)).sort()) {
      const dir = `${root}/${entry}`
      if (!statSync(join(ROOT, dir)).isDirectory()) continue
      if (existsSync(join(ROOT, dir, 'package.json'))) dirs.push(dir)
    }
  }

  return dirs.map((dir) => {
    const pkg = readPackageJson(dir)
    const declared = [
      ...names(pkg.dependencies),
      ...names(pkg.devDependencies),
      ...names(pkg.peerDependencies),
      ...names(pkg.optionalDependencies),
    ]
    return {
      name: typeof pkg.name === 'string' ? pkg.name : `<unnamed: ${dir}>`,
      dir,
      // A devDependency makes an import resolve exactly as a dependency does,
      // so an inversion hidden in a test's imports is still an inversion. The
      // same goes for an optionalDependency: pnpm links it into
      // `node_modules` and `require.resolve` finds it like any other.
      workspaceDeps: [...new Set(declared.filter((name) => name in PLACEMENT))].sort(),
    }
  })
}

/** The reason `from` may not declare `to`, or null when the arrow is legal. */
function violation(from: string, to: string): string | null {
  const a = PLACEMENT[from]
  const b = PLACEMENT[to]
  // An unplaced package is reported by the completeness test instead; saying it
  // twice would bury the one message that tells the author what to do.
  if (!a || !b) return null

  if (b.kind === 'root') return `${from} depends on the repo root package`

  // A side package is not a floor under the ladder, so reaching it is a
  // question of who is allowed to see it, asked before any rung arithmetic.
  if (b.kind === 'side' && !b.visibleTo.includes(from) && !b.visibleTo.includes(a.kind))
    return `${from} may not depend on ${to}: it is off the side of the ladder, visible only to ${b.visibleTo.join(', ')}`

  switch (a.kind) {
    case 'root':
      return null
    case 'tooling':
      return b.kind === 'tooling'
        ? null
        : `${from} is tooling and may not depend on ${to} (${b.kind}): the rule set describes the system from outside it`
    case 'app':
      return b.kind === 'app'
        ? `${from} is an app and may not depend on another app (${to}): apps are leaves`
        : null
    // What a package may depend ON is the same question for both kinds: a side
    // package is placed off the side for its consumers, not for its own imports.
    case 'layer':
    case 'side':
      if (b.kind !== 'layer' && b.kind !== 'side')
        return `${from} is a package and may not depend on ${to} (${b.kind}): the arrow from apps to packages points one way`
      return b.rank < a.rank
        ? null
        : `${from} (rung ${a.rank}) may not depend on ${to} (rung ${b.rank}): a package may depend only on a strictly lower rung`
  }
}

const projects = discover()
const placed = Object.entries(PLACEMENT)

describe('workspace dependency direction', () => {
  it('reads every directory the workspace globs', () => {
    expect(workspaceRoots().unreadable).toEqual([])
    expect(workspaceRoots().dirs.length).toBeGreaterThan(0)
  })

  it('places every workspace package on the ladder', () => {
    const unplaced = projects
      .filter((project) => !(project.name in PLACEMENT))
      .map(
        (project) =>
          `${project.dir} declares "${project.name}", which has no entry in PLACEMENT: give it a rung (or a kind) in tests/dependency-direction.test.ts`,
      )
    expect(unplaced).toEqual([])
  })

  it('keeps the ladder honest about what exists', () => {
    const found = new Set(projects.map((project) => project.name))
    const stale = placed.flatMap(([name, placement]) => {
      const planned = isPlanned(placement)
      if (planned && found.has(name))
        return [`${name} now exists: drop its \`planned\` flag and confirm the rung it was assigned`]
      if (!planned && !found.has(name))
        return [`${name} is placed but no workspace package declares that name`]
      return []
    })
    expect(stale).toEqual([])
  })

  it('has no declared dependency pointing the wrong way', () => {
    const violations = projects.flatMap((project) =>
      project.workspaceDeps.flatMap((dep) => {
        const reason = violation(project.name, dep)
        return reason === null ? [] : [`${project.dir}/package.json: ${reason}`]
      }),
    )
    expect(violations).toEqual([])
  })

  it('keeps runtime libraries off the root', () => {
    // A package's `dependencies` field is the one that says "my shipped
    // source imports this"; `devDependencies` covers private tooling
    // (typescript, vitest, eslint...) that the code it type-checks or tests
    // never imports. `peerDependencies` counts too — a package that expects
    // its consumer to supply a library (`ui`'s `react`, say) still imports
    // it, it just doesn't install it — so a name only under `peerDependencies`
    // is exactly as live an import target as one under `dependencies`. Only
    // `tooling`-kind packages are exempt: `eslint-rules`' `eslint` peer names
    // the linter it plugs into, not something its own source imports, and the
    // root legitimately carries that same name as a devDependency.
    //
    // Every runtime library also stands for its `@types/` twin: a type-only
    // `import type … from 'three'` resolves against `@types/three` alone,
    // with no runtime `three` in sight, so a root `@types/three` re-hoists
    // exactly like a root `three` would — the gap `8b6b80d` didn't close,
    // since it only ever named the runtime packages, not their types.
    const runtimeLibraries = new Set(
      projects
        .filter((project) => project.dir !== '.' && PLACEMENT[project.name]?.kind !== 'tooling')
        .flatMap((project) => {
          const pkg = readPackageJson(project.dir)
          return [...names(pkg.dependencies), ...names(pkg.peerDependencies)]
        })
        .filter((name) => !(name in PLACEMENT)),
    )
    for (const name of [...runtimeLibraries]) runtimeLibraries.add(typesTwin(name))

    const rootPkg = readPackageJson('.')
    const rootNames = [
      ...names(rootPkg.dependencies),
      ...names(rootPkg.devDependencies),
      ...names(rootPkg.peerDependencies),
      ...names(rootPkg.optionalDependencies),
    ]
    const violations = [...new Set(rootNames)]
      .filter((name) => runtimeLibraries.has(name))
      .sort()
      .map(
        (name) =>
          `package.json: root declares "${name}", which a workspace package also declares under "dependencies" (or its "@types/" twin) — remove it from the root; a root copy re-hoists into node_modules and lets any package import it without declaring it`,
      )
    expect(violations).toEqual([])
  })

  it("keeps every package's exports map explicit", () => {
    // #20's second gap: pnpm's strict node_modules stops an UNDECLARED
    // import, but says nothing about a declared entry point that is itself a
    // wildcard. A `"./*"` or `"./src/*"` subpath (or a missing `exports`
    // field, which lets Node fall back to the package root) reopens the deep
    // import #3 closed, so every key has to name one explicit file.
    //
    // A string-valued `exports` (`"./src/index.ts"`) is Node's shorthand for
    // `{ ".": "./src/index.ts" }` — one fixed file, with no key for a `*` to
    // vary against — so it is exactly as explicit as the object form and is
    // accepted the same way; a literal `*` inside that string still reopens
    // the deep import, so it is still caught.
    const violations = projects
      .filter((project) => project.dir !== '.')
      .flatMap((project) => {
        const { exports } = readPackageJson(project.dir)
        if (typeof exports === 'string')
          return exports.includes('*')
            ? [
                `${project.dir}/package.json: exports is "${exports}", a wildcard, which lets a consumer reach any file by path instead of the declared entry point`,
              ]
            : []
        if (typeof exports !== 'object' || exports === null || Array.isArray(exports))
          return [`${project.dir}/package.json: has no "exports" map, so a consumer can reach any file by path`]
        return Object.entries(exports as Record<string, unknown>)
          .filter(([key, value]) => key.includes('*') || (typeof value === 'string' && value.includes('*')))
          .map(
            ([key]) =>
              `${project.dir}/package.json: exports["${key}"] is a wildcard, which lets a consumer reach any file under it by path instead of the declared entry point`,
          )
      })
    expect(violations).toEqual([])
  })

  it('has an acyclic workspace graph', () => {
    const edges = new Map(projects.map((project) => [project.name, project.workspaceDeps]))
    const state = new Map<string, 'visiting' | 'done'>()
    const cycles: string[] = []

    const walk = (name: string, path: string[]): void => {
      if (state.get(name) === 'done') return
      if (state.get(name) === 'visiting') {
        cycles.push([...path.slice(path.indexOf(name)), name].join(' -> '))
        return
      }
      state.set(name, 'visiting')
      for (const dep of edges.get(name) ?? []) walk(dep, [...path, name])
      state.set(name, 'done')
    }

    for (const project of projects) walk(project.name, [])
    expect(cycles).toEqual([])
  })
})
