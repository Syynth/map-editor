import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import {
  SURFACE_CLIFF,
  cellIndex,
  countDormant,
  describeSurface,
  inBounds,
  serialize,
  type Atmosphere,
  type CameraRig,
  type MapObject,
  type ReadonlyMapDoc,
  type RgbaImage,
  type SurfaceAddress,
} from '@map-editor/document'
import {
  useDocument,
  useHost,
  useHostSelector,
  useToolsSelector,
  useViewSelector,
  type Host,
  type ToolsSnapshot,
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
import { encodePngWithCanvas } from './rgba'
import { installKeyDispatcher } from './keys'
import { loadSheetFromFile } from './sheet'
import { Viewport } from '@map-editor/viewport'

/**
 * Selectors, at module scope so they are the same function every render:
 * `useSelector` compares what a selector RETURNS, and a snapshot's identity is
 * stable between transitions, so selecting the whole snapshot re-renders
 * exactly when that actor moves. `useDocument`'s selectors are here for a
 * sharper reason — it memoises on `[reader, revision, selector]`, so an inline
 * arrow recomputes on every render and a module-level one recomputes only when
 * the document changed.
 */
const snapshotOf = <T,>(snapshot: T): T => snapshot
const isPlaying = (snapshot: { value: unknown }): boolean => snapshot.value === 'play'
const wholeDocument = (doc: ReadonlyMapDoc): ReadonlyMapDoc => doc

/**
 * Painted work that geometry currently hides. Counted per revision rather than
 * per render: it walks every painted address, and the document is mutated in
 * place, so nothing else about it would tell a memo to recompute.
 */
function dormantPaint(doc: ReadonlyMapDoc): { top: number; cliff: number } {
  return countDormant(doc.paint, (kind, key) => {
    const [x, y] = key.split(',').map(Number)
    if (!inBounds(doc.size, x, y)) return false
    if (kind === 'top') return true
    const level = Number(key.split(',')[3])
    return level < doc.terrain.height[cellIndex(doc.size, x, y)]
  })
}

/** What a refusal says, flattened to one line; `null` when there was none. */
function refusal(result: ReturnType<Host['dispatch']>): string | null {
  if (result.ok) return null
  return result.kind === 'invalid-args'
    ? result.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    : result.reason
}

/**
 * `dispatch` never throws (#8) — it answers with a result — so a refusal has
 * to be looked at or it is swallowed. Every call routed through here is the
 * app dispatching its own declared command with arguments it built, so a
 * refusal is a bug here rather than anything a user did; the one refusal a
 * user CAN cause, a malformed map file, is read off the result instead and
 * shown to them.
 */
function report(id: string, result: ReturnType<Host['dispatch']>): void {
  const why = refusal(result)
  if (why !== null) console.warn(`[editor] ${id} refused: ${why}`)
}

export default function App() {
  // Built at the composition root (`main.tsx`), never here: the viewport is
  // handed `host.input` before React has rendered anything, and a host built
  // by a hook is rebuilt when React remounts.
  const host = useHost()
  const { reader } = host

  // `EditorState`'s eighteen fields are gone (#11, #66 step 7): eleven belong
  // to the host's tools actor, four to its view actor, and `playing` IS the
  // host's mode. Nothing is mirrored — the stroke actor reads the same tool
  // parameters the panels show, and the eyedropper writing a tile back is a
  // `tools.set` that re-renders this by the ordinary route.
  const toolsSnapshot = useToolsSelector(snapshotOf)
  const viewSnapshot = useViewSelector(snapshotOf)
  const playing = useHostSelector(isPlaying)
  const view = viewSnapshot.context
  const params = useMemo<ToolsSnapshot>(
    () => ({ ...toolsSnapshot.context, terrainMode: toolsSnapshot.value }),
    [toolsSnapshot],
  )

  const doc = useDocument(wholeDocument)
  const dormant = useDocument(dormantPaint)
  // The revision itself, for the effects that fire on ANY change: the document
  // is mutated in place, so it is the only thing about it that moves.
  const revision = useSyncExternalStore(reader.subscribe, reader.getSnapshot)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<Viewport | null>(null)

  const [hover, setHover] = useState<SurfaceAddress | null>(null)
  const [hoverCells, setHoverCells] = useState<Array<[number, number]>>([])
  const [camera, setCamera] = useState({ yaw: 45, pitch: 35, distance: 26, inBounds: true })
  const [stats, setStats] = useState({ fps: 0, triangles: 0, meshMs: 0 })
  const [softwareRenderer, setSoftwareRenderer] = useState(false)
  const [sheet, setSheet] = useState<RgbaImage | null>(null)
  const [sheetWarning, setSheetWarning] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  /** The one write verb the panels get, routed to the actor that owns the parameters. */
  const setParams = useCallback(
    (changes: Partial<ToolsSnapshot>) => report('tools.set', host.dispatch('tools.set', changes)),
    [host],
  )

  const select = useCallback(
    (id: string | null) => report('selection.set', host.dispatch('selection.set', { id })),
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

  /**
   * The art as of right now, for the ONE effect that must not re-run when it
   * changes: rebuilding the viewport would cost a WebGL context per material
   * edit. The effects below push replacements into the live viewport instead,
   * and they run on mount too, so the pair here only has to be good enough to
   * construct with.
   */
  const assetsRef = useRef({ sheet: generatedSheet, sprites })
  assetsRef.current = { sheet: generatedSheet, sprites }

  useEffect(() => {
    setSheet(generatedSheet)
    setSheetWarning(null)
    viewportRef.current?.loadSheet(generatedSheet)
  }, [generatedSheet])

  useEffect(() => {
    viewportRef.current?.loadSprites(sprites)
  }, [sprites])

  // --- viewport lifecycle ---------------------------------------------------
  // Created once, from values that are stable for the app's life: the host is
  // built outside React, and the refs below are React's own. Everything that
  // changes reaches the live viewport through `setOptions` or a loader, which
  // is why this survives `exhaustive-deps` being on (#37) without a ref to a
  // whole state object.
  const liveRef = useRef({ params, playing })
  liveRef.current = { params, playing }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Pointer input is not a command: it goes straight to the host's gesture
    // actor, which answers with what the press turned out to be (#11). What
    // used to be here — a `strokeRef` holding the anchor, the flatten height
    // and the last cell, and a rectangle's release commit — is the stroke
    // actor's context now, and dies with the stroke.
    const viewport = new Viewport(canvas, host.reader, assetsRef.current, {
      onPointerDown: (press) => {
        host.input.pointerDown(press)
      },
      onPointerMove: (motion) => host.input.pointerMove(motion),
      onPointerUp: (release) => host.input.pointerUp(release),
      onStrokeMove: (pick, modifiers) => host.input.strokeMove(pick, modifiers),
      heldKeys: () => host.input.heldKeys(),
      onHover: (pick) => {
        setHover(pick.surface)
        const live = liveRef.current
        if (pick.surface && live.params.tool === 'terrain' && !live.playing) {
          // The same cells the stroke will touch, grown from the same origin
          // — read off the open stroke rather than recomputed from a copy.
          setHoverCells(strokeCells(host.reader.doc, live.params, pick.surface, host.input.strokeOrigin()))
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
    // Nothing in the app reads them. `__host` replaced `__store`, `__ops` and
    // `__selectObject` with #66 step 7 — there is no store to expose, and the
    // host is the front door the editor itself uses: `reader` for a read,
    // `dispatch` for a write (scripts/global.ts types both, and is
    // typechecked, so a rename here fails the gate rather than the tour).
    const scripting = window as unknown as Record<string, unknown>
    scripting.__viewport = viewport
    scripting.__host = host
    viewport.frameMap()
    return () => {
      viewport.dispose()
      viewportRef.current = null
    }
  }, [host])

  // --- keyboard -------------------------------------------------------------
  // One listener for the whole editor, and it holds no key names: what is
  // bound is declared in `editor-host`'s keymap and resolved through the
  // registry (#14). The switch over `event.key` that used to be here, and the
  // viewport's own `Set` of held keys, are both gone into it.
  useEffect(() => installKeyDispatcher(host), [host])

  // --- the play session -----------------------------------------------------
  // The session is an actor the host spawns for the duration of play (#11);
  // what the viewport needs from it is where the character stands up. Read at
  // the transition, which is exactly when `playing` moves.
  const play = useMemo(() => (playing ? host.playSession() : null), [host, playing])

  // --- push editor state into the viewport ----------------------------------
  useEffect(() => {
    viewportRef.current?.setOptions({
      brushPreview: params.tool === 'terrain' && !playing ? hoverCells : [],
      showGrid: view.showGrid,
      gameCamera: view.gameCamera,
      play,
      hover: params.tool === 'terrain' ? hover : null,
      selectedObjectId: view.selectedObjectId,
    })
  }, [params.tool, playing, play, view.showGrid, view.gameCamera, view.selectedObjectId, hover, hoverCells])

  useEffect(() => {
    viewportRef.current?.refreshAtmosphere()
  }, [doc.atmosphere])

  // --- autosave -------------------------------------------------------------
  useEffect(() => {
    const handle = setTimeout(() => saveAutosave(reader.doc), 1200)
    return () => clearTimeout(handle)
  }, [revision, reader])

  // --- commands -------------------------------------------------------------
  const updateSelected = useCallback(
    (changes: Partial<MapObject>) => {
      const id = view.selectedObjectId
      if (!id) return
      report('objects.update', host.dispatch('objects.update', { id, changes }))
    },
    [host, view.selectedObjectId],
  )

  const setRig = useCallback(
    (changes: Partial<CameraRig>) => report('camera.set', host.dispatch('camera.set', changes)),
    [host],
  )

  const setAtmosphere = useCallback(
    (changes: Partial<Atmosphere>) => {
      report('atmosphere.set', host.dispatch('atmosphere.set', changes))
      viewportRef.current?.refreshAtmosphere()
    },
    [host],
  )

  const onSave = useCallback(() => {
    const blob = new Blob([serialize(doc)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${doc.name.replace(/\s+/g, '-').toLowerCase()}.map.json`
    link.click()
    URL.revokeObjectURL(url)
    setMessage(`Saved ${link.download}`)
  }, [doc])

  const onLoad = useCallback(
    async (file: File) => {
      // The file's TEXT is the argument (#2: plain serialisable data). Parsing
      // it is the command's, and a map that will not parse comes back as an
      // `invalid-args` refusal carrying the load error's own message — which
      // is what this shows, rather than catching a throw.
      const why = refusal(host.dispatch('document.load', { json: await file.text() }))
      if (why !== null) return setMessage(why)
      // The document's identity changed, which no patch does — but the
      // viewport notices that itself now, off `reader.generation`, so there is
      // no `reset()` to remember here. That matters because this is not the
      // only place `document.load` can be dispatched from: a keybinding, the
      // palette, a test or `window.__host.dispatch` all reach the same
      // command, and a renderer that only re-points when App says so would
      // keep meshing the replaced document for all of them.
      setMessage(`Loaded ${file.name}`)
    },
    [host],
  )

  const onExport = useCallback(async () => {
    setMessage('Exporting…')
    try {
      // The generated sheet, as before #47 when the exporter generated its own:
      // an artist's loaded sheet still previews but does not export.
      const bytes = await exportGltf(doc, {
        merge: false,
        sheet: generatedSheet,
        sprites,
        encodePng: encodePngWithCanvas,
      })
      const blob = new Blob([bytes], { type: 'model/gltf-binary' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${doc.name.replace(/\s+/g, '-').toLowerCase()}.glb`
      link.click()
      URL.revokeObjectURL(url)
      setMessage(`Exported ${link.download} (${(blob.size / 1024).toFixed(0)} KB)`)
    } catch (error) {
      setMessage(`Export failed: ${String(error)}`)
    }
  }, [doc, generatedSheet, sprites])

  const onLoadSheet = useCallback(
    async (file: File) => {
      try {
        const result = await loadSheetFromFile(file, doc)
        setSheet(result.image)
        setSheetWarning(result.warning)
        viewportRef.current?.loadSheet(result.image)
      } catch (error) {
        setSheetWarning(String(error))
      }
    },
    [doc],
  )

  const selected = view.selectedObjectId ? doc.objects[view.selectedObjectId] ?? null : null

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">{doc.name}</strong>
        <span className="toolbar-group">
          <button type="button" onClick={() => report('undo', host.dispatch('undo'))} disabled={!reader.canUndo()}>
            Undo
          </button>
          <button type="button" onClick={() => report('redo', host.dispatch('redo'))} disabled={!reader.canRedo()}>
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
              checked={view.showGrid}
              onChange={(event) => report('view.set', host.dispatch('view.set', { showGrid: event.target.checked }))}
            />
            Grid
          </label>
          <label className="toggle" title="G — clamp the view to the game's camera bounds">
            <input
              type="checkbox"
              checked={view.gameCamera}
              onChange={(event) => report('view.set', host.dispatch('view.set', { gameCamera: event.target.checked }))}
            />
            Game camera
          </label>
          <button
            type="button"
            className={playing ? 'active' : ''}
            onClick={() => {
              const id = playing ? 'mode.edit' : 'mode.play'
              report(id, host.dispatch(id))
            }}
            title="P — walk the map with WASD"
          >
            {playing ? 'Stop' : 'Play'}
          </button>
        </span>
      </header>

      <div className="body">
        <aside className="left">
          <ToolPanel
            doc={doc}
            params={params}
            sheet={sheet}
            set={setParams}
            onLoadSheet={(file) => void onLoadSheet(file)}
            sheetWarning={sheetWarning}
          />
        </aside>

        <main className="stage">
          <canvas ref={canvasRef} className={playing ? 'playing' : ''} />
          {!camera.inBounds && !playing ? (
            <div className="envelope-warning">
              Outside the game's camera envelope — press G to clamp
            </div>
          ) : null}
          {playing ? <div className="play-hint">WASD to walk · P to stop</div> : null}
        </main>

        <aside className="right">
          <nav className="tabs">
            {(['properties', 'coverage', 'atmosphere', 'outliner'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                className={view.inspector === tab ? 'active' : ''}
                onClick={() => report('view.set', host.dispatch('view.set', { inspector: tab }))}
              >
                {tab}
              </button>
            ))}
          </nav>

          {view.inspector === 'properties' ? (
            params.tool === 'camera' ? (
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
                // `selection.delete` is the composite the keymap binds too: it
                // expands to `objects.delete({ ids })` plus clearing the
                // selection, with the ids filled in outside every actor (#11).
                onDelete={() => report('selection.delete', host.dispatch('selection.delete'))}
              />
            )
          ) : null}

          {view.inspector === 'coverage' ? (
            <>
              <CameraPanel
                rig={doc.camera}
                onChange={setRig}
                onSweep={() => viewportRef.current?.startSweep()}
                onPreview={() => viewportRef.current?.applyRigDefaults()}
              />
              <CoveragePanel
                onSelect={(id) => {
                  select(id)
                  report('view.set', host.dispatch('view.set', { inspector: 'properties' }))
                  setParams({ tool: 'object' })
                }}
                onFix={(id) => report('objects.update', host.dispatch('objects.update', { id, changes: { display: 'billboardY' } }))}
              />
            </>
          ) : null}

          {view.inspector === 'atmosphere' ? (
            <AtmospherePanel atmosphere={doc.atmosphere} onChange={setAtmosphere} />
          ) : null}

          {view.inspector === 'outliner' ? (
            <Outliner
              doc={doc}
              selectedId={view.selectedObjectId}
              onSelect={(id) => {
                select(id)
                setParams({ tool: 'object' })
              }}
              onChange={(id, changes) => report('objects.update', host.dispatch('objects.update', { id, changes }))}
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
        <span>{reader.canUndo() ? reader.undoLabel() : 'nothing to undo'}</span>
      </footer>
    </div>
  )
}
