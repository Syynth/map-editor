import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import {
  EditorStore,
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
  type MapObject,
  type RgbaImage,
  type SurfaceAddress,
} from '@map-editor/document'
import { createSampleMap, generateSprites, generateTerrainSheet } from '@map-editor/fixtures'
import type { PickResult } from '@map-editor/runtime'
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
import { initialEditorState, type EditorState } from './state'
import { applyStroke, strokeCells, type StrokeContext } from './tools'
import { encodePngWithCanvas } from './rgba'
import { loadSheetFromFile } from './sheet'
import { Viewport, type PointerModifiers } from '@map-editor/viewport'

const AUTOSAVE_KEY = 'map-editor:autosave'

function loadAutosave() {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY)
    if (text) return deserialize(text)
  } catch {
    // A corrupt or stale autosave should never stop the editor opening.
  }
  // Defaults look decent: a first run opens a landscape, not a flat plane.
  return createSampleMap()
}

export default function App() {
  // React 19's useRef demands an initial value, so the lazy-construct guard
  // below now carries the null itself.
  const storeRef = useRef<EditorStore | null>(null)
  if (!storeRef.current) storeRef.current = new EditorStore(loadAutosave())
  const store = storeRef.current

  const revision = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const doc = store.doc
  void revision // the document is mutated in place; revision is the signal

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<Viewport | null>(null)

  const [state, setStateRaw] = useState<EditorState>(initialEditorState)
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

  const strokeRef = useRef<StrokeContext | null>(null)

  const set = useCallback((changes: Partial<EditorState>) => {
    setStateRaw((previous) => ({ ...previous, ...changes }))
  }, [])

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
    const viewport = new Viewport(canvasRef.current, store, { sheet: generatedSheet, sprites }, {
      onStrokeStart: (pick, modifiers) => handleStroke(pick, modifiers, 'start'),
      onStrokeMove: (pick, modifiers) => handleStroke(pick, modifiers, 'move'),
      onStrokeEnd: () => {
        const context = strokeRef.current
        if (context) {
          // Rectangles commit once, on release.
          if (stateRef.current.strokeShape === 'rect' && context.anchor && hoverRef.current) {
            applyStroke(context, { surface: hoverRef.current, point: null, objectId: null, distance: 0 }, lastModifiers.current, 'end')
          }
          store.endStroke()
        }
        strokeRef.current = null
      },
      onHover: (pick) => {
        hoverRef.current = pick.surface
        setHover(pick.surface)
        const current = stateRef.current
        if (pick.surface && current.tool === 'terrain' && !current.playing) {
          setHoverCells(
            strokeCells(store.doc, current, pick.surface, strokeRef.current?.anchor ?? null),
          )
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

  const hoverRef = useRef<SurfaceAddress | null>(null)
  const lastModifiers = useRef<PointerModifiers>({ shift: false, alt: false, ctrl: false, button: 0 })

  const handleStroke = useCallback(
    (pick: PickResult, modifiers: PointerModifiers, phase: 'start' | 'move' | 'end') => {
      lastModifiers.current = modifiers
      const current = stateRef.current

      if (phase === 'start') {
        const address = pick.surface
        const anchorHeight =
          address && inBounds(store.doc.size, address.x, address.y)
            ? store.doc.terrain.height[cellIndex(store.doc.size, address.x, address.y)]
            : 0
        strokeRef.current = {
          store,
          state: current,
          setState: set,
          anchor: address ? [address.x, address.y] : null,
          anchorHeight,
          lastCell: null,
        }
        store.beginStroke('Edit')
      }

      const context = strokeRef.current
      if (!context) return
      context.state = current
      applyStroke(context, pick, modifiers, phase)
    },
    [set, store],
  )

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
          const id = stateRef.current.selectedObjectId
          if (id && store.doc.objects[id]) {
            store.apply('Delete object', removeObject(store.doc, id))
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
    const handle = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, serialize(store.doc))
      } catch {
        // Quota or a private window; autosave is a convenience, not a promise.
      }
    }, 1200)
    return () => clearTimeout(handle)
  }, [revision, store])

  // --- commands -------------------------------------------------------------
  const updateSelected = useCallback(
    (changes: Partial<MapObject>) => {
      const id = stateRef.current.selectedObjectId
      if (!id) return
      store.apply('Edit object', updateObject(store.doc, id, changes))
    },
    [store],
  )

  const setRig = useCallback(
    (changes: Partial<CameraRig>) => {
      store.apply('Camera rig', [{ t: 'doc', field: 'camera', value: { ...store.doc.camera, ...changes } }])
    },
    [store],
  )

  const setAtmosphere = useCallback(
    (changes: Partial<Atmosphere>) => {
      store.apply('Atmosphere', [
        { t: 'doc', field: 'atmosphere', value: { ...store.doc.atmosphere, ...changes } },
      ])
      viewportRef.current?.refreshAtmosphere()
    },
    [store],
  )

  const onSave = useCallback(() => {
    const blob = new Blob([serialize(store.doc)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${store.doc.name.replace(/\s+/g, '-').toLowerCase()}.map.json`
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
      const bytes = await exportGltf(store.doc, {
        merge: false,
        sheet: generatedSheet,
        sprites,
        encodePng: encodePngWithCanvas,
      })
      const blob = new Blob([bytes], { type: 'model/gltf-binary' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${store.doc.name.replace(/\s+/g, '-').toLowerCase()}.glb`
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
        const result = await loadSheetFromFile(file, store.doc)
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
    const d = store.doc
    return countDormant(d.paint, (kind, key) => {
      const [x, y] = key.split(',').map(Number)
      if (!inBounds(d.size, x, y)) return false
      if (kind === 'top') return true
      const level = Number(key.split(',')[3])
      const height = d.terrain.height[cellIndex(d.size, x, y)]
      return level < height
    })
    // Keyed on the revision counter alone: the document is mutated in place,
    // so `store.doc` never changes identity and would never retrigger this.
  }, [revision])

  const selected = state.selectedObjectId ? doc.objects[state.selectedObjectId] ?? null : null

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">{doc.name}</strong>
        <span className="toolbar-group">
          <button type="button" onClick={() => store.undo()} disabled={!store.history.canUndo()}>
            Undo
          </button>
          <button type="button" onClick={() => store.redo()} disabled={!store.history.canRedo()}>
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
                  store.apply('Delete object', removeObject(store.doc, selected.id))
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
                onFix={(id) => store.apply('Fix display mode', updateObject(store.doc, id, { display: 'billboardY' }))}
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
              onChange={(id, changes) => store.apply('Edit object', updateObject(store.doc, id, changes))}
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
        <span>{store.history.undoLabel() ?? 'nothing to undo'}</span>
      </footer>
    </div>
  )
}

/** Re-exported so the brush preview can be computed without importing ops here. */
export { brushCells }
