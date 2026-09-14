import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Grants, NotGrantedError } from './grants'

let base: string
let project: string
let outside: string
let file: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'papercut-grants-')))
  project = join(base, 'project')
  outside = join(base, 'outside')
  mkdirSync(project)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'no')
  file = join(base, 'data', 'grants.json')
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('grants', () => {
  it('refuses everything before anything is granted', async () => {
    await expect(new Grants(file).resolve(join(project, 'map.json'))).rejects.toBeInstanceOf(NotGrantedError)
  })

  it('allows a granted folder, what is under it, and paths that do not exist yet', async () => {
    const grants = new Grants(file)
    await grants.add(project)
    expect(await grants.resolve(project)).toBe(project)
    expect(await grants.resolve(join(project, 'maps', 'new', 'level.json'))).toBe(join(project, 'maps', 'new', 'level.json'))
  })

  it('refuses a sibling, a parent, and a sibling sharing the name as a prefix', async () => {
    const grants = new Grants(file)
    await grants.add(project)
    mkdirSync(`${project}-other`)
    for (const path of [outside, base, `${project}-other`, join(project, '..', 'outside', 'secret.txt')])
      await expect(grants.resolve(path), path).rejects.toBeInstanceOf(NotGrantedError)
  })

  it('refuses a symlink inside a granted folder that points outside it', async () => {
    const grants = new Grants(file)
    await grants.add(project)
    symlinkSync(outside, join(project, 'escape'))
    await expect(grants.resolve(join(project, 'escape', 'secret.txt'))).rejects.toBeInstanceOf(NotGrantedError)
  })

  it('refuses relative paths and NUL bytes', async () => {
    const grants = new Grants(file)
    await grants.add(project)
    await expect(grants.resolve('project/map.json')).rejects.toBeInstanceOf(NotGrantedError)
    await expect(grants.resolve(`${project}/a\0b`)).rejects.toBeInstanceOf(NotGrantedError)
  })

  it('grants a single file without its folder', async () => {
    const grants = new Grants(file)
    const map = join(outside, 'map.json')
    await grants.add(map)
    expect(await grants.resolve(map)).toBe(map)
    await expect(grants.resolve(join(outside, 'secret.txt'))).rejects.toBeInstanceOf(NotGrantedError)
  })

  it('persists across instances and forgets a revoked grant', async () => {
    await new Grants(file).add(project)
    const reloaded = new Grants(file)
    expect(reloaded.list()).toEqual([project])
    expect(await reloaded.revoke(project)).toBe(project)
    await expect(new Grants(file).resolve(project)).rejects.toBeInstanceOf(NotGrantedError)
  })
})
