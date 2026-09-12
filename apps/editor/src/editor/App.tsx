import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import {
  MAX_HEIGHT,
  MIN_HEIGHT,
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
  HALF,
  NO_WATER,
  frameOf,
  levelBounds,
  structureOf,
  type ReadonlyVoxel,
  toWorld,
} from '@map-editor/document'
import {
  useDocument,
  useHost,
  useHostSelector,
  useToolsSelector,
  useViewSelector,
  type Host,
} from '@map-editor/editor-host'
// The brush preview draws the cells a terrain stroke will touch, so it calls
// the same function the stroke does (`feature-terrain`'s, the one
// implementation). An app is the only thing that may import a feature (#35),
// and this file is an app.
import { strokeCells } from '@map-editor/feature-terrain'
import { currentSketch, sketchPointHeight } from '@map-editor/feature-sketch'
import { mergeParams, type EditorParams } from './params'
// The canvas-drawing generator lives behind its own subpath (#48): re-exporting it
// from the package root would force `DOM` into every consumer's tsconfig, including
// `apps/export-cli`'s, whose whole point is compiling without it.
import { generateSketchTextures, generateSprites, generateTerrainSheet } from '@map-editor/fixtures/textures'
import { chordFor } from '@map-editor/registry'
import { exportGltf } from '@map-editor/runtime/export'
import {
  Brand,
  FileButton,
  Frame,
  Hint,
  Kbd,
  LayerRange,
  Overlay,
  Pill,
  StatusHints,
  StatusRight,
  TopButton,
  TopGroup,
  TopGrow,
  TopSep,
} from '@map-editor/ui'
import { Viewport, type SketchOverlay } from '@map-editor/viewport'

import { saveAutosave } from './autosave'
import { FeaturePanels, ObjectBar, SelectBar } from './bars'
import { Inspector } from './inspector'
import { detectPlatform, installKeyDispatcher } from './keys'
import { Rail } from './rail'
import { encodePngWithCanvas } from './rgba'
import { loadSheetFromFile } from './sheet'

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
  const totals = { top: 0, cliff: 0 }
  for (const id of doc.structureOrder) {
    const voxel = doc.structures[id]
    if (!voxel || voxel.kind !== 'voxel') continue
    const counts = countDormant(voxel.paint, (kind, key) => {
      const [x, y] = key.split(',').map(Number)
      if (!inBounds(voxel.size, x, y)) return false
      if (kind === 'top') return true
      const level = Number(key.split(',')[3])
      return level < voxel.terrain.height[cellIndex(voxel.size, x, y)]
    })
    totals.top += counts.top
    totals.cliff += counts.cliff
  }
  return totals
}

function levelSize(doc: ReadonlyMapDoc): string {
  const b = levelBounds(doc)
  return b ? `${Math.round(b.maxX - b.minX)} × ${Math.round(b.maxZ - b.minZ)}` : '—'
}

function firstVoxel(doc: ReadonlyMapDoc): ReadonlyVoxel {
  for (const id of doc.structureOrder) {
    const s = doc.structures[id]
    if (s && s.kind === 'voxel') return s
  }
  throw new Error('no voxel volume to preview a brush on')
}

/**
 * The tallest thing in the map, in half-tiles: the top of the layer view's
 * slider. The map's own height rather than the document's ceiling, which is
 * ten times taller than any map here and made the slider useless. Per
 * revision, like `dormantPaint`, since a sculpt can raise it.
 */
function tallestPoint(doc: ReadonlyMapDoc): number {
  let top = MIN_HEIGHT
  for (const id of doc.structureOrder) {
    const s = doc.structures[id]
    if (!s) continue
    const base = Math.round(frameOf(doc, id).y / HALF)
    if (s.kind === 'voxel') {
      for (const height of s.terrain.height) if (base + height > top) top = base + height
      for (const water of s.terrain.water) if (water !== NO_WATER && base + water > top) top = base + water
    } else if (s.closed) top = Math.max(top, base + s.layers)
  }
  return top
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

/** The status bar's hints per tool: what the pointer and the modifiers do right now. */
function hintsFor(params: EditorParams): ReadonlyArray<{ kbd?: string; text: string }> {
  switch (params.tool) {
    case 'select':
      return [
        { kbd: 'click', text: 'select an object' },
        { kbd: 'drag', text: 'move it' },
        { kbd: '⇧ click', text: 'keep the selection' },
        { kbd: '⌥ click', text: 'pick up its sprite' },
      ]
    case 'object':
      return [
        { kbd: 'click', text: `place ${params.spriteName}` },
        { kbd: 'drag', text: 'move what you placed' },
        { kbd: '⇧ click', text: 'place nothing' },
      ]
    case 'terrain':
      return params.terrainMode === 'sculpt'
        ? [
            { kbd: 'drag', text: params.sculptVerb },
            { kbd: '⇧', text: params.sculptVerb === 'water' ? 'remove water' : 'lower instead' },
            { kbd: '⌥ click', text: 'pick up the tile' },
          ]
        : [
            { kbd: 'drag', text: `paint ${params.paintVerb}` },
            { kbd: '⌥ click', text: 'pick up the tile' },
          ]
    case 'sketch':
      return params.sketchMode === 'draw'
        ? [
            { kbd: 'click', text: params.drawing ? 'add a point' : 'start an outline' },
            { kbd: '⌥ click', text: 'a corner point' },
            { kbd: '⇧', text: 'no snapping' },
            ...(params.drawing ? [{ kbd: '⏎', text: 'finish' }, { kbd: 'esc', text: 'discard' }] : []),
          ]
        : [
            { kbd: 'drag', text: 'move a point' },
            { kbd: 'click', text: 'select a sketch' },
            { kbd: '⇧', text: 'no snapping' },
          ]
    default:
      return []
  }
}

export default function App() {
  // Built at the composition root (`main.tsx`), never here: the viewport is
  // handed `host.input` before React has rendered anything, and a host built
  // by a hook is rebuilt when React remounts.
  const host = useHost()
  const { reader } = host
  const platform = useMemo(detectPlatform, [])

  // `EditorState`'s eighteen fields are gone (#11, #66 step 7): eleven belong
  // to the host's tools actor, four to its view actor, and `playing` IS the
  // host's mode. Nothing is mirrored — the stroke actor reads the same tool
  // parameters the panels show, and the eyedropper writing a tile back is a
  // `tools.set` that re-renders this by the ordinary route.
  const toolsSnapshot = useToolsSelector(snapshotOf)
  const viewSnapshot = useViewSelector(snapshotOf)
  const playing = useHostSelector(isPlaying)
  const view = viewSnapshot.context
  const params = useMemo<EditorParams>(() => mergeParams(toolsSnapshot.context), [toolsSnapshot])

  const doc = useDocument(wholeDocument)
  const dormant = useDocument(dormantPaint)
  const tallest = useDocument(tallestPoint)
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
  // The rail's gear: opens the three Level sections of the inspector together.
  const [levelOpen, setLevelOpen] = useState(false)

  /** The one write verb the panels get, routed to the actor that owns the parameters. */
  const setParams = useCallback(
    (changes: Partial<EditorParams>) => {
      // The host owns the tool and the sprite; everything else here is the app's terrain-specific UI (the tile palette) speaking to the terrain feature.
      const { tool, spriteName, ...rest } = changes
      const own: { tool?: string; spriteName?: string } = {}
      if (tool !== undefined) own.tool = tool
      if (spriteName !== undefined) own.spriteName = spriteName
      if (Object.keys(own).length > 0) report('tools.set', host.dispatch('tools.set', own))
      if (Object.keys(rest).length > 0) report('terrain.params', host.dispatch('terrain.params', rest))
    },
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
  const textures = useMemo(() => generateSketchTextures(doc.texelDensity), [doc.texelDensity])

  /**
   * The art as of right now, for the ONE effect that must not re-run when it
   * changes: rebuilding the viewport would cost a WebGL context per material
   * edit. The effects below push replacements into the live viewport instead,
   * and they run on mount too, so the pair here only has to be good enough to
   * construct with.
   */
  const assetsRef = useRef({ sheet: generatedSheet, sprites, textures })
  assetsRef.current = { sheet: generatedSheet, sprites, textures }

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
          setHoverCells(strokeCells(structureOf(host.reader.doc, pick.surface.structure, 'voxel') ?? firstVoxel(host.reader.doc), live.params, pick.surface, host.input.strokeOrigin()))
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
  useEffect(() => installKeyDispatcher(host, { platform }), [host, platform])

  // --- the play session -----------------------------------------------------
  // The session is an actor the host spawns for the duration of play (#11);
  // what the viewport needs from it is where the character stands up. Read at
  // the transition, which is exactly when `playing` moves.
  const play = useMemo(() => (playing ? host.playSession() : null), [host, playing])

  // The sketch under the Sketch tool — being drawn, or selected — as the viewport draws it: its points in world space on
  // its cap. Computed per render rather than memoised: the document is mutated in place, so nothing about `doc` would tell
  // a memo to recompute, and it is a handful of points.
  const sketchOverlay = ((): SketchOverlay | null => {
    if (params.tool !== 'sketch') return null
    const sketch = currentSketch(doc, params, view.selection)
    if (!sketch) return null
    const frame = frameOf(doc, sketch.id)
    const y = sketchPointHeight(doc, sketch) + 0.05
    const points = sketch.points.map((p) => {
      const [x, z] = toWorld(frame, p.x, p.z)
      return [x, y, z] as const
    })
    const selected = view.selection?.kind === 'sketchPoint' && view.selection.structure === sketch.id ? view.selection.index : null
    return { structure: sketch.id, points, closed: sketch.closed, selected }
  })()
  // Pushed to the viewport by content, not identity: the object is new every render, its key only when the sketch changed.
  const sketchOverlayKey = sketchOverlay ? `${sketchOverlay.closed}:${sketchOverlay.selected}:${sketchOverlay.points.map((p) => p.join(',')).join(';')}` : ''
  const sketchOverlayRef = useRef(sketchOverlay)
  sketchOverlayRef.current = sketchOverlay

  // --- push editor state into the viewport ----------------------------------
  useEffect(() => {
    viewportRef.current?.setOptions({
      sketch: sketchOverlayRef.current,
      brushPreview: params.tool === 'terrain' && !playing ? hoverCells : [],
      showGrid: view.showGrid,
      gameCamera: view.gameCamera,
      play,
      hover: params.tool === 'terrain' ? hover : null,
      selectedObjectId: view.selectedObjectId,
      layers: view.layers,
    })
  }, [params.tool, playing, play, view.showGrid, view.gameCamera, view.selectedObjectId, view.layers, hover, hoverCells, sketchOverlayKey])

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

  const updateObject = useCallback(
    (id: string, changes: Partial<MapObject>) => report('objects.update', host.dispatch('objects.update', { id, changes })),
    [host],
  )

  const deleteSelection = useCallback(() => report('selection.delete', host.dispatch('selection.delete')), [host])

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
        textures: assetsRef.current.textures,
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

  /** Select an object from a list, and go to Select so the drag and the keys act on it. */
  const selectFromList = useCallback(
    (id: string) => {
      select(id)
      setParams({ tool: 'select' })
    },
    [select, setParams],
  )

  const selected = view.selectedObjectId ? doc.objects[view.selectedObjectId] ?? null : null
  const deleteKbd = chordFor('selection.delete', undefined, platform)
  const hints = hintsFor(params)
  // The layer view. The slider spans the map's own height with a little
  // headroom (room to paint a layer above the top), never the document's
  // ceiling. `null` on the actor is the whole range, which is what the top
  // of the slider means — so a map that grows taller stays wholly visible.
  const layerTop = Math.min(MAX_HEIGHT, Math.max(4, tallest + 2))
  const layers = view.layers ? { lo: Math.min(view.layers.lo, layerTop), hi: Math.min(view.layers.hi, layerTop) } : { lo: MIN_HEIGHT, hi: layerTop }
  const setLayers = (range: { lo: number; hi: number }) =>
    report('view.set', host.dispatch('view.set', { layers: range.lo === MIN_HEIGHT && range.hi >= layerTop ? null : range }))

  return (
    <Frame
      top={
        <>
          <Brand name="map-editor" level={doc.name} />
          <TopGrow />
          <TopGroup>
            <TopButton icon="undo" title="Undo" kbd={chordFor('undo', undefined, platform)} disabled={!reader.canUndo()} onClick={() => report('undo', host.dispatch('undo'))} />
            <TopButton icon="redo" title="Redo" kbd={chordFor('redo', undefined, platform)} disabled={!reader.canRedo()} onClick={() => report('redo', host.dispatch('redo'))} />
            <TopSep />
            <TopButton icon="frameAll" title="Reset view — frame the whole level" onClick={() => viewportRef.current?.frameMap()} />
            <TopButton icon="sweep" title="Sweep — fly the game camera through its bounds" onClick={() => viewportRef.current?.startSweep()} />
            <TopSep />
            <TopButton
              icon="grid"
              title={view.showGrid ? 'Hide the grid' : 'Show the grid'}
              active={view.showGrid}
              onClick={() => report('view.set', host.dispatch('view.set', { showGrid: !view.showGrid }))}
            />
            <TopButton
              icon="camera"
              title={view.gameCamera ? 'Free the camera' : "Clamp the view to the game's camera bounds"}
              kbd={chordFor('view.set', { gameCamera: !view.gameCamera }, platform)}
              active={view.gameCamera}
              onClick={() => report('view.set', host.dispatch('view.set', { gameCamera: !view.gameCamera }))}
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
            onClick={() => {
              const id = playing ? 'mode.edit' : 'mode.play'
              report(id, host.dispatch(id))
            }}
          />
        </>
      }
      rail={
        <Rail
          tool={params.tool}
          onTool={(tool) => setParams({ tool })}
          levelOpen={levelOpen}
          onLevel={() => setLevelOpen((open) => !open)}
          platform={platform}
        />
      }
      bar={
        params.tool === 'select' ? (
          <SelectBar selected={selected} platform={platform} onDelete={deleteSelection} onClear={() => select(null)} />
        ) : params.tool === 'object' ? (
          <ObjectBar params={params} set={setParams} />
        ) : (
          <FeaturePanels slot="bar" tool={params.tool} doc={doc} params={params} platform={platform} selection={view.selection} />
        )
      }
      stage={
        <>
          <canvas ref={canvasRef} className={`stage-canvas ${playing ? 'is-playing' : ''}`} />
          <Overlay at="top-left">
            <Pill>
              <span className="ui-num">
                {levelSize(doc)}
              </span>
            </Pill>
          </Overlay>
          {!camera.inBounds && !playing ? (
            <Overlay at="top-center">
              <Pill warn>
                Outside the game's camera envelope <Kbd>{chordFor('view.set', { gameCamera: true }, platform) ?? 'G'}</Kbd> clamps
              </Pill>
            </Overlay>
          ) : null}
          {!playing ? (
            <Overlay at="right">
              <LayerRange max={layerTop} lo={layers.lo} hi={layers.hi} onChange={setLayers} />
            </Overlay>
          ) : null}
          {playing ? (
            <Overlay at="bottom-center">
              <Pill>
                <Kbd>WASD</Kbd> walk <Kbd>{chordFor('mode.edit', undefined, platform) ?? 'P'}</Kbd> stop
              </Pill>
            </Overlay>
          ) : (
            <Overlay at="bottom-right">
              <Pill>
                <span>
                  <Kbd>⌥ drag</Kbd> orbit
                </span>
                <span>
                  <Kbd>right drag</Kbd> pan
                </span>
                <span>
                  <Kbd>scroll</Kbd> zoom
                </span>
              </Pill>
            </Overlay>
          )}
        </>
      }
      inspector={
        <Inspector
          doc={doc}
          params={params}
          set={setParams}
          selection={view.selection}
          platform={platform}
          selected={selected}
          deleteKbd={deleteKbd}
          levelOpen={levelOpen}
          onLevelToggle={setLevelOpen}
          sheet={sheet}
          sheetWarning={sheetWarning}
          onLoadSheet={(file) => void onLoadSheet(file)}
          onSelect={selectFromList}
          onObject={updateSelected}
          onObjectChange={updateObject}
          onDelete={deleteSelection}
          onRig={setRig}
          onAtmosphere={setAtmosphere}
          onFix={(id) => updateObject(id, { display: 'billboardY' })}
          message={message}
        />
      }
      status={
        <>
          <StatusHints>
            {hints.map((hint) => (
              <Hint key={hint.text} kbd={hint.kbd}>
                {hint.text}
              </Hint>
            ))}
          </StatusHints>
          <StatusRight>
            <span>{describeSurface(hover)}</span>
            {params.tool === 'terrain' ? (
              <span>{hover && hover.kind === SURFACE_CLIFF ? 'paints by absolute level' : `${hoverCells.length} cells`}</span>
            ) : null}
            <span title="Painted work that is currently hidden by geometry, and would come back">dormant paint {dormant.top + dormant.cliff}</span>
            {view.layers ? (
              <span className="ui-num" title="The layer view is narrowed; double-click the slider to see everything">
                layers {view.layers.lo}–{view.layers.hi}
              </span>
            ) : null}
            <span className={`ui-num ${camera.inBounds ? '' : 'is-warn'}`}>
              yaw {Math.round(camera.yaw)}° · pitch {Math.round(camera.pitch)}° · {camera.distance.toFixed(1)}u
            </span>
            <span className="ui-num">
              {stats.fps.toFixed(0)} fps · {(stats.triangles / 1000).toFixed(0)}k tris · mesh {stats.meshMs.toFixed(1)}ms
              {softwareRenderer ? ' · software GL' : ''}
            </span>
            {/* Gated on `canUndo`, not on the label: mid-drag the store refuses
                undo and reports `canUndo` false while `undoLabel` still names the
                entry underneath the stroke, so naming it here would advertise
                something the disabled button beside it will not do. */}
            <span>{reader.canUndo() ? reader.undoLabel() : 'nothing to undo'}</span>
          </StatusRight>
        </>
      }
    />
  )
}
