import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import {
  LoadError,
  SURFACE_CLIFF,
  brushCells,
  cellIndex,
  countDormant,
  describeSurface,
  deserialize,
  flatten,
  inBounds,
  raise,
  removeObject,
  serialize,
  updateObject,
  type Atmosphere,
  type CameraRig,
  type EditorStore,
  type MapObject,
  type RgbaImage,
  type SurfaceAddress,
} from '@map-editor/document'
import {
  useHost,
  useHostSelector,
  useToolsSelector,
  useViewSelector,
  type Host,
  type ToolSettings,
  type ViewSettings,
} from '@map-editor/editor-host'
// The brush preview draws the cells a terrain stroke will touch, so it calls
// the same function the stroke does (`feature-terrain`'s, the one
// implementation). An app is the only thing that may import a feature (#35),
// and this file is an app.
import { strokeCells } from '@map-editor/feature-terrain'
// The canvas-drawing generator lives behind its own subpath (#48): re-exporting it
// from the package root would force `DOM` into every consumer's tsconfig, including
// `apps/export-cli`'s, whose whole point is compiling without it.
import { generateSprites, generateTerrainSheet } from '@map-editor/fixtures/textures'
import { exportGltf } from '@map-editor/runtime/export'
import { Note } from '@map-editor/ui'
import {
  AtmospherePanel,
  CameraPanel,
  CoveragePanel,
  ObjectInspector,
  Outliner,
  ToolPanel,
} from './panels'
import { saveAutosave } from './autosave'
import type { EditorState } from './state'
import { encodePngWithCanvas } from './rgba'
import { loadSheetFromFile } from './sheet'
import { Viewport } from '@map-editor/viewport'

/** The eleven tool parameters, which is exactly what `tools.set` takes. */
const TOOL_FIELDS = [
  'tool',
  'terrainMode',
  'sculptVerb',
  'paintVerb',
  'strokeShape',
  'brush',
  'material',
  'tile',
  'tint',
  'rampDir',
  'spriteName',
] as const satisfies ReadonlyArray<keyof ToolSettings & keyof EditorState>

const VIEW_FIELDS = ['showGrid', 'gameCamera', 'inspector'] as const satisfies ReadonlyArray<
  keyof ViewSettings & keyof EditorState
>

/**
 * Pull the keys a command owns out of a `set` patch, dropping the ones that
 * are absent. The schemas are `.strict()` with `exactOptional` fields (#23):
 * a key present with the value `undefined` is refused just as loudly as a
 * stray one, so "absent" has to mean absent.
 */
function pick<K extends keyof EditorState>(changes: Partial<EditorState>, keys: readonly K[]): Partial<Pick<EditorState, K>> {
  const out: Partial<Pick<EditorState, K>> = {}
  for (const key of keys) if (changes[key] !== undefined) out[key] = changes[key]
  return out
}

/**
 * `dispatch` never throws (#8) — it answers with a result — so a refusal has
 * to be looked at or it is swallowed. Every call below is the app dispatching
 * its own declared command with arguments it built, so a refusal is a bug
 * here rather than anything a user did.
 */
function report(id: string, result: ReturnType<Host['dispatch']>): void {
  if (result.ok) return
  const why = result.kind === 'invalid-args' ? result.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') : result.reason
  console.warn(`[editor] ${id} refused: ${result.kind} — ${why}`)
}

export default function App({ store }: { store: EditorStore }) {
  // Built at the composition root (`main.tsx`), never here: the viewport is
  // handed `host.input` before React has rendered anything.
  const host = useHost()

  const revision = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const doc = store.reader.doc
  void revision // the document is mutated in place; revision is the signal

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<Viewport | null>(null)

  // `EditorState`'s sixteen fields are no longer a `useState`: eleven belong
  // to the host's tools actor, four to its view actor, and `playing` IS the
  // host's mode. What is assembled here is a VIEW of those three snapshots in
  // the shape the panels already take. One owner per field, so nothing has to
  // be mirrored — the stroke actor reads the same tool parameters the panels
  // show, and the eyedropper writing a tile back is a `tools.set` that
  // re-renders this by the ordinary route. Selecting the whole snapshot is
  // deliberate: its identity is stable between transitions, so this
  // re-renders exactly when one of the three actors moves.
  const toolsSnapshot = useToolsSelector((snapshot) => snapshot)
  const viewSnapshot = useViewSelector((snapshot) => snapshot)
  const playing = useHostSelector((snapshot) => snapshot.value === 'play')

  const state = useMemo<EditorState>(
    () => ({ ...toolsSnapshot.context, terrainMode: toolsSnapshot.value, ...viewSnapshot.context, playing }),
    [toolsSnapshot, viewSnapshot, playing],
  )
  const stateRef = useRef(state)
  stateRef.current = state

  const [hover, setHover] = useState<SurfaceAddress | null>(null)
  const [hoverCells, setHoverCells] = useState<Array<[number, number]>>([])
  const [camera, setCamera] = useState({ yaw: 45, pitch: 35, distance: 26, inBounds: true })
  const [stats, setStats] = useState({ fps: 0, triangles: 0, meshMs: 0 })
  const [softwareRenderer, setSoftwareRenderer] = useState(false)
  const [sheet, setSheet] = useState<RgbaImage | null>(null)
  const [sheetWarning, setSheetWarning] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  /**
   * The panels' one write verb, unchanged in shape and now ROUTED rather than
   * stored: each group of fields goes to the command that owns it, and a
   * panel needs to know nothing about which actor that is.
   */
  const set = useCallback(
    (changes: Partial<EditorState>) => {
      const tools = pick(changes, TOOL_FIELDS)
      if (Object.keys(tools).length > 0) report('tools.set', host.dispatch('tools.set', tools))

      const view = pick(changes, VIEW_FIELDS)
      if (Object.keys(view).length > 0) report('view.set', host.dispatch('view.set', view))

      // `in`, not a truthiness test: clearing the selection is `null`.
      if ('selectedObjectId' in changes) report('selection.set', host.dispatch('selection.set', { id: changes.selectedObjectId ?? null }))

      if (changes.playing !== undefined) {
        const id = changes.playing ? 'mode.play' : 'mode.edit'
        report(id, host.dispatch(id))
      }
    },
    [host],
  )

  // --- the placeholder art --------------------------------------------------
  // Generated here, in the composition root, and handed to the viewport and
  // the exporter as inputs: `runtime` has no way to draw its own (#47). Memos
  // rather than an effect so the viewport below can be constructed with them
  // in the same commit; the effects then push replacements when the document's
  // materials or texel density change. An artist's sheet, loaded further down,
  // overrides the generated one until the next such change.
  const generatedSheet = useMemo(
    () => generateTerrainSheet(doc.materials, doc.texelDensity),
    [doc.materials, doc.texelDensity],
  )
  const sprites = useMemo(() => generateSprites(doc.texelDensity), [doc.texelDensity])

  useEffect(() => {
    setSheet(generatedSheet)
    setSheetWarning(null)
    viewportRef.current?.loadSheet(generatedSheet)
  }, [generatedSheet])

  useEffect(() => {
    viewportRef.current?.loadSprites(sprites)
  }, [sprites])

  // --- viewport lifecycle ---------------------------------------------------
  useEffect(() => {
    if (!canvasRef.current) return
    // Pointer input is not a command: it goes straight to the host's gesture
    // actor, which answers with what the press turned out to be (#11). What
    // used to be here — a `strokeRef` holding the anchor, the flatten height
    // and the last cell, and a rectangle's release commit — is the stroke
    // actor's context now, and dies with the stroke.
    const viewport = new Viewport(canvasRef.current, store, { sheet: generatedSheet, sprites }, {
      onPointerDown: (press) => {
        host.input.pointerDown(press)
      },
      onPointerMove: (motion) => host.input.pointerMove(motion),
      onPointerUp: (release) => host.input.pointerUp(release),
      onStrokeMove: (pick, modifiers) => host.input.strokeMove(pick, modifiers),
      onKeyDown: (key) => host.input.keyDown(key),
      onKeyUp: (key) => host.input.keyUp(key),
      heldKeys: () => host.input.heldKeys(),
      onHover: (pick) => {
        setHover(pick.surface)
        const current = stateRef.current
        if (pick.surface && current.tool === 'terrain' && !current.playing) {
          // The same cells the stroke will touch, grown from the same origin
          // — read off the open stroke rather than recomputed from a copy.
          setHoverCells(strokeCells(store.reader.doc, current, pick.surface, host.input.strokeOrigin()))
        } else {
          setHoverCells([])
        }
      },
      onCameraChange: (next) =>
        setCamera((previous) =>
          Math.abs(previous.yaw - next.yaw) < 0.01 &&
          Math.abs(previous.pitch - next.pitch) < 0.01 &&
          Math.abs(previous.distance - next.distance) < 0.01 &&
          previous.inBounds === next.inBounds
            ? previous
            : next,
        ),
      onStats: setStats,
    })
    viewportRef.current = viewport
    setSoftwareRenderer(viewport.softwareRenderer)
    // Scripting hooks. scripts/tour.mjs and scripts/probe.mjs drive the real
    // editor in a headless browser; these are also handy from the console.
    // Nothing in the app reads them.
    const scripting = window as unknown as Record<string, unknown>
    scripting.__viewport = viewport
    scripting.__store = store
    scripting.__ops = { flatten, raise, removeObject, updateObject }
    scripting.__selectObject = (id: string | null) => set({ selectedObjectId: id })
    viewport.frameMap()
    return () => {
      viewport.dispose()
      viewportRef.current = null
    }
    // Intentionally created once: the viewport reads live state through refs.
  }, [])

  // --- keyboard -------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return

      const key = event.key.toLowerCase()
      if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) store.redo()
        else store.undo()
        return
      }

      switch (key) {
        case '1':
          set({ tool: 'terrain' })
          break
        case '2':
          set({ tool: 'object' })
          break
        case '3':
          set({ tool: 'camera', inspector: 'coverage' })
          break
        case 'tab':
          event.preventDefault()
          set({ terrainMode: stateRef.current.terrainMode === 'sculpt' ? 'paint' : 'sculpt' })
          break
        case '[':
          set({ brush: { ...stateRef.current.brush, size: Math.max(1, stateRef.current.brush.size - 1) } })
          break
        case ']':
          set({ brush: { ...stateRef.current.brush, size: Math.min(12, stateRef.current.brush.size + 1) } })
          break
        case 'g':
          set({ gameCamera: !stateRef.current.gameCamera })
          break
        case 'p':
          set({ playing: !stateRef.current.playing })
          break
        case 'delete':
        case 'backspace': {
          // Nothing during a drag. `keydown` is on `window` and pointer
          // capture does not stop it, so this fires mid-stroke — and the
          // object tool drags the SELECTED object, which is the one this
          // would delete. The store refuses a concurrent write at an address
          // the open stroke owns, so the delete would not land; clearing the
          // selection anyway would leave the panel pointing at nothing while
          // the object is still there. Let go of the mouse first.
          if (store.inStroke) break
          const id = stateRef.current.selectedObjectId
          if (id && store.reader.doc.objects[id]) {
            store.apply('Delete object', removeObject(store.reader.doc, id))
            set({ selectedObjectId: null })
          }
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [set, store])

  // --- push editor state into the viewport ----------------------------------
  useEffect(() => {
    viewportRef.current?.setOptions({
      brushPreview: state.tool === 'terrain' && !state.playing ? hoverCells : [],
      showGrid: state.showGrid,
      gameCamera: state.gameCamera,
      playing: state.playing,
      hover: state.tool === 'terrain' ? hover : null,
      selectedObjectId: state.selectedObjectId,
    })
  }, [state, hover, hoverCells])

  useEffect(() => {
    viewportRef.current?.refreshAtmosphere()
  }, [doc.atmosphere, revision])

  // --- autosave -------------------------------------------------------------
  useEffect(() => {
    const handle = setTimeout(() => saveAutosave(store.reader.doc), 1200)
    return () => clearTimeout(handle)
  }, [revision, store])

  // --- commands -------------------------------------------------------------
  const updateSelected = useCallback(
    (changes: Partial<MapObject>) => {
      const id = stateRef.current.selectedObjectId
      if (!id) return
      store.apply('Edit object', updateObject(store.reader.doc, id, changes))
    },
    [store],
  )

  const setRig = useCallback(
    (changes: Partial<CameraRig>) => {
      store.apply('Camera rig', [{ t: 'doc', field: 'camera', value: { ...store.reader.doc.camera, ...changes } }])
    },
    [store],
  )

  const setAtmosphere = useCallback(
    (changes: Partial<Atmosphere>) => {
      store.apply('Atmosphere', [
        { t: 'doc', field: 'atmosphere', value: { ...store.reader.doc.atmosphere, ...changes } },
      ])
      viewportRef.current?.refreshAtmosphere()
    },
    [store],
  )

  const onSave = useCallback(() => {
    const blob = new Blob([serialize(store.reader.doc)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${store.reader.doc.name.replace(/\s+/g, '-').toLowerCase()}.map.json`
    link.click()
    URL.revokeObjectURL(url)
    setMessage(`Saved ${link.download}`)
  }, [store])

  const onLoad = useCallback(
    async (file: File) => {
      try {
        const doc = deserialize(await file.text())
        store.replace(doc)
        viewportRef.current?.reset()
        viewportRef.current?.frameMap()
        setMessage(`Loaded ${file.name}`)
      } catch (error) {
        setMessage(error instanceof LoadError ? error.message : String(error))
      }
    },
    [store],
  )

  const onExport = useCallback(async () => {
    setMessage('Exporting…')
    try {
      // The generated sheet, as before #47 when the exporter generated its own:
      // an artist's loaded sheet still previews but does not export.
      const bytes = await exportGltf(store.reader.doc, {
        merge: false,
        sheet: generatedSheet,
        sprites,
        encodePng: encodePngWithCanvas,
      })
      const blob = new Blob([bytes], { type: 'model/gltf-binary' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${store.reader.doc.name.replace(/\s+/g, '-').toLowerCase()}.glb`
      link.click()
      URL.revokeObjectURL(url)
      setMessage(`Exported ${link.download} (${(blob.size / 1024).toFixed(0)} KB)`)
    } catch (error) {
      setMessage(`Export failed: ${String(error)}`)
    }
  }, [store, generatedSheet, sprites])

  const onLoadSheet = useCallback(
    async (file: File) => {
      try {
        const result = await loadSheetFromFile(file, store.reader.doc)
        setSheet(result.image)
        setSheetWarning(result.warning)
        viewportRef.current?.loadSheet(result.image)
      } catch (error) {
        setSheetWarning(String(error))
      }
    },
    [store],
  )

  const dormant = useMemo(() => {
    const d = store.reader.doc
    return countDormant(d.paint, (kind, key) => {
      const [x, y] = key.split(',').map(Number)
      if (!inBounds(d.size, x, y)) return false
      if (kind === 'top') return true
      const level = Number(key.split(',')[3])
      const height = d.terrain.height[cellIndex(d.size, x, y)]
      return level < height
    })
    // Keyed on the revision counter alone: the document is mutated in place,
    // so `store.reader.doc` never changes identity and would never retrigger this.
  }, [revision])

  const selected = state.selectedObjectId ? doc.objects[state.selectedObjectId] ?? null : null

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">{doc.name}</strong>
        <span className="toolbar-group">
          <button type="button" onClick={() => store.undo()} disabled={!store.reader.canUndo()}>
            Undo
          </button>
          <button type="button" onClick={() => store.redo()} disabled={!store.reader.canRedo()}>
            Redo
          </button>
        </span>
        <span className="toolbar-group">
          <button type="button" onClick={onSave}>
            Save
          </button>
          <label className="file-button">
            Load
            <input
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void onLoad(file)
                event.target.value = ''
              }}
            />
          </label>
          <button type="button" onClick={() => void onExport()}>
            Export glTF
          </button>
        </span>
        <span className="toolbar-group">
          <label className="toggle">
            <input
              type="checkbox"
              checked={state.showGrid}
              onChange={(event) => set({ showGrid: event.target.checked })}
            />
            Grid
          </label>
          <label className="toggle" title="G — clamp the view to the game's camera bounds">
            <input
              type="checkbox"
              checked={state.gameCamera}
              onChange={(event) => set({ gameCamera: event.target.checked })}
            />
            Game camera
          </label>
          <button
            type="button"
            className={state.playing ? 'active' : ''}
            onClick={() => set({ playing: !state.playing })}
            title="P — walk the map with WASD"
          >
            {state.playing ? 'Stop' : 'Play'}
          </button>
        </span>
      </header>

      <div className="body">
        <aside className="left">
          <ToolPanel
            doc={doc}
            state={state}
            sheet={sheet}
            set={set}
            onLoadSheet={(file) => void onLoadSheet(file)}
            sheetWarning={sheetWarning}
          />
        </aside>

        <main className="stage">
          <canvas ref={canvasRef} className={state.playing ? 'playing' : ''} />
          {!camera.inBounds && !state.playing ? (
            <div className="envelope-warning">
              Outside the game's camera envelope — press G to clamp
            </div>
          ) : null}
          {state.playing ? <div className="play-hint">WASD to walk · P to stop</div> : null}
        </main>

        <aside className="right">
          <nav className="tabs">
            {(['properties', 'coverage', 'atmosphere', 'outliner'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                className={state.inspector === tab ? 'active' : ''}
                onClick={() => set({ inspector: tab })}
              >
                {tab}
              </button>
            ))}
          </nav>

          {state.inspector === 'properties' ? (
            state.tool === 'camera' ? (
              <CameraPanel
                rig={doc.camera}
                onChange={setRig}
                onSweep={() => viewportRef.current?.startSweep()}
                onPreview={() => viewportRef.current?.applyRigDefaults()}
              />
            ) : (
              <ObjectInspector
                object={selected}
                onChange={updateSelected}
                onDelete={() => {
                  if (!selected) return
                  store.apply('Delete object', removeObject(store.reader.doc, selected.id))
                  set({ selectedObjectId: null })
                }}
              />
            )
          ) : null}

          {state.inspector === 'coverage' ? (
            <>
              <CameraPanel
                rig={doc.camera}
                onChange={setRig}
                onSweep={() => viewportRef.current?.startSweep()}
                onPreview={() => viewportRef.current?.applyRigDefaults()}
              />
              <CoveragePanel
                doc={doc}
                revision={revision}
                onSelect={(id) => set({ selectedObjectId: id, inspector: 'properties', tool: 'object' })}
                onFix={(id) => store.apply('Fix display mode', updateObject(store.reader.doc, id, { display: 'billboardY' }))}
              />
            </>
          ) : null}

          {state.inspector === 'atmosphere' ? (
            <AtmospherePanel atmosphere={doc.atmosphere} onChange={setAtmosphere} />
          ) : null}

          {state.inspector === 'outliner' ? (
            <Outliner
              doc={doc}
              selectedId={state.selectedObjectId}
              onSelect={(id) => set({ selectedObjectId: id, tool: 'object' })}
              onChange={(id, changes) => store.apply('Edit object', updateObject(store.reader.doc, id, changes))}
            />
          ) : null}

          {message ? (
            <div className="panel">
              <Note>{message}</Note>
            </div>
          ) : null}
        </aside>
      </div>

      <footer className="status">
        <span>{describeSurface(hover)}</span>
        <span>
          {hover && hover.kind === SURFACE_CLIFF ? 'paints by absolute level' : `${hoverCells.length} cells`}
        </span>
        <span title="Painted work that is currently hidden by geometry, and would come back">
          dormant paint: {dormant.top + dormant.cliff}
        </span>
        <span className={camera.inBounds ? '' : 'out'}>
          yaw {Math.round(camera.yaw)}° · pitch {Math.round(camera.pitch)}° · {camera.distance.toFixed(1)}u
        </span>
        <span>
          {stats.fps.toFixed(0)} fps · {(stats.triangles / 1000).toFixed(0)}k tris · mesh{' '}
          {stats.meshMs.toFixed(1)}ms
          {softwareRenderer ? ' · software GL, post-processing off' : ''}
        </span>
        {/* Gated on `canUndo`, not on the label: mid-drag the store refuses
            undo and reports `canUndo` false while `undoLabel` still names the
            entry underneath the stroke, so naming it here would advertise
            something the disabled button beside it will not do. */}
        <span>{store.reader.canUndo() ? store.reader.undoLabel() : 'nothing to undo'}</span>
      </footer>
    </div>
  )
}

/** Re-exported so the brush preview can be computed without importing ops here. */
export { brushCells }
