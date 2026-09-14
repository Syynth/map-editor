import { readFileSync } from 'node:fs'
import { mkdir, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * The folders and files the user has granted the web bundle, and the check
 * every filesystem call goes through (docs/decision-log.md, "The first shell
 * ships a generic, folder-scoped filesystem API as a Developer ID app").
 *
 * Grants are stored as real paths — symlinks resolved at grant time — and a
 * requested path is resolved the same way before it is compared, so a link
 * inside a granted folder that points elsewhere resolves to where it points
 * and is refused. The check and the operation are separate syscalls, so a
 * link swapped in between them is not caught; that race needs a process
 * already able to write inside the granted folder, which is past the boundary
 * this exists to hold.
 */

/** Thrown for a path outside every grant; the handlers report it as `NOT_GRANTED`. */
export class NotGrantedError extends Error {
  readonly code = 'NOT_GRANTED'
  constructor(path: string) {
    super(`${path} is not inside a granted folder`)
  }
}

export class Grants {
  readonly #file: string
  #paths: string[]

  /** `file` is where grants persist — `grants.json` in the app's data folder. */
  constructor(file: string) {
    this.#file = file
    this.#paths = readGrantsFile(file)
  }

  list(): string[] {
    return [...this.#paths]
  }

  /** Grants `path` (a folder and everything under it, or one file) and persists it. */
  async add(path: string): Promise<string> {
    const real = await realPathAllowingMissing(checkAbsolute(path))
    if (!this.#paths.some((granted) => samePath(granted, real))) {
      this.#paths = [...this.#paths, real]
      await this.#save()
    }
    return real
  }

  /** Returns the real path of what was revoked, or null if nothing matched. */
  async revoke(path: string): Promise<string | null> {
    const real = await realPathAllowingMissing(checkAbsolute(path))
    const match = this.#paths.find((granted) => samePath(granted, real))
    if (match === undefined) return null
    this.#paths = this.#paths.filter((granted) => granted !== match)
    await this.#save()
    return match
  }

  /** The real path `path` names, if it lies within a grant. Throws `NotGrantedError` otherwise. */
  async resolve(path: string): Promise<string> {
    const real = await realPathAllowingMissing(checkAbsolute(path))
    if (this.#paths.some((granted) => isWithin(granted, real))) return real
    throw new NotGrantedError(path)
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true })
    const temporary = `${this.#file}.tmp`
    await writeFile(temporary, JSON.stringify({ paths: this.#paths }, null, 2))
    await rename(temporary, this.#file)
  }
}

function readGrantsFile(file: string): string[] {
  try {
    const { paths } = JSON.parse(readFileSync(file, 'utf8')) as { paths?: unknown }
    return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string' && isAbsolute(path)) : []
  } catch {
    return []
  }
}

function checkAbsolute(path: unknown): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new NotGrantedError(String(path))
  return resolve(path)
}

/**
 * `realpath`, but a path that does not exist yet (a file about to be written)
 * resolves through its nearest existing ancestor, with the missing tail
 * appended. `path` is already normalised, so the tail holds no `..`.
 */
export async function realPathAllowingMissing(path: string): Promise<string> {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * macOS and Windows volumes are case-insensitive by default, and a grant
 * picked as `~/Maps` must still cover a request spelled `~/maps`. The cost is
 * that on a case-sensitive volume a grant also covers a sibling differing only
 * in case — a much narrower hole than refusing correct paths would be a bug.
 */
const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32'

function samePath(a: string, b: string): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function isWithin(granted: string, path: string): boolean {
  const inside = relative(caseInsensitive ? granted.toLowerCase() : granted, caseInsensitive ? path.toLowerCase() : path)
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
}
