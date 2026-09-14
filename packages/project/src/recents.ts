/**
 * Recent projects: what the startup screen lists, most recent first.
 *
 * Pure over a list; where the list is kept (the app's `localStorage`, a
 * file in the shell's data directory) is the host's business. One entry per
 * folder, capped, and pruned lazily — an entry whose folder is gone is
 * dropped when opening it fails, not by probing the disk on every launch.
 */

export interface RecentProject {
  readonly name: string
  /** The project's folder, absolute. */
  readonly folder: string
  /** When it was last opened, epoch milliseconds. */
  readonly openedAt: number
}

export const RECENTS_LIMIT = 10

/** `entry` at the front, any earlier entry for the same folder gone, the list capped. */
export function remember(list: readonly RecentProject[], entry: RecentProject): RecentProject[] {
  return [entry, ...list.filter((r) => r.folder !== entry.folder)].slice(0, RECENTS_LIMIT)
}

export function forget(list: readonly RecentProject[], folder: string): RecentProject[] {
  return list.filter((r) => r.folder !== folder)
}

/** A stored list, believed only as far as it parses: anything that is not an entry is dropped. */
export function parseRecents(text: string | null): RecentProject[] {
  if (!text) return []
  try {
    const raw = JSON.parse(text) as unknown
    if (!Array.isArray(raw)) return []
    return raw
      .filter((r): r is RecentProject => typeof r === 'object' && r !== null && typeof (r as RecentProject).folder === 'string' && typeof (r as RecentProject).name === 'string')
      .map((r) => ({ name: r.name, folder: r.folder, openedAt: typeof r.openedAt === 'number' ? r.openedAt : 0 }))
      .slice(0, RECENTS_LIMIT)
  } catch {
    return []
  }
}
