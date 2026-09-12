// PROTOTYPE — throwaway. Three variants of the lip (how the cap meets the
// wall), switchable via `?variant=flat|skirt|bevel` and the floating bar.
// The question: does profile → extrude → two-material dressing feel like
// the right way to author an island, and which lip reads as Paper Mario?
import { useEffect, useMemo, useRef, useState } from 'react'
import { meshSketch, type LipStyle, type ProfilePoint, type SketchMesh, type WallProfile } from '@map-editor/geometry'
import { Field, Note, Panel, Segmented, Slider } from '@map-editor/ui'

import { LabScene } from './scene'

type Snap = 'grid' | 'half' | 'free'

interface Edge {
  width: number
  segment: number
  repeat: 'tile' | 'stretch'
}

const VARIANTS: LipStyle[] = ['flat', 'skirt', 'bevel']

// A starter island so the lab opens with something to judge: a blob with two
// hard corners at the back so both point kinds are on screen.
const STARTER: ProfilePoint[] = [
  { x: 4, z: 6, smooth: true },
  { x: 8, z: 3, smooth: true },
  { x: 14, z: 3, smooth: false },
  { x: 18, z: 5, smooth: true },
  { x: 19, z: 11, smooth: true },
  { x: 15, z: 15, smooth: true },
  { x: 9, z: 16, smooth: false },
  { x: 5, z: 12, smooth: true },
]

function snapValue(v: number, snap: Snap): number {
  if (snap === 'free') return Math.round(v * 100) / 100
  const step = snap === 'grid' ? 1 : 0.5
  return Math.round(v / step) * step
}

function variantFromUrl(): LipStyle {
  const v = new URLSearchParams(window.location.search).get('variant')
  return VARIANTS.includes(v as LipStyle) ? (v as LipStyle) : 'flat'
}

export function Lab() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<LabScene | null>(null)
  const [points, setPoints] = useState<ProfilePoint[]>(STARTER)
  const [closed, setClosed] = useState(true)
  const [selected, setSelected] = useState<number | null>(null)
  const [layers, setLayers] = useState(6)
  const [snap, setSnap] = useState<Snap>('grid')
  const [fillScale, setFillScale] = useState(0.5)
  const [bodyScale, setBodyScale] = useState(0.5)
  const [rim, setRim] = useState<Edge>({ width: 0.6, segment: 2, repeat: 'stretch' })
  const [top, setTop] = useState<Edge>({ width: 0.5, segment: 2, repeat: 'stretch' })
  const [bottom, setBottom] = useState<Edge>({ width: 0.4, segment: 2, repeat: 'stretch' })
  const [variant, setVariant] = useState<LipStyle>(variantFromUrl)
  const [profile, setProfile] = useState<WallProfile>({ flare: 0.8, shape: 'curve' })
  const [tick, setTick] = useState(0)
  const drag = useRef<{ index: number } | { orbit: { x: number; y: number } } | null>(null)
  const shift = useRef(false)

  const height = layers * 0.5
  const mesh: SketchMesh | null = useMemo(
    () =>
      closed && points.length >= 3
        ? meshSketch({ points }, { height, cap: { fillScale, rim }, wall: { bodyScale, top, bottom }, lip: variant, profile })
        : null,
    [points, closed, height, fillScale, rim, bodyScale, top, bottom, variant, profile],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const scene = new LabScene(canvas)
    sceneRef.current = scene
    return () => {
      scene.dispose()
      sceneRef.current = null
    }
  }, [])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    scene.setMesh(mesh)
    scene.setHandles(points, selected, mesh ? height : 0)
    scene.setPreview(points, closed, mesh ? height + 0.01 : 0)
  }, [mesh, points, closed, selected, height, tick])

  useEffect(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('variant', variant)
    window.history.replaceState(null, '', url)
  }, [variant])

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      shift.current = e.shiftKey
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'Enter' && points.length >= 3) setClosed(true)
      if (e.key === 'Escape') setSelected(null)
      if ((e.key === 'Backspace' || e.key === 'Delete') && points.length > 0) {
        e.preventDefault()
        if (selected !== null) {
          setPoints((p) => p.filter((_, i) => i !== selected))
          setSelected(null)
        } else if (!closed) setPoints((p) => p.slice(0, -1))
      }
      if (e.key.toLowerCase() === 's' && selected !== null) setPoints((p) => p.map((pt, i) => (i === selected ? { ...pt, smooth: !pt.smooth } : pt)))
      if (e.key.toLowerCase() === 'n') {
        setPoints([])
        setClosed(false)
        setSelected(null)
      }
    }
    const up = (e: KeyboardEvent) => void (shift.current = e.shiftKey)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [points.length, selected, closed])

  const snapPick = (x: number, z: number): { x: number; z: number } => {
    const mode: Snap = shift.current ? 'free' : snap
    return { x: snapValue(x, mode), z: snapValue(z, mode) }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const scene = sceneRef.current
    if (!scene) return
    e.currentTarget.setPointerCapture(e.pointerId)
    if (e.button === 2 || e.altKey) {
      drag.current = { orbit: { x: e.clientX, y: e.clientY } }
      return
    }
    if (e.button !== 0) return
    const handle = scene.pickHandle(e.clientX, e.clientY)
    if (handle !== null) {
      // Clicking the first point again closes an open profile.
      if (!closed && handle === 0 && points.length >= 3) {
        setClosed(true)
        return
      }
      setSelected(handle)
      drag.current = { index: handle }
      return
    }
    const hit = scene.pickPlane(e.clientX, e.clientY)
    if (!hit) return
    if (!closed) {
      const p = snapPick(hit.x, hit.z)
      setPoints((prev) => [...prev, { ...p, smooth: !e.shiftKey ? true : false }])
      setSelected(null)
    } else setSelected(null)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const scene = sceneRef.current
    const d = drag.current
    if (!scene || !d) return
    if ('orbit' in d) {
      scene.orbit.yaw -= (e.clientX - d.orbit.x) * 0.4
      scene.orbit.pitch = Math.min(85, Math.max(5, scene.orbit.pitch + (e.clientY - d.orbit.y) * 0.3))
      d.orbit = { x: e.clientX, y: e.clientY }
      return
    }
    const hit = scene.pickPlane(e.clientX, e.clientY)
    if (!hit) return
    const p = snapPick(hit.x, hit.z)
    setPoints((prev) => prev.map((pt, i) => (i === d.index ? { ...pt, x: p.x, z: p.z } : pt)))
  }

  const onPointerUp = () => void (drag.current = null)
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const scene = sceneRef.current
    if (!scene) return
    scene.orbit.distance = Math.min(80, Math.max(6, scene.orbit.distance * Math.exp(e.deltaY * 0.0012)))
    setTick((t) => t + 1)
  }

  const edgeFields = (label: string, edge: Edge, set: (e: Edge) => void) => (
    <>
      <Field label={`${label} width`}>
        <Slider value={edge.width} min={0.1} max={2} step={0.1} onChange={(width) => set({ ...edge, width })} format={(v) => v.toFixed(1)} />
      </Field>
      <Field label={`${label} segment`} hint="World units per texture repeat along the outline">
        <Slider value={edge.segment} min={0.5} max={6} step={0.25} onChange={(segment) => set({ ...edge, segment })} format={(v) => v.toFixed(2)} />
      </Field>
      <Field label={`${label} repeat`}>
        <Segmented
          value={edge.repeat}
          options={[
            { value: 'tile', label: 'Tile', title: 'Repeat on the segment length; the seam may land mid-tile' },
            { value: 'stretch', label: 'Stretch', title: 'A whole number of copies around the outline' },
          ]}
          onChange={(repeat) => set({ ...edge, repeat })}
        />
      </Field>
    </>
  )

  const outline = mesh?.outline
  const copies = (e: Edge) => (outline ? (e.repeat === 'stretch' ? Math.max(1, Math.round(outline.perimeter / e.segment)) : outline.perimeter / e.segment) : 0)

  return (
    <div className="lab">
      <canvas
        ref={canvasRef}
        className="lab-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        onDoubleClick={() => points.length >= 3 && setClosed(true)}
      />
      <aside className="lab-side">
        <Panel title="Profile" aside={<span className="lab-mono">{closed ? 'closed' : 'drawing'}</span>}>
          <Note>
            {closed
              ? 'Drag a point to move it. S toggles smooth/corner on the selected point, Backspace deletes it. N starts a new profile.'
              : 'Click the plane to add points (Shift for a corner). Click the first point, double-click, or Enter to close.'}
          </Note>
          {selected !== null && points[selected] ? (
            <Field label={`Point ${selected + 1}`} hint="S toggles it too; Backspace deletes it">
              <Segmented
                value={points[selected].smooth ? 'smooth' : 'corner'}
                options={[
                  { value: 'smooth', label: 'Smooth', title: 'Rounded by the smoothing' },
                  { value: 'corner', label: 'Corner', title: 'Keeps its exact position and angle' },
                ]}
                onChange={(kind) => setPoints((p) => p.map((pt, i) => (i === selected ? { ...pt, smooth: kind === 'smooth' } : pt)))}
              />
            </Field>
          ) : (
            <Note>Click a point to select it: blue is smooth, orange is a corner.</Note>
          )}
          <Field label="Snap" hint="Hold Shift while dragging for free placement">
            <Segmented
              value={snap}
              options={[
                { value: 'grid', label: 'Grid' },
                { value: 'half', label: '½' },
                { value: 'free', label: 'Free' },
              ]}
              onChange={setSnap}
            />
          </Field>
          <Field label="Height">
            <Slider value={layers} min={1} max={16} step={1} onChange={setLayers} format={(v) => `${v} layers`} />
          </Field>
        </Panel>
        <Panel title="Wall profile">
          <Field label="Flare" hint="How far outside the top outline the base sits">
            <Slider value={profile.flare} min={0} max={3} step={0.1} onChange={(flare) => setProfile({ ...profile, flare })} format={(v) => v.toFixed(1)} />
          </Field>
          <Field label="Shape">
            <Segmented
              value={profile.shape}
              options={[
                { value: 'straight', label: 'Straight', title: 'A straight taper from base to lip' },
                { value: 'curve', label: 'Curve', title: 'Concave: most of the flare stays near the ground' },
              ]}
              onChange={(shape) => setProfile({ ...profile, shape })}
            />
          </Field>
        </Panel>
        <Panel title="Cap material">
          <Field label="Fill scale" hint="Texture repeats per world unit">
            <Slider value={fillScale} min={0.125} max={2} step={0.125} onChange={setFillScale} format={(v) => v.toFixed(3)} />
          </Field>
          {edgeFields('Rim', rim, setRim)}
        </Panel>
        <Panel title="Wall material">
          <Field label="Body scale">
            <Slider value={bodyScale} min={0.125} max={2} step={0.125} onChange={setBodyScale} format={(v) => v.toFixed(3)} />
          </Field>
          {edgeFields('Top', top, setTop)}
          {edgeFields('Bottom', bottom, setBottom)}
        </Panel>
        <Panel title="State">
          <pre className="lab-state">
            {JSON.stringify(
              {
                variant,
                profile,
                points: points.length,
                corners: points.filter((p) => !p.smooth).length,
                outline: outline ? outline.points.length : 0,
                perimeter: outline ? +outline.perimeter.toFixed(2) : 0,
                area: outline ? +outline.area.toFixed(2) : 0,
                height,
                triangles: mesh ? { cap: mesh.cap.triangleCount, rim: mesh.rim.triangleCount, wallBody: mesh.wallBody.triangleCount, wallTop: mesh.wallTop.triangleCount, wallBottom: mesh.wallBottom.triangleCount } : null,
                repeats: { rim: +copies(rim).toFixed(2), top: +copies(top).toFixed(2), bottom: +copies(bottom).toFixed(2) },
              },
              null,
              1,
            )}
          </pre>
        </Panel>
      </aside>
      <div className="lab-bar">
        <span className="lab-bar-label">PROTOTYPE · lip</span>
        {VARIANTS.map((v) => (
          <button key={v} className={v === variant ? 'on' : ''} onClick={() => setVariant(v)}>
            {v}
          </button>
        ))}
        <span className="lab-bar-hint">right-drag orbit · wheel zoom</span>
      </div>
    </div>
  )
}
