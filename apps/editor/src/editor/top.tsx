/**
 * The top bar: the project and the map, undo and redo, the view toggles,
 * save and export, and play. The project's name opens its menu: the maps,
 * a new map, closing it.
 *
 * It selects the handful of values it shows and nothing else, so it does not
 * re-render while the pointer moves or a stroke paints. File actions read the
 * document at the moment they run rather than subscribing to it, and say what
 * happened through the view actor's `notice`, which the inspector shows.
 */

import { useState, useSyncExternalStore } from 'react'

import type { ReadonlyMapDoc, ReadonlyProjectDoc } from '@papercut/document'
import { useDocumentSelector, useHost, useHostSelector, useProject, useProjectSelector, useViewSelector } from '@papercut/editor-host'
import { chordFor, type Platform } from '@papercut/registry'
import { exportGltf } from '@papercut/runtime/export'
import { Action, Brand, Dialog, Field, Menu, MenuDivider, MenuItem, MenuLabel, TextInput, TopButton, TopCrumb, TopGroup, TopGrow, TopSep } from '@papercut/ui'

import { artFor } from './art'
import { run } from './commands'
import { encodePngWithCanvas } from './rgba'
import { closeProject, newMapIn, openMapAt, saveNow, type Session } from './session'

const nameOf = (doc: ReadonlyMapDoc): string => doc.name
const projectNameOf = (project: ReadonlyProjectDoc): string => project.name
const mapsOf = (project: ReadonlyProjectDoc): readonly string[] => project.maps
/** A map's name as the menu lists it, from its path: `maps/harbour-road.map.json` → `harbour-road`. */
const mapLabel = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.map\.json$/, '')

/** Hand the browser a file to save. */
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

const slug = (name: string): string => name.replace(/\s+/g, '-').toLowerCase()
const isPlaying = (snapshot: { value: unknown }): boolean => snapshot.value === 'play'

export function TopBar({ platform, session }: { platform: Platform; session: Session }) {
  const host = useHost()
  const { reader } = host
  const name = useDocumentSelector(nameOf, { equal: Object.is })
  const projectName = useProject(projectNameOf)
  const maps = useProject(mapsOf)
  const current = useProjectSelector((snapshot) => snapshot.context.map)
  const [naming, setNaming] = useState<string | null>(null)
  const canUndo = useSyncExternalStore(reader.subscribe, () => reader.canUndo())
  const canRedo = useSyncExternalStore(reader.subscribe, () => reader.canRedo())
  const showGrid = useViewSelector((snapshot) => snapshot.context.showGrid)
  const gameCamera = useViewSelector((snapshot) => snapshot.context.gameCamera)
  const playing = useHostSelector(isPlaying)

  const notify = (notice: string): void => run(host, 'view.set', { notice })
  const attempt = (work: Promise<unknown>, done: string): void => {
    work.then(() => notify(done)).catch((error: unknown) => notify(error instanceof Error ? error.message : String(error)))
  }

  const onSave = (): void => attempt(saveNow(host, session), 'Saved')
  const onNewMap = (): void => {
    const mapName = naming?.trim()
    setNaming(null)
    if (mapName) attempt(newMapIn(host, session, mapName), `New map ${mapName}`)
  }

  const onExport = async (): Promise<void> => {
    notify('Exporting…')
    try {
      const doc = reader.doc
      const project = host.children.project.getSnapshot().context.project
      // The generated terrain set, as before #47 when the exporter generated its own: an artist's loaded set still
      // previews but does not export.
      const art = artFor(project)
      const bytes = await exportGltf(doc, { merge: false, textures: art.textures, terrain: art.generatedTerrain, materials: project.materials, resolution: project.resolution, sprites: art.sprites, encodePng: encodePngWithCanvas })
      const blob = new Blob([bytes], { type: 'model/gltf-binary' })
      const file = `${slug(doc.name)}.glb`
      download(blob, file)
      notify(`Exported ${file} (${(blob.size / 1024).toFixed(0)} KB)`)
    } catch (error) {
      notify(`Export failed: ${String(error)}`)
    }
  }

  return (
    <>
      <Brand name="papercut" level={name}>
        <Menu trigger={<TopCrumb label={projectName} title="The project: its maps and settings" />}>
        <MenuLabel>Maps</MenuLabel>
        {maps.map((path) => (
          <MenuItem key={path} icon="map" title={mapLabel(path)} active={path === current} meta={path === current ? 'open' : undefined} onClick={() => attempt(openMapAt(host, session, path), `Opened ${mapLabel(path)}`)} />
        ))}
        <MenuDivider />
        <MenuItem icon="plus" title="New map…" onClick={() => setNaming('')} />
        <MenuDivider />
          <MenuItem icon="settings" title="Project settings…" kbd={chordFor('view.set', { settings: 'general' }, platform)} onClick={() => run(host, 'view.set', { settings: 'general' })} />
          <MenuItem icon="close" title="Close project" onClick={() => attempt(closeProject(host, session), 'Closed')} />
        </Menu>
      </Brand>
      <Dialog
        opened={naming !== null}
        onClose={() => setNaming(null)}
        title="New map"
        description="An empty 32 × 32 map, listed after the others and opened."
        footer={
          <>
            <Action title="Cancel" onClick={() => setNaming(null)} />
            <Action title="Create map" tone="accent" disabled={!naming?.trim()} onClick={onNewMap} />
          </>
        }
      >
        <Field label="Name">
          <TextInput value={naming ?? ''} onChange={setNaming} placeholder="Harbour Road" />
        </Field>
      </Dialog>
      <TopGrow />
      <TopGroup>
        <TopButton icon="undo" title="Undo" kbd={chordFor('undo', undefined, platform)} disabled={!canUndo} onClick={() => run(host, 'undo')} />
        <TopButton icon="redo" title="Redo" kbd={chordFor('redo', undefined, platform)} disabled={!canRedo} onClick={() => run(host, 'redo')} />
        <TopSep />
        <TopButton icon="frameAll" title="Reset view — frame the whole level" onClick={() => run(host, 'viewport.frame')} />
        <TopButton icon="sweep" title="Sweep — fly the game camera through its bounds" onClick={() => run(host, 'viewport.sweep')} />
        <TopSep />
        <TopButton icon="grid" title={showGrid ? 'Hide the grid' : 'Show the grid'} active={showGrid} onClick={() => run(host, 'view.set', { showGrid: !showGrid })} />
        <TopButton
          icon="camera"
          title={gameCamera ? 'Free the camera' : "Clamp the view to the game's camera bounds"}
          kbd={chordFor('view.set', { gameCamera: !gameCamera }, platform)}
          active={gameCamera}
          onClick={() => run(host, 'view.set', { gameCamera: !gameCamera })}
        />
      </TopGroup>
      <TopGrow />
      <TopGroup>
        <TopButton icon="save" title="Save" labelled onClick={onSave} />
        <TopButton icon="export" title="Export glTF" labelled onClick={() => void onExport()} />
      </TopGroup>
      <TopButton
        icon={playing ? 'stop' : 'play'}
        title={playing ? 'Stop' : 'Play'}
        kbd={chordFor(playing ? 'mode.edit' : 'mode.play', undefined, platform)}
        primary
        onClick={() => run(host, playing ? 'mode.edit' : 'mode.play')}
      />
    </>
  )
}
