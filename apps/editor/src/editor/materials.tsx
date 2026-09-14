/**
 * Materials, in two places: the inspector's PICKER — the project's list in
 * priority order with a swatch from its terrain set, click to make one the
 * brush's — and the Project settings' LIBRARY, where a material is edited:
 * name, role, terrains, colour, priority, and what transitions its terrain
 * set has authored to the others (decision-log 2026-09-14: materials are the
 * project's, edited in Project settings).
 *
 * This is the app's rather than the terrain feature's because the swatches
 * need pixels: the loaded terrain sets live on the viewport actor, which no
 * feature package holds. Every edit is one `project.materials.set` with the
 * whole list, because the list's order is the materials' priority and a
 * reorder is as much an edit as a rename.
 */

import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'

import { AIR, PLACEHOLDER_SHEET, materialById, nextMaterialId, type MaterialDef, type ReadonlyMapDoc, type ReadonlyProjectDoc, type RgbaImage, type TerrainRef } from '@papercut/document'
import { useDocumentSelector, useHost, useProject, type SettingsSection } from '@papercut/editor-host'
import { exactTile, pairAuthored, terrainKey, type LoadedSet } from '@papercut/geometry'
import { Action, Actions, ColorInput, Dialog, Field, FieldGrid, Item, List, Note, Row, Section, Segmented, Select, SettingsBlock, Status, Swatch, Table, TableRow, TextInput } from '@papercut/ui'

import { run } from './commands'
import { rgbaToDataUrl } from './rgba'
import { repaintAndDeleteMaterial, type Session } from './session'

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
export function swatchFor(sets: readonly LoadedSet[], ref: TerrainRef): string | undefined {
  const loaded = sets.find((s) => s.set.sheet === ref.sheet)
  if (!loaded) return undefined
  const index = exactTile(loaded.set, [ref.terrain, ref.terrain, ref.terrain, ref.terrain])
  return index === null ? undefined : `url(${tileUrl(loaded, index)}) center / cover`
}

/** The swatch as an image URL alone, for a `Swatch`. */
function swatchImage(sets: readonly LoadedSet[], ref: TerrainRef): string | undefined {
  const loaded = sets.find((s) => s.set.sheet === ref.sheet)
  if (!loaded) return undefined
  const index = exactTile(loaded.set, [ref.terrain, ref.terrain, ref.terrain, ref.terrain])
  return index === null ? undefined : tileUrl(loaded, index)
}

const cssColor = (color: number): string => `#${color.toString(16).padStart(6, '0')}`
const refKey = (ref: TerrainRef): string => terrainKey(ref.sheet, ref.terrain)
const parseRef = (key: string): TerrainRef => ({ sheet: key.slice(0, key.lastIndexOf('/')), terrain: key.slice(key.lastIndexOf('/') + 1) })
const materialsOf = (project: ReadonlyProjectDoc): readonly MaterialDef[] => project.materials

/** How many voxels and face overrides of the open map use each material, by id. Walks every voxel, so it is selected settled. */
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

/** The inspector's picker. `active` is the active material's ID, what the brush paints and what a voxel stores — never a position in the list. */
export function MaterialsPicker({ active, sets }: { active: number; sets: readonly LoadedSet[] }) {
  const host = useHost()
  const materials = useProject(materialsOf)
  const counts = useDocumentSelector(usage, { equal: sameCounts, settled: true })
  const material = materialById(materials, active)
  const select = (id: number): void => void run(host, 'terrain.params', { material: id })
  const openSettings = (section: SettingsSection): void => void run(host, 'view.set', { settings: section })
  return (
    <Section title="Materials" summary={material ? `${materials.length} · ${material.name}` : materials.length}>
      <List>
        {[...materials].reverse().map((m) => (
          <Item key={m.id} name={m.name} meta={`${m.role} · ${counts[m.id] ?? 0}`} swatch={swatchFor(sets, m.top) ?? cssColor(m.color)} active={m.id === active} onClick={() => select(m.id)} />
        ))}
      </List>
      <Note>The project's library, shared by every map in it. Top of the list draws over what is below it where two meet in a corner nobody has drawn.</Note>
      <Actions>
        <Action title="Edit in Project settings…" onClick={() => openSettings('materials')} />
      </Actions>
    </Section>
  )
}

/** The Project settings' library: the table, and the selected material opened up to edit. */
export function MaterialsSettings({ session, selected, onSelect, sets }: { session: Session; selected: number; onSelect: (id: number) => void; sets: readonly LoadedSet[] }) {
  const host = useHost()
  const materials = useProject(materialsOf)
  const counts = useDocumentSelector(usage, { equal: sameCounts, settled: true })
  const summaries = useSyncExternalStore(session.summaries.subscribe, session.summaries.get)
  const currentMap = host.children.project.getSnapshot().context.map
  // Which maps use a material: the open map by its live document, the others by what their files say.
  const mapsUsing = (id: number): number => summaries.filter((s) => (s.path === currentMap ? (counts[id] ?? 0) > 0 : s.materials.has(id))).length
  const [dropping, setDropping] = useState<number | null>(null)
  const [deleting, setDeleting] = useState<{ from: MaterialDef; to: number } | null>(null)
  const notify = (notice: string): void => void run(host, 'view.set', { notice })
  const material = materialById(materials, selected) ?? materials[0]
  const active = material?.id ?? -1
  const position = materials.findIndex((m) => m.id === active)
  const terrains = useMemo(() => sets.flatMap((s) => s.set.terrains.map((t) => ({ value: terrainKey(s.set.sheet, t.id), label: `${t.name} · ${s.set.sheet}` }))), [sets])

  // The list whole, every time: its order is the priority. Ids never move, so no voxel changes what it is made of.
  const commit = (next: readonly MaterialDef[]): void => void run(host, 'project.materials.set', { materials: next.map((m) => ({ ...m })) })
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
    onSelect(id)
  }
  const remove = (): void => {
    if (!material || materials.length <= 1) return
    if (mapsUsing(active) > 0) {
      // In use somewhere: ask what to repaint it as, then repaint every map and take it out.
      setDeleting({ from: material, to: materials.find((m) => m.id !== active)?.id ?? active })
      return
    }
    commit(materials.filter((m) => m.id !== active))
    onSelect(materials[position === 0 ? 1 : position - 1].id)
  }
  const dropOn = (targetId: number, dragged: string): void => {
    setDropping(null)
    const fromAt = materials.findIndex((m) => m.id === Number(dragged))
    const toAt = materials.findIndex((m) => m.id === targetId)
    if (fromAt < 0 || toAt < 0 || fromAt === toAt) return
    const next = [...materials]
    const [moved] = next.splice(fromAt, 1)
    next.splice(toAt, 0, moved)
    commit(next)
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

  const refCell = (ref: TerrainRef | undefined): ReactNode =>
    ref ? (
      <>
        <Swatch image={swatchImage(sets, ref)} color={swatchImage(sets, ref) ? undefined : '#414859'} />
        <code>
          {ref.sheet.replace(/\.[^.]+$/, '')} / {ref.terrain}
        </code>
      </>
    ) : (
      <Status tone="muted">same as top</Status>
    )

  return (
    <>
      <SettingsBlock
        note="What the brush paints. A material names its top terrain and the terrain its cliff sides take; list order is draw priority where two meet at a corner. Shared by every map in the project."
        action={<Action title="Add material" tone="accent" onClick={() => add(undefined)} />}
      >
        <Table
          columns={[
            { title: '', width: '24px' },
            { title: 'Material', width: '1.1fr' },
            { title: 'Role', width: '0.6fr' },
            { title: 'Top', width: '1.2fr' },
            { title: 'Sides', width: '1.2fr' },
            { title: 'Used in', width: '0.8fr' },
          ]}
        >
          {materials.map((m) => (
            <TableRow
              key={m.id}
              active={m.id === active}
              onClick={() => onSelect(m.id)}
              drag={String(m.id)}
              dropping={dropping === m.id}
              onDrop={(dragged) => dropOn(m.id, dragged)}
              cells={[
                <span className="ui-drag-handle" title="Drag to reorder: higher draws over lower where two meet">⋮⋮</span>,
                <>
                  <Swatch image={swatchImage(sets, m.top)} color={swatchImage(sets, m.top) ? undefined : cssColor(m.color)} />
                  {m.name}
                </>,
                m.role,
                refCell(m.top),
                refCell(m.side),
                `${mapsUsing(m.id)} ${mapsUsing(m.id) === 1 ? 'map' : 'maps'}`,
              ]}
            />
          ))}
        </Table>
      </SettingsBlock>
      {material ? (
        <SettingsBlock
          title={material.name}
          action={
            <>
              <Action title="Move up" disabled={position <= 0} onClick={() => move(position - 1)} />
              <Action title="Move down" disabled={position >= materials.length - 1} onClick={() => move(position + 1)} />
              <Action title="Duplicate" onClick={() => add(material)} />
              <Action title="Delete" tone="danger" disabled={materials.length <= 1} onClick={remove} />
            </>
          }
        >
          <FieldGrid columns={3}>
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
            <Field label="Swatch" hint="The colour when no sheet is loaded">
              <ColorInput value={material.color} onChange={(color) => change({ color })} />
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
          </FieldGrid>
          <Row label="Id" value={`${material.id} · what a voxel stores, stable, never reused`} muted />
          <Row label="Transitions drawn" value={partners.authored.length ? partners.authored.join(', ') : '—'} />
          <Row label="Not yet drawn" value={partners.missing.length ? partners.missing.join(', ') : '—'} muted />
          <Note>{mapsUsing(active) > 0 ? `In use in ${mapsUsing(active)} ${mapsUsing(active) === 1 ? 'map' : 'maps'}${(counts[active] ?? 0) > 0 ? `, ${counts[active]} voxels and faces of this one` : ''}; deleting it asks what to repaint them as. Renaming and reordering never touch a map.` : 'Renaming and reordering never touch a map: ids are what voxels store.'}</Note>
        </SettingsBlock>
      ) : null}
      <Dialog
        opened={deleting !== null}
        onClose={() => setDeleting(null)}
        title={deleting ? `Delete ${deleting.from.name}` : ''}
        description={deleting ? `${deleting.from.name} is painted in ${mapsUsing(deleting.from.id)} ${mapsUsing(deleting.from.id) === 1 ? 'map' : 'maps'}. Every voxel and face that holds it is repainted as the material you pick, in every map, and then it is gone from the library.` : ''}
        footer={
          <>
            <Action title="Cancel" onClick={() => setDeleting(null)} />
            <Action
              title="Repaint and delete"
              tone="danger"
              onClick={() => {
                if (!deleting) return
                const { from, to } = deleting
                setDeleting(null)
                repaintAndDeleteMaterial(host, session, from.id, to)
                  .then(() => {
                    onSelect(to)
                    notify(`${from.name} deleted; repainted as ${materialById(materials, to)?.name ?? to}`)
                  })
                  .catch((error: unknown) => notify(error instanceof Error ? error.message : String(error)))
              }}
            />
          </>
        }
      >
        {deleting ? (
          <Field label="Repaint as">
            <Select value={String(deleting.to)} options={materials.filter((m) => m.id !== deleting.from.id).map((m) => ({ value: String(m.id), label: m.name }))} onChange={(value) => setDeleting({ ...deleting, to: Number(value) })} />
          </Field>
        ) : null}
      </Dialog>
    </>
  )
}
