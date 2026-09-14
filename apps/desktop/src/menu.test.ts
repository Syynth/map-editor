import { describe, expect, it, vi } from 'vitest'

import type { MenuCommand } from '@papercut/shell-api'

import { menuTemplate } from './menu'

vi.mock('electron', () => ({ Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() } }))

type Item = { label?: string; role?: string; enabled?: boolean; submenu?: Item[]; click?: () => void }

function search(items: Item[], label: string): Item | null {
  for (const item of items) {
    if (item.label === label) return item
    const inner = item.submenu ? search(item.submenu, label) : null
    if (inner) return inner
  }
  return null
}

function find(items: Item[], label: string): Item {
  const found = search(items, label)
  if (!found) throw new Error(`no ${label}`)
  return found
}

describe('the native menu', () => {
  it('sends a command per item, enables the project items only with a project open, and lists recents', () => {
    const sent: MenuCommand[] = []
    const open = menuTemplate({ platform: 'darwin', state: { projectOpen: true }, recents: [{ name: 'Harbour', folder: '/h' }], send: (c) => sent.push(c), openReleases: () => undefined }) as Item[]
    expect(open[0]).toMatchObject({ role: 'appMenu' })
    find(open, 'New Project…').click?.()
    find(open, 'Harbour').click?.()
    find(open, 'Save').click?.()
    find(open, 'Close Project').click?.()
    expect(sent).toEqual([{ id: 'project.new' }, { id: 'project.openRecent', folder: '/h' }, { id: 'file.save' }, { id: 'project.close' }])
    expect(find(open, 'Save').enabled).toBe(true)

    const closed = menuTemplate({ platform: 'linux', state: { projectOpen: false }, recents: [], send: () => undefined, openReleases: () => undefined }) as Item[]
    expect(closed[0]?.label).toBe('File')
    for (const label of ['New Map…', 'Save', 'Export glTF…', 'Project Settings…', 'Close Project']) expect(find(closed, label).enabled).toBe(false)
    expect(find(closed, 'No Recent Projects').enabled).toBe(false)
    expect(find(closed, 'Open Project…').enabled).toBeUndefined()
  })
})
