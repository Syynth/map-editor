/**
 * The Materials section of the Terrain inspector (spec §4): the project's
 * materials in priority order, each with a swatch from its terrain set, its
 * role and how much of the map uses it; the active one opened up to edit
 * its name, role, terrains and colour, with which transitions to the other
 * materials its terrain set has authored and which it has not.
 *
 * This is the app's rather than the terrain feature's because the swatches
 * need pixels: the loaded terrain sets live on the composition root's art,
 * which no feature package holds. Every edit is one `project.materials.set`
 * with the whole list, because the list's order is the materials' priority and a
 * reorder is as much an edit as a rename.
 */

import { useMemo } from 'react'

import { AIR, PLACEHOLDER_SHEET, materialById, nextMaterialId, type MaterialDef, type ReadonlyMapDoc, type RgbaImage, type TerrainRef } from '@papercut/document'
import { useDocumentSelector, useHost, useProject } from '@papercut/editor-host'
import { exactTile, pairAuthored, terrainKey, type LoadedSet } from '@papercut/geometry'
import { Action, Actions, ColorInput, Field, Item, List, Note, Row, Segmented, Select, Section, TextInput } from '@papercut/ui'

import { run } from './commands'
import { rgbaToDataUrl } from './rgba'

/** One tile's pixels as a data URL, once per image and tile. */
const swatches = new WeakMap<RgbaImage, Map<number, string>>()

function tileUrl(loaded: LoadedSet, index: number): string {
  let byIndex = swatches.get(loaded.image)
  if (!byIndex) {
    byIndex = new Map()
    swatches.set(loaded.image, byIndex)
  }
  const known = byIndex.get(index)
  if (known) return known
  const { image, set } = loaded
  const t = set.tile
  const sx = (index % set.columns) * t
  const sy = Math.floor(index / set.columns) * t
  const data = new Uint8ClampedArray(t * t * 4)
  for (let y = 0; y < t; y++) data.set(image.data.subarray(((sy + y) * image.width + sx) * 4, ((sy + y) * image.width + sx + t) * 4), y * t * 4)
  const url = rgbaToDataUrl({ width: t, height: t, data })
  byIndex.set(index, url)
  return url
}

/** The swatch a terrain reference shows: its full tile, or nothing when its set is not loaded. */
function swatchFor(sets: readonly LoadedSet[], ref: TerrainRef): string | undefined {
  const loaded = sets.find((s) => s.set.sheet === ref.sheet)
  if (!loaded) return undefined
  const index = exactTile(loaded.set, [ref.terrain, ref.terrain, ref.terrain, ref.terrain])
  return index === null ? undefined : `url(${tileUrl(loaded, index)}) center / cover`
}

const materialsOf = (project: { readonly materials: readonly MaterialDef[] }): readonly MaterialDef[] => project.materials

const cssColor = (color: number): string => `#${color.toString(16).padStart(6, '0')}`
const refKey = (ref: TerrainRef): string => terrainKey(ref.sheet, ref.terrain)
const parseRef = (key: string): TerrainRef => ({ sheet: key.slice(0, key.lastIndexOf('/')), terrain: key.slice(key.lastIndexOf('/') + 1) })

/** How many voxels and face overrides use each material, by id. Walks every voxel, so it is selected settled. */
function usage(doc: ReadonlyMapDoc): Record<number, number> {
  const counts: Record<number, number> = {}
  for (const id of doc.structureOrder) {
    const s = doc.structures[id]
    if (!s || s.kind !== 'voxel') continue
    for (const m of s.voxels.material) if (m !== AIR) counts[m] = (counts[m] ?? 0) + 1
    for (const m of Object.values(s.paint.faces)) counts[m] = (counts[m] ?? 0) + 1
  }
  return counts
}

const sameCounts = (a: Record<number, number>, b: Record<number, number>): boolean => {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => a[Number(k)] === b[Number(k)])
}

/** `active` is the active material's ID, what the brush paints and what a voxel stores — never a position in the list. */
export function MaterialsSection({ active, sets }: { active: number; sets: readonly LoadedSet[] }) {
  const host = useHost()
  const counts = useDocumentSelector(usage, { equal: sameCounts, settled: true })
  const materials = useProject(materialsOf)
  const material = materialById(materials, active)
  const position = materials.findIndex((m) => m.id === active)
  const terrains = useMemo(() => sets.flatMap((s) => s.set.terrains.map((t) => ({ value: terrainKey(s.set.sheet, t.id), label: `${t.name} · ${s.set.sheet}` }))), [sets])

  // The list whole, every time: its order is the priority. Ids never move, so no voxel changes what it is made of.
  const commit = (next: readonly MaterialDef[]): void => void run(host, 'project.materials.set', { materials: next.map((m) => ({ ...m })) })
  const select = (id: number): void => void run(host, 'terrain.params', { material: id })
  const change = (changes: Partial<MaterialDef>): void => {
    if (!material) return
    const next = { ...material, ...changes }
    if (next.side === undefined) delete next.side
    commit(materials.map((m) => (m.id === active ? next : m)))
  }
  const move = (to: number): void => {
    if (position < 0 || to < 0 || to >= materials.length) return
    const next = [...materials]
    const [moved] = next.splice(position, 1)
    next.splice(to, 0, moved)
    commit(next)
  }
  const add = (from: MaterialDef | undefined): void => {
    const id = nextMaterialId(materials)
    const fresh: MaterialDef = from ? { ...from, id, name: `${from.name} copy` } : { id, name: `Material ${materials.length + 1}`, color: 0x808080, role: 'any', top: materials[0]?.top ?? { sheet: PLACEHOLDER_SHEET, terrain: 'grass' } }
    commit([...materials, fresh])
    select(id)
  }
  const remove = (): void => {
    if (!material || materials.length <= 1 || (counts[active] ?? 0) > 0) return
    commit(materials.filter((m) => m.id !== active))
    select(materials[position === 0 ? 1 : position - 1].id)
  }

  // Which of the other materials' top terrains this one has an authored transition to, in its own set.
  const partners = useMemo(() => {
    if (!material) return { authored: [] as string[], missing: [] as string[] }
    const loaded = sets.find((s) => s.set.sheet === material.top.sheet)
    const authored: string[] = []
    const missing: string[] = []
    for (const other of materials) {
      if (other === material || refKey(other.top) === refKey(material.top)) continue
      const same = other.top.sheet === material.top.sheet
      ;(loaded && same && pairAuthored(loaded.set, material.top.terrain, other.top.terrain) ? authored : missing).push(other.name)
    }
    return { authored, missing }
  }, [material, materials, sets])

  return (
    <Section title="Materials" summary={material ? `${materials.length} · ${material.name}` : materials.length}>
      <List>
        {[...materials].reverse().map((m) => (
          <Item key={m.id} name={m.name} meta={`${m.role} · ${counts[m.id] ?? 0}`} swatch={swatchFor(sets, m.top) ?? cssColor(m.color)} active={m.id === active} onClick={() => select(m.id)} />
        ))}
      </List>
      <Note>Top of the list draws over what is below it where two meet in a corner the artist has not drawn.</Note>
      {material ? (
        <>
          <Actions>
            <Action title="Move up" disabled={position >= materials.length - 1} onClick={() => move(position + 1)} />
            <Action title="Move down" disabled={position <= 0} onClick={() => move(position - 1)} />
            <Action title="New material" onClick={() => add(undefined)} />
            <Action title="Duplicate" onClick={() => add(material)} />
            <Action title="Delete" tone="danger" disabled={materials.length <= 1 || (counts[active] ?? 0) > 0} onClick={remove} />
          </Actions>
          <Field label="Name">
            <TextInput value={material.name} onChange={(name) => change({ name })} />
          </Field>
          <Field label="Role" hint="Where the material is meant to go; the brush does not enforce it">
            <Segmented
              value={material.role}
              options={[
                { value: 'top', label: 'Top' },
                { value: 'wall', label: 'Wall' },
                { value: 'any', label: 'Any' },
              ]}
              onChange={(role) => change({ role })}
            />
          </Field>
          <Field label="Top terrain" hint="Draws the top faces, and the sides unless a side terrain is set">
            <Select value={refKey(material.top)} options={terrains} onChange={(key) => change({ top: parseRef(key) })} />
          </Field>
          <Field label="Side terrain">
            <Select
              value={material.side ? refKey(material.side) : 'same'}
              options={[{ value: 'same', label: 'Same as top' }, ...terrains]}
              onChange={(key) => change({ side: key === 'same' ? undefined : parseRef(key) })}
            />
          </Field>
          <Field label="Colour" hint="The swatch, and the fill when no sheet is loaded">
            <ColorInput value={material.color} onChange={(color) => change({ color })} />
          </Field>
          <Row label="Transitions drawn" value={partners.authored.length ? partners.authored.join(', ') : '—'} />
          <Row label="Not yet drawn" value={partners.missing.length ? partners.missing.join(', ') : '—'} muted />
          {(counts[active] ?? 0) > 0 ? <Note>In use on {counts[active]} voxels and faces, so it cannot be deleted.</Note> : null}
        </>
      ) : null}
    </Section>
  )
}
