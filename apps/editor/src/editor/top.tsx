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

import { useSyncExternalStore } from 'react'

import type { ReadonlyMapDoc, ReadonlyProjectDoc } from '@papercut/document'
import { useDocumentSelector, useHost, useHostSelector, useProject, useProjectSelector, useViewSelector } from '@papercut/editor-host'
import { chordFor, type Platform } from '@papercut/registry'
import { Brand, Menu, MenuDivider, MenuItem, MenuLabel, TopButton, TopCrumb, TopGroup, TopGrow, TopSep } from '@papercut/ui'

import { run } from './commands'
import { closeProject, exportCurrentMap, openMapAt, revealInFolder, saveNow, type Session } from './session'

const nameOf = (doc: ReadonlyMapDoc): string => doc.name
const projectNameOf = (project: ReadonlyProjectDoc): string => project.name
const mapsOf = (project: ReadonlyProjectDoc): readonly string[] => project.maps
/** A map's name as the menu lists it, from its path: `maps/harbour-road.map.json` → `harbour-road`. */
const mapLabel = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.map\.json$/, '')

const isPlaying = (snapshot: { value: unknown }): boolean => snapshot.value === 'play'

export function TopBar({ platform, session }: { platform: Platform; session: Session }) {
  const host = useHost()
  const { reader } = host
  const name = useDocumentSelector(nameOf, { equal: Object.is })
  const projectName = useProject(projectNameOf)
  const maps = useProject(mapsOf)
  const current = useProjectSelector((snapshot) => snapshot.context.map)
  const summaries = useSyncExternalStore(session.summaries.subscribe, session.summaries.get)
  const sizeOf = (path: string): string | undefined => {
    const s = summaries.find((m) => m.path === path)
    return s && s.width > 0 ? `${s.width} × ${s.height}` : undefined
  }
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

  const onExport = (): void => {
    notify('Exporting…')
    attempt(exportCurrentMap(host, session).then((done) => notify(done)), 'Exported')
  }

  return (
    <>
      <Brand name="papercut" level={name}>
        <Menu trigger={<TopCrumb label={projectName} title="The project: its maps and settings" />}>
        <MenuLabel>Maps</MenuLabel>
        {maps.map((path) => (
          <MenuItem key={path} icon="map" title={mapLabel(path)} active={path === current} meta={path === current ? 'open' : sizeOf(path)} onClick={() => attempt(openMapAt(host, session, path), `Opened ${mapLabel(path)}`)} />
        ))}
        <MenuDivider />
        <MenuItem icon="plus" title="New map…" onClick={() => run(host, 'view.set', { dialog: 'new-map' })} />
        {session.dialogs ? <MenuItem icon="folder" title="Reveal in Finder" onClick={() => attempt(revealInFolder(host, current ?? 'papercut.json'), 'Revealed')} /> : null}
        <MenuDivider />
          <MenuItem icon="settings" title="Project settings…" kbd={chordFor('view.set', { settings: 'general' }, platform)} onClick={() => run(host, 'view.set', { settings: 'general' })} />
          <MenuItem icon="close" title="Close project" onClick={() => attempt(closeProject(host, session), 'Closed')} />
        </Menu>
      </Brand>
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
        <TopButton icon="export" title="Export glTF" labelled onClick={onExport} />
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
