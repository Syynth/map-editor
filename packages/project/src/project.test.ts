import { describe, expect, it } from 'vitest'

import { PROJECT_FILE, createMap, parseProject, type RgbaImage } from '@papercut/document'
import { addTerrain, createTerrainSet, stampTemplate, type LoadedSet } from '@papercut/geometry'

import { rawImageCodec } from './codec'
import { addMap, addSheet, createProjectFolder, mapPathFor, openProject, readMap, slugOf, writeMap } from './folder'
import { FsError, MemoryFs, joinPath, parentPath } from './fs'
import { forget, parseRecents, remember } from './recents'

/** A stand-in for the placeholder set: one terrain, its edge set, over a flat image. */
function placeholder(tile = 4): LoadedSet {
  let set = createTerrainSet('ground.png', tile, 4, 4)
  set = addTerrain(set, { id: 'grass', name: 'Grass', color: '#6aa84f' })
  set = stampTemplate(set, 0, 0, null, 'grass')
  const image: RgbaImage = { width: 4 * tile, height: 4 * tile, data: new Uint8ClampedArray(4 * tile * 4 * tile * 4).fill(200) }
  return { set, image }
}

describe('the memory filesystem', () => {
  it('joins and splits paths the way the shell does', () => {
    expect(joinPath('/projects', 'harbour', 'maps/a.map.json')).toBe('/projects/harbour/maps/a.map.json')
    expect(joinPath('/projects/', '/harbour/')).toBe('/projects/harbour')
    expect(parentPath('/a/b/c.png')).toBe('/a/b')
    expect(parentPath('/a')).toBe('/')
    expect(parentPath('a')).toBe('')
  })

  it('needs a parent to write into, lists what it holds, and comes back from a snapshot', async () => {
    const fs = new MemoryFs()
    await expect(fs.writeFile('/p/a.txt', 'x')).rejects.toBeInstanceOf(FsError)
    await fs.mkdir('/p/maps', { recursive: true })
    await fs.writeFile('/p/a.txt', 'hello')
    await fs.writeFile('/p/maps/m.json', new Uint8Array([1, 2, 3]))
    expect(await fs.readTextFile('/p/a.txt')).toBe('hello')
    expect(await fs.readDir('/p')).toEqual([{ name: 'maps', kind: 'directory' }, { name: 'a.txt', kind: 'file' }])
    expect(await fs.exists('/p/maps')).toBe(true)
    expect(await fs.exists('/p/nope')).toBe(false)
    await expect(fs.readFile('/p/nope')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.mkdir('/p/maps')).rejects.toMatchObject({ code: 'EEXIST' })
    const back = MemoryFs.restore(fs.snapshot())
    expect(await back.readFile('/p/maps/m.json')).toEqual(new Uint8Array([1, 2, 3]))
    expect(await back.readDir('/p')).toEqual(await fs.readDir('/p'))
  })
})

describe('a project folder', () => {
  it('is created with the project file, one map and the placeholder sheet, and opens back the same', async () => {
    const fs = new MemoryFs()
    const created = await createProjectFolder(fs, '/projects/harbour', { name: 'Harbour Town', texelDensity: 4, placeholder: placeholder() }, rawImageCodec)
    expect(created.project.maps).toEqual(['maps/harbour-town.map.json'])
    expect(created.warnings).toEqual([])
    expect(await fs.readDir('/projects/harbour')).toEqual([{ name: 'maps', kind: 'directory' }, { name: 'sheets', kind: 'directory' }, { name: PROJECT_FILE, kind: 'file' }])
    expect(await fs.readDir('/projects/harbour/sheets')).toEqual([{ name: 'ground.png', kind: 'file' }, { name: 'ground.terrain.json', kind: 'file' }])

    const opened = await openProject(fs, '/projects/harbour', rawImageCodec)
    expect(opened.project).toEqual(created.project)
    expect(opened.warnings).toEqual([])
    expect(opened.sets).toHaveLength(1)
    expect(opened.sets[0].set.sheet).toBe('ground.png')
    expect(opened.sets[0].image.width).toBe(16)
    const map = await readMap(fs, '/projects/harbour', 'maps/harbour-town.map.json')
    expect(map.name).toBe('Harbour Town')
    // A second project cannot land in the same folder, and none in a folder that holds anything.
    await expect(createProjectFolder(fs, '/projects/harbour', { name: 'Again', texelDensity: 4, placeholder: placeholder() }, rawImageCodec)).rejects.toThrow(/already holds a project/)
    await fs.mkdir('/projects/busy/notes', { recursive: true })
    await expect(createProjectFolder(fs, '/projects/busy', { name: 'Busy', texelDensity: 4, placeholder: placeholder() }, rawImageCodec)).rejects.toThrow(/not empty/)
  })

  it('opens with warnings for a sheet that is missing or mis-sized and a map that is not there, never refusing', async () => {
    const fs = new MemoryFs()
    await createProjectFolder(fs, '/p', { name: 'P', texelDensity: 4, placeholder: placeholder() }, rawImageCodec)
    const project = parseProject(await fs.readTextFile('/p/papercut.json'))
    project.sheets.push({ path: 'sheets/cliffs.png', tile: 4, terrainSet: 'sheets/cliffs.terrain.json' })
    project.sheets.push({ path: 'sheets/props.png', tile: 8, terrainSet: null })
    project.maps.push('maps/gone.map.json')
    await fs.writeFile('/p/papercut.json', JSON.stringify(project))
    // The placeholder sheet's tile size no longer matches what the project lists.
    project.sheets[0].tile = 8
    await fs.writeFile('/p/papercut.json', JSON.stringify(project))

    await fs.writeFile('/p/maps/stray.map.json', JSON.stringify(createMap(2, 2, 'Stray')))

    const opened = await openProject(fs, '/p', rawImageCodec)
    expect(opened.sets).toEqual([])
    expect(opened.warnings).toEqual([
      'sheets/ground.terrain.json tags 4 px tiles, but the project lists ground.png at 8 px.',
      expect.stringMatching(/^sheets\/cliffs\.png: /),
      expect.stringMatching(/^sheets\/props\.png: /),
      'maps/gone.map.json is listed but not in the folder.',
      "maps/stray.map.json is in the folder but not in the project's map list.",
    ])
  })

  it('refuses a folder with no project file', async () => {
    const fs = new MemoryFs()
    await fs.mkdir('/empty')
    await expect(openProject(fs, '/empty', rawImageCodec)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('adds a map under a slug that does not collide, and a sheet beside its sidecar', async () => {
    const fs = new MemoryFs()
    const { project } = await createProjectFolder(fs, '/p', { name: 'P', texelDensity: 4, placeholder: placeholder() }, rawImageCodec)
    expect(slugOf('  Harbour   Road! ')).toBe('harbour-road')
    expect(slugOf('???')).toBe('map')
    expect(mapPathFor(project, 'P')).toBe('maps/p-2.map.json')
    const added = await addMap(fs, '/p', project, createMap(8, 8, 'Cliff Path'))
    expect(added.path).toBe('maps/cliff-path.map.json')
    expect(added.project.maps).toEqual(['maps/p.map.json', 'maps/cliff-path.map.json'])
    expect(parseProject(await fs.readTextFile('/p/papercut.json')).maps).toEqual(added.project.maps)
    await writeMap(fs, '/p', added.path, createMap(2, 2, 'Cliff Path'))
    expect((await readMap(fs, '/p', added.path)).structures.ground).toMatchObject({ size: { width: 2, height: 2 } })

    const cliffs = placeholder(4)
    const withSheet = await addSheet(fs, '/p', added.project, { name: 'cliffs.png', bytes: await rawImageCodec.encode(cliffs.image), tile: 4, set: cliffs.set })
    expect(withSheet.sheets.map((s) => s.path)).toEqual(['sheets/ground.png', 'sheets/cliffs.png'])
    expect(withSheet.sheets[1]).toEqual({ path: 'sheets/cliffs.png', tile: 4, terrainSet: 'sheets/cliffs.terrain.json' })
    const reopened = await openProject(fs, '/p', rawImageCodec)
    expect(reopened.sets.map((s) => s.set.sheet)).toEqual(['ground.png', 'cliffs.png'])
    // Adding a sheet of the same name replaces its entry rather than listing it twice; without a sidecar it loads as an empty set over its image.
    const replaced = await addSheet(fs, '/p', withSheet, { name: 'cliffs.png', bytes: await rawImageCodec.encode(cliffs.image), tile: 4, set: null })
    expect(replaced.sheets.map((s) => s.path)).toEqual(['sheets/ground.png', 'sheets/cliffs.png'])
    expect(replaced.sheets[1].terrainSet).toBeNull()
    const bare = await openProject(fs, '/p', rawImageCodec)
    expect(bare.sets[1].set).toMatchObject({ sheet: 'cliffs.png', tile: 4, columns: 4, rows: 4, terrains: [] })
    expect(bare.sets[1].set.tiles.size).toBe(0)
  })
})

describe('recents', () => {
  it('keeps one entry per folder, most recent first, capped, and believes a stored list only as far as it parses', () => {
    let list = remember([], { name: 'A', folder: '/a', openedAt: 1 })
    list = remember(list, { name: 'B', folder: '/b', openedAt: 2 })
    list = remember(list, { name: 'A2', folder: '/a', openedAt: 3 })
    expect(list.map((r) => r.folder)).toEqual(['/a', '/b'])
    expect(list[0].name).toBe('A2')
    for (let i = 0; i < 20; i++) list = remember(list, { name: `P${i}`, folder: `/p${i}`, openedAt: i })
    expect(list).toHaveLength(10)
    expect(forget(list, '/p19').map((r) => r.folder)).not.toContain('/p19')
    expect(parseRecents(null)).toEqual([])
    expect(parseRecents('nope')).toEqual([])
    expect(parseRecents(JSON.stringify([{ name: 'X', folder: '/x' }, { bad: true }, 3]))).toEqual([{ name: 'X', folder: '/x', openedAt: 0 }])
  })
})
