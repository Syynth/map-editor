/**
 * The Sketch tool's bar and inspector.
 *
 * The bar is the tool's controls: mode (draw / edit), snapping, and — while
 * an outline is open — finish and cancel. The inspector is the selected
 * sketch's: height, lip, its two materials, and the drawn wall profile.
 * Edits to a sketch go through the document's own `sketch.set`, dispatched
 * by the app's `dispatch` prop; the tool's parameters go through `set`.
 */

import { HALF, type ReadonlyMapDoc, type ReadonlySketch, type WallProfile, type WallProfilePoint } from '@map-editor/document'
import { wallProfilePolyline } from '@map-editor/geometry'
import { chordFor, panels, type FeatureSelection, type OwnerId, type Platform } from '@map-editor/registry'
import { BarDivider, BarLabel, BarSlider, Field, IconSegmented, Note, Row, Segmented, Select, Slider, Toggle, Verb, colors } from '@map-editor/ui'
import { useEffect, useRef, useState } from 'react'

import type { SketchParams } from './params'

export interface SketchPanelProps {
  readonly doc: ReadonlyMapDoc
  readonly params: SketchParams
  readonly set: (changes: Partial<SketchParams>) => void
  readonly platform: Platform
  /** The host's dispatch, for the document's own sketch commands. */
  readonly dispatch?: (id: string, args?: unknown) => void
  readonly selection?: FeatureSelection | null
}

/** The sketch the panels address: the one being drawn, else the selected one (or the one whose point is selected). */
export function currentSketch(doc: ReadonlyMapDoc, params: SketchParams, selection: FeatureSelection | null | undefined): ReadonlySketch | null {
  const candidates = [params.drawing]
  if (selection?.kind === 'structure') candidates.push(selection.id as string)
  if (selection?.kind === 'sketchPoint') candidates.push(selection.structure as string)
  for (const id of candidates) {
    if (!id) continue
    const s = doc.structures[id]
    if (s && s.kind === 'sketch') return s
  }
  return null
}

export function SketchBar({ doc, params, set, platform, dispatch, selection }: SketchPanelProps) {
  const sketch = currentSketch(doc, params, selection)
  const drawing = params.drawing !== null
  return (
    <>
      <IconSegmented
        value={params.sketchMode}
        onChange={(sketchMode) => set({ sketchMode })}
        options={[
          { value: 'draw', icon: 'pen', title: 'Draw — click to add points; click the first point to close' },
          { value: 'edit', icon: 'move', title: 'Edit — drag points; click a sketch to select it' },
        ]}
      />
      <BarDivider />
      <BarLabel>Snap</BarLabel>
      <IconSegmented
        value={params.sketchSnap}
        onChange={(sketchSnap) => set({ sketchSnap })}
        options={[
          { value: 'grid', icon: 'snapGrid', title: 'Snap to whole cells' },
          { value: 'half', icon: 'snapHalf', title: 'Snap to half cells' },
          { value: 'free', icon: 'snapFree', title: 'No snapping — holding ctrl (⌘ on a Mac) does this too' },
        ]}
      />
      {drawing ? (
        <>
          <BarDivider />
          <Verb icon="check" title="Finish the outline" kbd={chordFor('sketch.finish', undefined, platform)} onClick={() => dispatch?.('sketch.finish')} />
          <Verb icon="clear" title="Discard the outline" kbd={chordFor('sketch.cancel', undefined, platform)} onClick={() => dispatch?.('sketch.cancel')} />
        </>
      ) : null}
      {sketch && sketch.closed ? (
        <>
          <BarDivider />
          <BarLabel>Height</BarLabel>
          <BarSlider
            title="Layers"
            value={sketch.layers}
            min={1}
            max={32}
            onChange={(layers) => dispatch?.('sketch.set', { id: sketch.id, changes: { layers } })}
            format={(v) => `${v}L`}
          />
        </>
      ) : null}
    </>
  )
}

export function SketchInspector({ doc, params, dispatch, selection }: SketchPanelProps) {
  const sketch = currentSketch(doc, params, selection)
  if (!sketch) return <Note>Draw an outline on the ground or on a structure, or select a sketch to edit it.</Note>
  const setSketch = (changes: Record<string, unknown>) => dispatch?.('sketch.set', { id: sketch.id, changes })
  const materials = Object.entries(doc.surfaceMaterials).map(([id, material]) => ({ value: id, label: material.name }))
  return (
    <>
      <Row label="Name" value={sketch.name} />
      <Row label="Points" value={`${sketch.points.length}${sketch.closed ? '' : ' · open'}`} />
      <Row label="Base" value={`${(frameY(doc, sketch) / HALF).toFixed(0)}L`} muted />
      <Field label="Height">
        <Slider value={sketch.layers} min={1} max={32} step={1} onChange={(layers) => setSketch({ layers })} format={(v) => `${v} layers`} />
      </Field>
      <Field label="Lip" hint="How the cap meets the wall">
        <Segmented
          value={sketch.lip}
          onChange={(lip) => setSketch({ lip })}
          options={[
            { value: 'flat', label: 'Flat' },
            { value: 'skirt', label: 'Skirt' },
            { value: 'bevel', label: 'Bevel' },
          ]}
        />
      </Field>
      <Field label="Cap material">
        <Select value={sketch.capMaterial} onChange={(capMaterial) => setSketch({ capMaterial })} options={materials} />
      </Field>
      <Field label="Wall material">
        <Select value={sketch.wallMaterial} onChange={(wallMaterial) => setSketch({ wallMaterial })} options={materials} />
      </Field>
      <Field label="Wall profile" hint="Side view, outside to the right: drag points, click between them to add one, Backspace deletes">
        <ProfileEditor profile={sketch.wall} height={sketch.layers * HALF} onChange={(wall) => setSketch({ wall })} />
      </Field>
      <Field label="Smooth profile">
        <Toggle checked={sketch.wall.smooth} onChange={(smooth) => setSketch({ wall: { ...cloneProfile(sketch.wall), smooth } })} />
      </Field>
    </>
  )
}

function frameY(doc: ReadonlyMapDoc, sketch: ReadonlySketch): number {
  // Without the geometry the height is the parent's cap; a voxel parent's is at its placement.
  const parent = sketch.parent ? doc.structures[sketch.parent] : undefined
  if (!parent) return 0
  if (parent.kind === 'sketch') return frameY(doc, parent) + (parent.closed ? parent.layers * HALF : 0)
  const index = Math.floor(sketch.placement.z) * parent.size.width + Math.floor(sketch.placement.x)
  return (parent.terrain.height[index] ?? 0) * HALF
}

function cloneProfile(profile: ReadonlySketch['wall']): WallProfile {
  return { points: profile.points.map((p) => ({ ...p })), smooth: profile.smooth }
}

// --- the side-view profile editor -------------------------------------------

const W = 260
const H = 150
const PAD = 12
const LIP_X = 100
const PX_PER_UNIT = 40

function toPx(p: WallProfilePoint): [number, number] {
  return [LIP_X + p.out * PX_PER_UNIT, H - PAD - p.t * (H - PAD * 2)]
}

function fromPx(x: number, y: number): WallProfilePoint {
  return { out: (x - LIP_X) / PX_PER_UNIT, t: (H - PAD - y) / (H - PAD * 2) }
}

/**
 * The wall's silhouette, drawn: the island's edge from the side, outside to
 * the right. The lip point is pinned (the lip is the outline) and the
 * ground point slides sideways; interior points move freely between their
 * neighbours. What it hands back is the profile the mesher sweeps.
 */
export function ProfileEditor({ profile, height, onChange }: { profile: ReadonlySketch['wall']; height: number; onChange: (profile: WallProfile) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const drag = useRef<number | null>(null)
  const points = profile.points

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = colors.bg
    ctx.fillRect(0, 0, W, H)
    ctx.strokeStyle = colors.line2
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, H - PAD + 0.5)
    ctx.lineTo(W, H - PAD + 0.5)
    ctx.stroke()
    for (let out = -2; out <= 4; out++) {
      const x = LIP_X + out * PX_PER_UNIT + 0.5
      ctx.strokeStyle = out === 0 ? colors.line2 : colors.line
      ctx.beginPath()
      ctx.moveTo(x, PAD)
      ctx.lineTo(x, H - PAD)
      ctx.stroke()
    }
    const poly = wallProfilePolyline({ points: points.map((p) => ({ ...p })), smooth: profile.smooth })
    ctx.beginPath()
    ctx.moveTo(0, H - PAD)
    for (const p of poly) ctx.lineTo(...toPx(p))
    ctx.lineTo(0, PAD)
    ctx.closePath()
    ctx.fillStyle = '#5c4630'
    ctx.fill()
    ctx.fillStyle = '#5f9c3f'
    ctx.fillRect(0, PAD - 3, LIP_X, 4)
    ctx.strokeStyle = colors.accent
    ctx.lineWidth = 1.5
    ctx.beginPath()
    poly.forEach((p, i) => (i === 0 ? ctx.moveTo(...toPx(p)) : ctx.lineTo(...toPx(p))))
    ctx.stroke()
    ctx.strokeStyle = colors.ink3
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(...toPx(p)) : ctx.lineTo(...toPx(p))))
    ctx.stroke()
    ctx.setLineDash([])
    points.forEach((p, i) => {
      const [x, y] = toPx(p)
      ctx.beginPath()
      ctx.arc(x, y, 4.5, 0, Math.PI * 2)
      ctx.fillStyle = i === selected ? colors.ink : i === 0 || i === points.length - 1 ? colors.ink3 : colors.accent
      ctx.fill()
      ctx.strokeStyle = colors.bg
      ctx.lineWidth = 1.5
      ctx.stroke()
    })
    ctx.fillStyle = colors.ink3
    ctx.font = '10px ui-monospace, Menlo, monospace'
    ctx.fillText(`${height.toFixed(1)}u`, 4, PAD + 10)
    ctx.fillText('ground', 4, H - 3)
  }, [profile, points, selected, height])

  const local = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  const hit = (x: number, y: number): number | null => {
    let best: number | null = null
    let bestD = 8
    points.forEach((p, i) => {
      const [px, py] = toPx(p)
      const d = Math.hypot(px - x, py - y)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }
  const emit = (next: WallProfilePoint[]) => onChange({ points: next, smooth: profile.smooth })

  return (
    <canvas
      ref={canvasRef}
      tabIndex={0}
      style={{ width: W, height: H, display: 'block', borderRadius: 4, border: `1px solid ${colors.line}`, cursor: 'crosshair', outline: 'none' }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        e.currentTarget.focus()
        const [x, y] = local(e)
        const i = hit(x, y)
        if (i !== null) {
          setSelected(i)
          drag.current = i
          return
        }
        const p = fromPx(x, y)
        if (p.t <= 0 || p.t >= 1) return
        const next = [...points.map((q) => ({ ...q })), p].sort((a, b) => a.t - b.t)
        emit(next)
        const idx = next.indexOf(p)
        setSelected(idx)
        drag.current = idx
      }}
      onPointerMove={(e) => {
        const i = drag.current
        if (i === null) return
        const [x, y] = local(e)
        const p = fromPx(x, y)
        const last = points.length - 1
        emit(
          points.map((pt, k) => {
            if (k !== i || k === last) return { ...pt }
            const out = Math.max(-1.5, Math.min(4, Math.round(p.out * 20) / 20))
            if (k === 0) return { out, t: 0 }
            const lo = points[k - 1].t + 0.02
            const hi = points[k + 1].t - 0.02
            return { out, t: Math.max(lo, Math.min(hi, Math.round(p.t * 100) / 100)) }
          }),
        )
      }}
      onPointerUp={() => void (drag.current = null)}
      onKeyDown={(e) => {
        if ((e.key === 'Backspace' || e.key === 'Delete') && selected !== null && selected > 0 && selected < points.length - 1) {
          e.preventDefault()
          emit(points.filter((_, i) => i !== selected).map((q) => ({ ...q })))
          setSelected(null)
        }
      }}
    />
  )
}

export function declareSketchPanels(owner: OwnerId): void {
  panels.declare(owner, { id: 'sketch.bar', title: 'Sketch', slot: 'bar', component: SketchBar })
  panels.declare(owner, { id: 'sketch.inspector', title: 'Sketch', component: SketchInspector })
}
