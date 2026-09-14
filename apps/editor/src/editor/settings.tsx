/**
 * Project settings (design of 2026-09-14, after brink's settings modal): a
 * rail of sections, one at a time. What is here is the project's — written
 * to `papercut.json` and shared with everyone who opens the folder — which
 * is what the scope switch says; app-scoped settings arrive with the first
 * setting that is the machine's rather than the project's.
 *
 * Which section is open is view state (`view.set { settings }`), so the
 * menu, the chord and an inspector's "Edit in Project settings…" all open
 * the same modal the same way.
 */

import { useState } from 'react'

import { sheetName, type MaterialDef, type SheetEntry } from '@papercut/document'
import { useHost, useProject, useProjectSelector, useViewSelector, useViewportSelector, type SettingsSection } from '@papercut/editor-host'
import { addTerrain, edgeCoverage, pairAuthored, type LoadedSet, type TerrainDef } from '@papercut/geometry'
import { slugOf } from '@papercut/project'
import { Action, ColorInput, Field, FieldGrid, FileButton, Note, NumberInput, Row, Segmented, SettingsBlock, SettingsDialog, SettingsRailItem, SettingsRailNote, SettingsScope, SheetPreview, Status, Swatch, Table, TableRow, TextInput } from '@papercut/ui'
import type { IconName } from '@papercut/ui'

import { useArt } from './art'
import { run } from './commands'
import { MaterialsSettings } from './materials'
import { CameraRigProperties } from './panels'
import { rgbaToDataUrl } from './rgba'
import { addImagesTo, newMapIn, openMapAt, setSheetTile, unlistSheet, updateTerrainSet, type Session } from './session'

const SECTIONS: ReadonlyArray<{ id: SettingsSection; title: string; icon: IconName }> = [
  { id: 'general', title: 'General', icon: 'rect' },
  { id: 'resolution', title: 'Resolution', icon: 'grid' },
  { id: 'sheets', title: 'Sheets', icon: 'tile' },
  { id: 'terrains', title: 'Terrain sets', icon: 'terrain' },
  { id: 'materials', title: 'Materials', icon: 'sculpt' },
  { id: 'camera', title: 'Camera rig', icon: 'camera' },
]

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function ProjectSettings({ session }: { session: Session }) {
  const host = useHost()
  const section = useViewSelector((snapshot) => snapshot.context.settings)
  const name = useProject((p) => p.name)
  const [selectedMaterial, setSelectedMaterial] = useState(0)
  const [selectedSheet, setSelectedSheet] = useState<string | null>(null)
  const art = useArt()
  const open = (next: SettingsSection): void => void run(host, 'view.set', { settings: next })
  const close = (): void => void run(host, 'view.set', { settings: null })
  const title = SECTIONS.find((s) => s.id === section)?.title ?? ''

  return (
    <SettingsDialog
      opened={section !== null}
      onClose={close}
      title={title}
      aside={<span>Written to papercut.json</span>}
      rail={
        <>
          <SettingsScope scopes={[{ id: 'project', label: 'Project' }, { id: 'app', label: 'App', disabled: true }]} active="project" onChange={() => undefined} />
          <SettingsRailNote>Written to papercut.json — shared with everyone who opens {name}.</SettingsRailNote>
          {SECTIONS.map((s) => (
            <SettingsRailItem key={s.id} icon={s.icon} title={s.title} active={s.id === section} onClick={() => open(s.id)} />
          ))}
        </>
      }
    >
      {section === 'general' ? <GeneralSettings session={session} /> : null}
      {section === 'resolution' ? <ResolutionSettings /> : null}
      {section === 'sheets' ? <SheetsSettings session={session} sets={art.loadedTerrain} warning={art.terrainWarning} selected={selectedSheet} onSelect={setSelectedSheet} /> : null}
      {section === 'terrains' ? <TerrainsSettings session={session} sets={art.loadedTerrain} /> : null}
      {section === 'materials' ? <MaterialsSettings selected={selectedMaterial} onSelect={setSelectedMaterial} sets={art.terrain} /> : null}
      {section === 'camera' ? <CameraSettings /> : null}
    </SettingsDialog>
  )
}

// --- General ------------------------------------------------------------------

const mapLabel = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.map\.json$/, '')

function GeneralSettings({ session }: { session: Session }) {
  const host = useHost()
  const project = useProject((p) => p)
  const folder = useProjectSelector((snapshot) => snapshot.context.folder)
  const current = useProjectSelector((snapshot) => snapshot.context.map)
  const [newName, setNewName] = useState('')
  const notify = (notice: string): void => void run(host, 'view.set', { notice })
  const setMaps = (maps: readonly string[]): void => void run(host, 'project.maps.set', { maps: [...maps] })
  const move = (path: string, by: number): void => {
    const at = project.maps.indexOf(path)
    const to = at + by
    if (at < 0 || to < 0 || to >= project.maps.length) return
    const next = [...project.maps]
    next.splice(at, 1)
    next.splice(to, 0, path)
    setMaps(next)
  }
  return (
    <>
      <SettingsBlock title="Project">
        <FieldGrid>
          <Field label="Name">
            <TextInput value={project.name} onChange={(value) => (value.trim() ? run(host, 'project.set', { name: value }) : undefined)} />
          </Field>
          <Field label="Folder">
            <Row label="" value={folder ?? '—'} muted />
          </Field>
        </FieldGrid>
      </SettingsBlock>
      <SettingsBlock
        title="Maps"
        note="In the order the project shows them. Removing a map from the list leaves its file in the folder."
        action={
          <>
            <TextInput value={newName} onChange={setNewName} placeholder="New map name" />
            <Action
              title="Add map"
              disabled={!newName.trim()}
              onClick={() => {
                const mapName = newName.trim()
                setNewName('')
                newMapIn(host, session, mapName).catch((error: unknown) => notify(messageOf(error)))
              }}
            />
          </>
        }
      >
        <Table
          columns={[
            { title: 'Map', width: '1.4fr' },
            { title: 'File', width: '1.6fr' },
            { title: '', width: 'max-content' },
          ]}
        >
          {project.maps.map((path, index) => (
            <TableRow
              key={path}
              active={path === current}
              cells={[
                <>
                  {mapLabel(path)}
                  {path === current ? <Status tone="accent">open</Status> : null}
                </>,
                <code>{path}</code>,
                <>
                  <Action title="Open" disabled={path === current} onClick={() => void openMapAt(host, session, path).catch((error: unknown) => notify(messageOf(error)))} />
                  <Action title="↑" disabled={index === 0} onClick={() => move(path, -1)} />
                  <Action title="↓" disabled={index === project.maps.length - 1} onClick={() => move(path, 1)} />
                  <Action title="Remove" tone="danger" disabled={path === current || project.maps.length <= 1} onClick={() => setMaps(project.maps.filter((m) => m !== path))} />
                </>,
              ]}
            />
          ))}
        </Table>
      </SettingsBlock>
    </>
  )
}

// --- Resolution ---------------------------------------------------------------

const DENSITIES = [8, 16, 32, 64]

function ResolutionSettings() {
  const host = useHost()
  const resolution = useProject((p) => p.resolution)
  const set = (changes: Partial<typeof resolution>): void => void run(host, 'project.set', { resolution: { ...resolution, ...changes } })
  return (
    <SettingsBlock title="Resolution profile" note="Pixels per tile, and how textures sample. Every sheet in the project is checked against the density; a mismatch is reported in Sheets, never rescaled. Mixed density is the fastest way to make pixel art in 3D look wrong.">
      <FieldGrid>
        <Field label="Texel density">
          <Segmented value={DENSITIES.includes(resolution.texelDensity) ? resolution.texelDensity : 0} options={[...DENSITIES.map((d) => ({ value: d, label: `${d} px` })), { value: 0, label: 'Custom' }]} onChange={(d) => (d > 0 ? set({ texelDensity: d }) : undefined)} />
        </Field>
        <Field label="Custom" hint="Any whole number of pixels per tile">
          <NumberInput value={resolution.texelDensity} min={1} max={256} onChange={(texelDensity) => set({ texelDensity })} />
        </Field>
        <Field label="Filtering" hint="Nearest for pixel art; linear for high-resolution art">
          <Segmented
            value={resolution.filtering}
            options={[
              { value: 'nearest', label: 'Nearest' },
              { value: 'linear', label: 'Linear' },
            ]}
            onChange={(filtering) => set({ filtering })}
          />
        </Field>
      </FieldGrid>
    </SettingsBlock>
  )
}

// --- Sheets -------------------------------------------------------------------

/** The whole sheet as a data URL, once per image. */
const previews = new WeakMap<object, string>()
function previewOf(loaded: LoadedSet): string {
  const known = previews.get(loaded.image)
  if (known) return known
  const url = rgbaToDataUrl(loaded.image)
  previews.set(loaded.image, url)
  return url
}

function usesOf(materials: readonly MaterialDef[], sheet: string): number {
  return materials.filter((m) => m.top.sheet === sheet || m.side?.sheet === sheet).length
}

function SheetsSettings({ session, sets, warning, selected, onSelect }: { session: Session; sets: readonly LoadedSet[]; warning: string | null; selected: string | null; onSelect: (name: string | null) => void }) {
  const host = useHost()
  const project = useProject((p) => p)
  const notify = (notice: string): void => void run(host, 'view.set', { notice })
  const warnings = warning?.split('\n') ?? []
  const density = project.resolution.texelDensity
  const chosen = project.sheets.find((s) => sheetName(s.path) === selected) ?? project.sheets[0]
  const loadedFor = (entry: SheetEntry): LoadedSet | undefined => sets.find((s) => s.set.sheet === sheetName(entry.path))
  const statusOf = (entry: SheetEntry): { tone: 'ok' | 'warn' | 'muted'; text: string } => {
    const loaded = loadedFor(entry)
    const said = warnings.find((w) => w.startsWith(entry.path) || (entry.terrainSet !== null && w.startsWith(entry.terrainSet)))
    if (said) return { tone: 'warn', text: said.slice(said.indexOf(':') + 1).trim() || 'Missing' }
    if (entry.tile !== density) return { tone: 'warn', text: `${entry.tile} px, project is ${density}` }
    if (loaded) return { tone: 'ok', text: 'Matches' }
    return entry.terrainSet === null ? { tone: 'muted', text: 'No terrain set' } : { tone: 'warn', text: 'Not loaded' }
  }
  const onAdd = (files: File[]): void => {
    addImagesTo(host, session, files)
      .then((added) => {
        onSelect(added)
        notify(`Added ${added} to the project`)
      })
      .catch((error: unknown) => notify(messageOf(error)))
  }
  const loaded = chosen ? loadedFor(chosen) : undefined
  return (
    <>
      <SettingsBlock
        note={`Images the project draws from. They live in sheets/; adding one copies it there, and every one is checked against the project's ${density} px texel density.`}
        action={<FileButton icon="plus" title="Add image…" accept="image/png,image/*,.json,application/json" multiple onFiles={onAdd} />}
      >
        <Table
          columns={[
            { title: 'Sheet', width: '1.4fr' },
            { title: 'Size', width: '0.8fr' },
            { title: 'Tile', width: '0.5fr' },
            { title: 'Used by', width: '1.3fr' },
            { title: 'Status', width: '1fr' },
          ]}
        >
          {project.sheets.map((entry) => {
            const name = sheetName(entry.path)
            const set = loadedFor(entry)
            const status = statusOf(entry)
            return (
              <TableRow
                key={entry.path}
                active={chosen === entry}
                onClick={() => onSelect(name)}
                cells={[
                  <>
                    <Swatch image={set ? previewOf(set) : undefined} color={set ? undefined : '#353b4a'} />
                    <code>{name}</code>
                  </>,
                  set ? <code>{`${set.image.width} × ${set.image.height}`}</code> : <Status tone="muted">—</Status>,
                  <code>{`${entry.tile} px`}</code>,
                  [entry.terrainSet ? sheetName(entry.terrainSet) : null, `${usesOf(project.materials, name)} materials`].filter(Boolean).join(' · '),
                  <Status tone={status.tone}>{status.text}</Status>,
                ]}
              />
            )
          })}
        </Table>
        {project.sheets.length === 0 ? <Note>No sheets listed. The materials draw from the placeholder until one is added.</Note> : null}
      </SettingsBlock>
      {chosen ? (
        <SettingsBlock
          title={sheetName(chosen.path)}
          action={<Action title="Remove from project" tone="danger" onClick={() => void unlistSheet(host, session, sheetName(chosen.path)).then(() => onSelect(null)).catch((error: unknown) => notify(messageOf(error)))} />}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: 20, alignItems: 'start' }}>
            {loaded ? <SheetPreview src={previewOf(loaded)} width={loaded.image.width} height={loaded.image.height} scale={loaded.image.width > 320 ? 1 : 2} alt={sheetName(chosen.path)} /> : <Note tone="warn">Not loaded: {statusOf(chosen).text}</Note>}
            <FieldGrid>
              <Field label="Path">
                <Row label="" value={chosen.path} muted />
              </Field>
              <Field label="Terrain set">
                <Row label="" value={chosen.terrainSet ?? 'none — add a terrain to make one'} muted />
              </Field>
              <Field label="Tile size" hint="Pixels per tile the sheet was authored at">
                <NumberInput value={chosen.tile} min={1} max={256} onChange={(tile) => void setSheetTile(host, session, sheetName(chosen.path), tile).catch((error: unknown) => notify(messageOf(error)))} />
              </Field>
              <Field label="Grid">
                <Row label="" value={loaded ? `${loaded.set.columns} × ${loaded.set.rows} tiles` : '—'} muted />
              </Field>
            </FieldGrid>
          </div>
          <Note>Removing a sheet keeps the file on disk and unlists it; materials that point into it draw from the placeholder or as flat colour until relinked.</Note>
        </SettingsBlock>
      ) : null}
    </>
  )
}

// --- Terrain sets -------------------------------------------------------------

const TERRAIN_COLOURS = ['#6aa84f', '#8b6b45', '#8e8e8e', '#d9c27e', '#b08f5e', '#5f8fb0', '#a06060', '#7a6a52']

function TerrainsSettings({ session, sets }: { session: Session; sets: readonly LoadedSet[] }) {
  const host = useHost()
  const project = useProject((p) => p)
  const missing = useViewportSelector((snapshot) => snapshot.context.stats.missingTransitions)
  const mapName = useProjectSelector((snapshot) => snapshot.context.map)
  const [chosen, setChosen] = useState<{ sheet: string; terrain: string } | null>(null)
  const [newName, setNewName] = useState('')
  const notify = (notice: string): void => void run(host, 'view.set', { notice })
  const write = (sheet: string, next: LoadedSet['set']): void => void updateTerrainSet(host, session, sheet, next).catch((error: unknown) => notify(messageOf(error)))
  const withSidecar = project.sheets.filter((s) => s.terrainSet !== null)
  return (
    <>
      <SettingsBlock note="One set per sheet: what each tile is, tagged by corner. Stored beside the image as <sheet>.terrain.json, so an artist's sheet travels with its tags. Tagging tiles in the editor is a follow-up; a set's terrains are managed here." />
      {sets.map((loaded) => {
        const { set } = loaded
        const entry = withSidecar.find((s) => sheetName(s.path) === set.sheet)
        const selected = chosen?.sheet === set.sheet ? set.terrains.find((t) => t.id === chosen.terrain) : undefined
        const add = (): void => {
          const label = newName.trim()
          if (!label) return
          const id = slugOf(label)
          if (set.terrains.some((t) => t.id === id)) {
            notify(`${set.sheet} already has a terrain called ${id}.`)
            return
          }
          setNewName('')
          write(set.sheet, addTerrain(set, { id, name: label, color: TERRAIN_COLOURS[set.terrains.length % TERRAIN_COLOURS.length] }))
          setChosen({ sheet: set.sheet, terrain: id })
        }
        const change = (terrain: TerrainDef, changes: Partial<TerrainDef>): void => write(set.sheet, { ...set, terrains: set.terrains.map((t) => (t.id === terrain.id ? { ...t, ...changes } : t)) })
        return (
          <SettingsBlock
            key={set.sheet}
            title={entry ? sheetName(entry.terrainSet ?? '') : set.sheet}
            note={`${set.sheet} · ${set.tile} px · ${set.columns} × ${set.rows} tiles`}
            action={
              <>
                <TextInput value={chosen?.sheet === set.sheet || sets.length === 1 ? newName : ''} onChange={(v) => { setChosen({ sheet: set.sheet, terrain: chosen?.sheet === set.sheet ? chosen.terrain : '' }); setNewName(v) }} placeholder="New terrain" />
                <Action title="Add terrain" disabled={!newName.trim() || (chosen?.sheet !== set.sheet && sets.length > 1)} onClick={add} />
              </>
            }
          >
            <Table
              columns={[
                { title: 'Terrain', width: '1.2fr' },
                { title: 'Id', width: '0.9fr' },
                { title: 'Edge set', width: '0.8fr' },
                { title: 'Pairs', width: '0.7fr' },
                { title: 'Materials', width: '1fr' },
              ]}
            >
              {set.terrains.map((t) => {
                const coverage = edgeCoverage(set, t.id)
                const pairs = set.terrains.filter((o) => o.id !== t.id && pairAuthored(set, t.id, o.id)).length
                const users = project.materials.filter((m) => (m.top.sheet === set.sheet && m.top.terrain === t.id) || (m.side?.sheet === set.sheet && m.side.terrain === t.id)).map((m) => m.name)
                return (
                  <TableRow
                    key={t.id}
                    active={selected?.id === t.id}
                    onClick={() => setChosen({ sheet: set.sheet, terrain: t.id })}
                    cells={[
                      <>
                        <Swatch color={t.color} />
                        {t.name}
                      </>,
                      <code>{t.id}</code>,
                      <Status tone={coverage === 16 ? 'ok' : coverage === 0 ? 'muted' : 'warn'}>{coverage} / 16</Status>,
                      `${pairs}`,
                      users.length ? users.join(', ') : <Status tone="muted">none</Status>,
                    ]}
                  />
                )
              })}
            </Table>
            {selected ? (
              <FieldGrid columns={3}>
                <Field label="Name">
                  <TextInput value={selected.name} onChange={(label) => (label.trim() ? change(selected, { name: label }) : undefined)} />
                </Field>
                <Field label="Colour" hint="The swatch, and the fill where no tile is tagged">
                  <ColorInput value={parseInt(selected.color.slice(1), 16)} onChange={(color) => change(selected, { color: `#${color.toString(16).padStart(6, '0')}` })} />
                </Field>
                <Field label="Id" hint="What tags and materials name; fixed once tiles carry it">
                  <Row label="" value={selected.id} muted />
                </Field>
              </FieldGrid>
            ) : null}
          </SettingsBlock>
        )
      })}
      {sets.length === 0 ? <Note>No sheet with a terrain set is loaded. Add one in Sheets, or add a terrain to a sheet to give it a set.</Note> : null}
      <SettingsBlock title="Transitions" note={`Corners painted in ${mapName ? mapLabel(mapName) : 'this map'} that no tile is tagged for, drawn as composites: the tiles still to author. The status bar counts the same list.`}>
        {missing.length === 0 ? (
          <Note>Every corner in this map has an authored tile.</Note>
        ) : (
          <Table
            columns={[
              { title: 'Corner', width: '2fr' },
              { title: 'Drawn as', width: '1fr' },
            ]}
          >
            {missing.map((combo) => (
              <TableRow key={combo} cells={[<code>{combo}</code>, <Status tone="accent">composite, to author</Status>]} />
            ))}
          </Table>
        )}
      </SettingsBlock>
    </>
  )
}

// --- Camera rig ---------------------------------------------------------------

function CameraSettings() {
  const host = useHost()
  const camera = useProject((p) => p.camera)
  return (
    <SettingsBlock title="The rig every new map starts from" note="A map keeps its own rig once it exists; this is the default a new map is given. The game's camera bounds ship in the export.">
      <CameraRigProperties rig={camera} onChange={(changes) => run(host, 'project.set', { camera: { ...camera, ...changes, bounds: { ...camera.bounds, ...(changes.bounds ?? {}) } } })} />
    </SettingsBlock>
  )
}
