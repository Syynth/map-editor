/**
 * The status bar: what the pointer and modifiers do under the current tool,
 * and the readouts — the hovered surface, dormant paint, the layer range, the
 * camera, frame stats, and what undo would undo.
 *
 * Each readout is its own component selecting its own value, because they
 * change at very different rates: the hovered surface at pointer rate, the
 * camera while orbiting, the stats twice a second, dormant paint once per
 * edit. Before, all of them were the whole editor's state, and each of those
 * changes re-rendered everything.
 */

import { useMemo, useSyncExternalStore } from 'react'

import { SURFACE_CLIFF, cellIndex, countDormant, describeSurface, inBounds, type ReadonlyMapDoc } from '@papercut/document'
import { sameSurface, useDocumentSelector, useHost, useToolsSelector, useViewSelector, useViewportSelector } from '@papercut/editor-host'
import { Hint, StatusHints, StatusRight } from '@papercut/ui'

import { mergeParams, type EditorParams } from './params'

/** The snap-off modifier as the status bar names it: Cmd on a Mac, Ctrl elsewhere (the viewport folds both into `ctrl`). */
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'ctrl'

/** The status bar's hints per tool: what the pointer and the modifiers do right now. */
export function hintsFor(params: EditorParams): ReadonlyArray<{ kbd?: string; text: string }> {
  switch (params.tool) {
    case 'select':
      return [
        { kbd: 'click', text: 'select what is under it' },
        { kbd: 'drag', text: 'move it' },
        { kbd: '⇧ drag', text: 'along one axis' },
        { kbd: MOD, text: 'no snapping' },
        { kbd: '← →', text: 'nudge a cell' },
        { kbd: '⌥ click', text: 'pick up a sprite' },
      ]
    case 'object':
      return [
        { kbd: 'click', text: `place ${params.spriteName}` },
        { kbd: 'drag', text: 'move what you placed' },
        { kbd: MOD, text: 'no snapping' },
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
            { kbd: MOD, text: 'no snapping' },
            ...(params.drawing ? [{ kbd: '⏎', text: 'finish' }, { kbd: 'esc', text: 'discard' }] : []),
          ]
        : [
            { kbd: 'drag', text: 'move a point' },
            { kbd: 'click', text: 'select a sketch' },
            { kbd: MOD, text: 'no snapping' },
          ]
    default:
      return []
  }
}

/**
 * Painted work that geometry currently hides, summed over every voxel volume. It walks every painted address, so it is
 * selected settled: counted once a stroke closes, not on every tick of it.
 */
function dormantPaint(doc: ReadonlyMapDoc): number {
  let total = 0
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
    total += counts.top + counts.cliff
  }
  return total
}

export function StatusBar() {
  return (
    <>
      <Hints />
      <StatusRight>
        <HoverReadout />
        <DormantPaint />
        <LayersReadout />
        <CameraReadout />
        <FrameStats />
        <UndoReadout />
      </StatusRight>
    </>
  )
}

function Hints() {
  const tools = useToolsSelector((snapshot) => snapshot.context)
  const hints = useMemo(() => hintsFor(mergeParams(tools)), [tools])
  return (
    <StatusHints>
      {hints.map((hint) => (
        <Hint key={hint.text} kbd={hint.kbd}>
          {hint.text}
        </Hint>
      ))}
    </StatusHints>
  )
}

function HoverReadout() {
  const hover = useViewportSelector((snapshot) => snapshot.context.hover, sameSurface)
  const cells = useViewportSelector((snapshot) => snapshot.context.brushCells.length)
  const terrain = useToolsSelector((snapshot) => snapshot.context.tool === 'terrain')
  return (
    <>
      <span>{describeSurface(hover)}</span>
      {terrain ? <span>{hover && hover.kind === SURFACE_CLIFF ? 'paints by absolute level' : `${cells} cells`}</span> : null}
    </>
  )
}

function DormantPaint() {
  const dormant = useDocumentSelector(dormantPaint, { equal: Object.is, settled: true })
  return <span title="Painted work that is currently hidden by geometry, and would come back">dormant paint {dormant}</span>
}

function LayersReadout() {
  const layers = useViewSelector((snapshot) => snapshot.context.layers)
  if (!layers) return null
  return (
    <span className="ui-num" title="The layer view is narrowed; double-click the slider to see everything">
      layers {layers.lo}–{layers.hi}
    </span>
  )
}

function CameraReadout() {
  const camera = useViewportSelector((snapshot) => snapshot.context.camera)
  return (
    <span className={`ui-num ${camera.inBounds ? '' : 'is-warn'}`}>
      yaw {Math.round(camera.yaw)}° · pitch {Math.round(camera.pitch)}° · {camera.distance.toFixed(1)}u
    </span>
  )
}

function FrameStats() {
  const stats = useViewportSelector((snapshot) => snapshot.context.stats)
  const software = useViewportSelector((snapshot) => snapshot.context.softwareRenderer)
  return (
    <span className="ui-num">
      {stats.fps.toFixed(0)} fps · {(stats.triangles / 1000).toFixed(0)}k tris · mesh {stats.meshMs.toFixed(1)}ms
      {software ? ' · software GL' : ''}
    </span>
  )
}

/**
 * Gated on `canUndo`, not on the label: mid-drag the store refuses undo and reports `canUndo` false while `undoLabel`
 * still names the entry underneath the stroke, so naming it here would advertise something the disabled button will not do.
 */
function UndoReadout() {
  const { reader } = useHost()
  const label = useSyncExternalStore(reader.subscribe, () => (reader.canUndo() ? reader.undoLabel() : 'nothing to undo'))
  return <span>{label}</span>
}
