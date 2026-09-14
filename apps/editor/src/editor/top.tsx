/**
 * The top bar: the level's name, undo and redo, the view toggles, file
 * actions, and play.
 *
 * It selects the handful of values it shows and nothing else, so it does not
 * re-render while the pointer moves or a stroke paints. File actions read the
 * document at the moment they run rather than subscribing to it, and say what
 * happened through the view actor's `notice`, which the inspector shows.
 */

import { useSyncExternalStore } from 'react'

import { serialize, type ReadonlyMapDoc } from '@papercut/document'
import { useDocumentSelector, useHost, useHostSelector, useViewSelector } from '@papercut/editor-host'
import { chordFor, type Platform } from '@papercut/registry'
import { exportGltf } from '@papercut/runtime/export'
import { Brand, FileButton, TopButton, TopGroup, TopGrow, TopSep } from '@papercut/ui'

import { artFor } from './art'
import { refusal, run } from './commands'
import { encodePngWithCanvas } from './rgba'

const nameOf = (doc: ReadonlyMapDoc): string => doc.name
const isPlaying = (snapshot: { value: unknown }): boolean => snapshot.value === 'play'

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

export function TopBar({ platform }: { platform: Platform }) {
  const host = useHost()
  const { reader } = host
  const name = useDocumentSelector(nameOf, { equal: Object.is })
  const canUndo = useSyncExternalStore(reader.subscribe, () => reader.canUndo())
  const canRedo = useSyncExternalStore(reader.subscribe, () => reader.canRedo())
  const showGrid = useViewSelector((snapshot) => snapshot.context.showGrid)
  const gameCamera = useViewSelector((snapshot) => snapshot.context.gameCamera)
  const playing = useHostSelector(isPlaying)

  const notify = (notice: string): void => run(host, 'view.set', { notice })

  const onSave = (): void => {
    const doc = reader.doc
    const file = `${slug(doc.name)}.map.json`
    download(new Blob([serialize(doc)], { type: 'application/json' }), file)
    notify(`Saved ${file}`)
  }

  const onLoad = async (file: File): Promise<void> => {
    // The file's TEXT is the argument (#2: plain serialisable data). A map that will not parse comes back as an
    // `invalid-args` refusal carrying the load error's own message, which is what the artist is shown. The viewport
    // notices the new document itself, off `reader.generation`.
    const why = refusal(host.dispatch('document.load', { json: await file.text() }))
    notify(why ?? `Loaded ${file.name}`)
  }

  const onExport = async (): Promise<void> => {
    notify('Exporting…')
    try {
      const doc = reader.doc
      // The generated terrain set, as before #47 when the exporter generated its own: an artist's loaded set still
      // previews but does not export.
      const art = artFor(doc)
      const bytes = await exportGltf(doc, { merge: false, textures: art.textures, terrain: art.generatedTerrain, sprites: art.sprites, encodePng: encodePngWithCanvas })
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
      <Brand name="papercut" level={name} />
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
        <FileButton icon="open" title="Load" accept=".json,application/json" onFile={(file) => void onLoad(file)} />
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
