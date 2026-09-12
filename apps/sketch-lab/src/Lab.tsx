// PROTOTYPE — throwaway. Three variants of the lip (how the cap meets the
// wall), switchable via `?variant=flat|skirt|bevel` and the floating bar.
// The question: does profile → extrude → two-material dressing feel like
// the right way to author an island, and which lip reads as Paper Mario?
// Sketches nest: a child's sketch plane is its parent's cap, so tiers stack.
// State is mirrored to localStorage so a refresh keeps the work; Reset wipes it.
import { useEffect, useMemo, useRef, useState } from 'react'
import { meshSketch, wallProfilePreset, type LipStyle, type ProfilePoint, type SketchMesh, type WallProfile } from '@map-editor/geometry'
import { Field, Note, Panel, Segmented, Slider } from '@map-editor/ui'

import { ProfileEditor } from './ProfileEditor'
import { LabScene } from './scene'

type Snap = 'grid' | 'half' | 'free'

interface Edge {
  width: number
  segment: number
  repeat: 'tile' | 'stretch'
}

interface Sketch {
  id: string
  name: string
  /** The sketch this one stands on; its plane is that sketch's cap. */
  parent: string | null
  points: ProfilePoint[]
  closed: boolean
  layers: number
  profile: WallProfile
}

interface Saved {
  sketches: Sketch[]
  activeId: string
  fillScale: number
  bodyScale: number
  rim: Edge
  top: Edge
  bottom: Edge
}

const VARIANTS: LipStyle[] = ['flat', 'skirt', 'bevel']
const STORAGE = 'sketch-lab:v1'

// A starter island so the lab opens with something to judge: a blob with two
// hard corners at the back so both point kinds are on screen, and a tier on it.
const STARTER: Sketch[] = [
  {
    id: 's1',
    name: 'Island',
    parent: null,
    closed: true,
    layers: 6,
    profile: wallProfilePreset('curve', 0.8),
    points: [
      { x: 4, z: 6, smooth: true },
      { x: 8, z: 3, smooth: true },
      { x: 14, z: 3, smooth: false },
      { x: 18, z: 5, smooth: true },
      { x: 19, z: 11, smooth: true },
      { x: 15, z: 15, smooth: true },
      { x: 9, z: 16, smooth: false },
      { x: 5, z: 12, smooth: true },
    ],
  },
  {
    id: 's2',
    name: 'Tier',
    parent: 's1',
    closed: true,
    layers: 3,
    profile: wallProfilePreset('curve', 0.5),
    points: [
      { x: 8, z: 7, smooth: true },
      { x: 13, z: 6, smooth: true },
      { x: 16, z: 9, smooth: true },
      { x: 13, z: 12, smooth: true },
      { x: 9, z: 11, smooth: true },
    ],
  },
]

const DEFAULTS: Saved = {
  sketches: STARTER,
  activeId: 's1',
  fillScale: 0.5,
  bodyScale: 0.5,
  rim: { width: 0.6, segment: 2, repeat: 'stretch' },
  top: { width: 0.5, segment: 2, repeat: 'stretch' },
  bottom: { width: 0.4, segment: 2, repeat: 'stretch' },
}

function load(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE)
    if (!raw) return DEFAULTS
    const saved = JSON.parse(raw) as Partial<Saved>
    return { ...DEFAULTS, ...saved }
  } catch {
    return DEFAULTS
  }
}

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
  const initial = useMemo(load, [])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<LabScene | null>(null)
  const [sketches, setSketches] = useState<Sketch[]>(initial.sketches)
  const [activeId, setActiveId] = useState<string>(initial.activeId)
  const [selected, setSelected] = useState<number | null>(null)
  const [snap, setSnap] = useState<Snap>('grid')
  const [fillScale, setFillScale] = useState(initial.fillScale)
  const [bodyScale, setBodyScale] = useState(initial.bodyScale)
  const [rim, setRim] = useState<Edge>(initial.rim)
  const [top, setTop] = useState<Edge>(initial.top)
  const [bottom, setBottom] = useState<Edge>(initial.bottom)
  const [variant, setVariant] = useState<LipStyle>(variantFromUrl)
  const [tick, setTick] = useState(0)
  const drag = useRef<{ index: number } | { orbit: { x: number; y: number } } | null>(null)
  const shift = useRef(false)

  const active = sketches.find((s) => s.id === activeId) ?? sketches[0]
  const byId = useMemo(() => new Map(sketches.map((s) => [s.id, s])), [sketches])
  // Base height of every sketch: the sum of the heights of what it stands on.
  const bases = useMemo(() => {
    const out = new Map<string, number>()
    const baseOf = (s: Sketch): number => {
      const parent = s.parent ? byId.get(s.parent) : undefined
      return parent ? baseOf(parent) + parent.layers * 0.5 : 0
    }
    for (const s of sketches) out.set(s.id, baseOf(s))
    return out
  }, [sketches, byId])
  const heightOf = (s: Sketch) => s.layers * 0.5
  const baseOf = (s: Sketch) => bases.get(s.id) ?? 0
  const patch = (id: string, changes: Partial<Sketch> | ((s: Sketch) => Partial<Sketch>)) =>
    setSketches((list) => list.map((s) => (s.id === id ? { ...s, ...(typeof changes === 'function' ? changes(s) : changes) } : s)))

  const meshes = useMemo(
    () =>
      sketches.map((s) => ({
        id: s.id,
        base: bases.get(s.id) ?? 0,
        mesh:
          s.closed && s.points.length >= 3
            ? meshSketch({ points: s.points }, { height: s.layers * 0.5, cap: { fillScale, rim }, wall: { bodyScale, top, bottom }, lip: variant, profile: s.profile })
            : null,
      })),
    [sketches, bases, fillScale, rim, bodyScale, top, bottom, variant],
  )
  const activeMesh: SketchMesh | null = meshes.find((m) => m.id === active?.id)?.mesh ?? null
  const activeBase = active ? baseOf(active) : 0
  const activeHeight = active ? heightOf(active) : 0

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
    scene.setMeshes(meshes.filter((m): m is typeof m & { mesh: SketchMesh } => m.mesh !== null))
    const y = activeBase + (activeMesh ? activeHeight : 0)
    scene.setHandles(active?.points ?? [], selected, y)
    scene.setPreview(active?.points ?? [], active?.closed ?? false, y + 0.01)
  }, [meshes, active, activeMesh, activeBase, activeHeight, selected, tick])

  useEffect(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('variant', variant)
    window.history.replaceState(null, '', url)
  }, [variant])

  useEffect(() => {
    const saved: Saved = { sketches, activeId, fillScale, bodyScale, rim, top, bottom }
    try {
      localStorage.setItem(STORAGE, JSON.stringify(saved))
    } catch {
      // storage full or unavailable: the lab still runs, just without the refresh survival
    }
  }, [sketches, activeId, fillScale, bodyScale, rim, top, bottom])

  const nextId = () => `s${sketches.reduce((max, s) => Math.max(max, Number(s.id.slice(1)) || 0), 0) + 1}`

  const addSketch = (parent: string | null) => {
    const id = nextId()
    const parentSketch = parent ? byId.get(parent) : undefined
    setSketches((list) => [
      ...list,
      { id, name: parentSketch ? `Tier on ${parentSketch.name}` : `Island ${id.slice(1)}`, parent, points: [], closed: false, layers: 3, profile: wallProfilePreset('curve', 0.5) },
    ])
    setActiveId(id)
    setSelected(null)
  }

  const removeSketch = (id: string) => {
    // A sketch takes everything standing on it with it.
    const doomed = new Set<string>([id])
    let grew = true
    while (grew) {
      grew = false
      for (const s of sketches) {
        if (s.parent && doomed.has(s.parent) && !doomed.has(s.id)) {
          doomed.add(s.id)
          grew = true
        }
      }
    }
    const rest = sketches.filter((s) => !doomed.has(s.id))
    setSketches(rest)
    if (doomed.has(activeId)) setActiveId(rest[0]?.id ?? '')
    setSelected(null)
  }

  const reset = () => {
    try {
      localStorage.removeItem(STORAGE)
    } catch {
      // nothing to clear
    }
    setSketches(DEFAULTS.sketches)
    setActiveId(DEFAULTS.activeId)
    setFillScale(DEFAULTS.fillScale)
    setBodyScale(DEFAULTS.bodyScale)
    setRim(DEFAULTS.rim)
    setTop(DEFAULTS.top)
    setBottom(DEFAULTS.bottom)
    setSelected(null)
  }

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      shift.current = e.shiftKey
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLCanvasElement) return
      if (!active) return
      if (e.key === 'Enter' && active.points.length >= 3) patch(active.id, { closed: true })
      if (e.key === 'Escape') setSelected(null)
      if ((e.key === 'Backspace' || e.key === 'Delete') && active.points.length > 0) {
        e.preventDefault()
        if (selected !== null) {
          patch(active.id, (s) => ({ points: s.points.filter((_, i) => i !== selected) }))
          setSelected(null)
        } else if (!active.closed) patch(active.id, (s) => ({ points: s.points.slice(0, -1) }))
      }
      if (e.key.toLowerCase() === 's' && selected !== null) patch(active.id, (s) => ({ points: s.points.map((pt, i) => (i === selected ? { ...pt, smooth: !pt.smooth } : pt)) }))
      if (e.key.toLowerCase() === 'n') addSketch(null)
    }
    const up = (e: KeyboardEvent) => void (shift.current = e.shiftKey)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  })

  const snapPick = (x: number, z: number): { x: number; z: number } => {
    const mode: Snap = shift.current ? 'free' : snap
    return { x: snapValue(x, mode), z: snapValue(z, mode) }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const scene = sceneRef.current
    if (!scene || !active) return
    e.currentTarget.setPointerCapture(e.pointerId)
    if (e.button === 2 || e.altKey) {
      drag.current = { orbit: { x: e.clientX, y: e.clientY } }
      return
    }
    if (e.button !== 0) return
    const handle = scene.pickHandle(e.clientX, e.clientY)
    if (handle !== null) {
      // Clicking the first point again closes an open profile.
      if (!active.closed && handle === 0 && active.points.length >= 3) {
        patch(active.id, { closed: true })
        return
      }
      setSelected(handle)
      drag.current = { index: handle }
      return
    }
    const hit = scene.pickPlane(e.clientX, e.clientY, activeBase)
    if (!hit) return
    if (!active.closed) {
      const p = snapPick(hit.x, hit.z)
      patch(active.id, (s) => ({ points: [...s.points, { ...p, smooth: !e.shiftKey }] }))
      setSelected(null)
    } else setSelected(null)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const scene = sceneRef.current
    const d = drag.current
    if (!scene || !d || !active) return
    if ('orbit' in d) {
      scene.orbit.yaw -= (e.clientX - d.orbit.x) * 0.4
      scene.orbit.pitch = Math.min(85, Math.max(5, scene.orbit.pitch + (e.clientY - d.orbit.y) * 0.3))
      d.orbit = { x: e.clientX, y: e.clientY }
      return
    }
    // Handles sit on the cap, so the drag is read on the cap's plane.
    const hit = scene.pickPlane(e.clientX, e.clientY, activeBase + (activeMesh ? activeHeight : 0))
    if (!hit) return
    const p = snapPick(hit.x, hit.z)
    patch(active.id, (s) => ({ points: s.points.map((pt, i) => (i === d.index ? { ...pt, x: p.x, z: p.z } : pt)) }))
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

  const outline = activeMesh?.outline
  const copies = (e: Edge) => (outline ? (e.repeat === 'stretch' ? Math.max(1, Math.round(outline.perimeter / e.segment)) : outline.perimeter / e.segment) : 0)
  const depth = (s: Sketch): number => {
    const parent = s.parent ? byId.get(s.parent) : undefined
    return parent ? depth(parent) + 1 : 0
  }

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
        onDoubleClick={() => active && active.points.length >= 3 && patch(active.id, { closed: true })}
      />
      <aside className="lab-side">
        <Panel
          title="Sketches"
          aside={
            <span className="lab-actions">
              <button onClick={() => addSketch(null)} title="A new sketch on the ground (N)">
                + ground
              </button>
              <button onClick={() => active && addSketch(active.id)} disabled={!active?.closed} title="A new sketch on the selected sketch's cap: a tier">
                + tier
              </button>
              <button onClick={reset} title="Back to the starter island; clears the saved state">
                reset
              </button>
            </span>
          }
        >
          <div className="lab-list">
            {sketches.map((s) => (
              <div key={s.id} className={`lab-row ${s.id === activeId ? 'on' : ''}`} style={{ paddingLeft: 8 + depth(s) * 14 }}>
                <button
                  className="lab-row-name"
                  onClick={() => {
                    setActiveId(s.id)
                    setSelected(null)
                  }}
                >
                  {s.name}
                  <span className="lab-mono"> {s.closed ? `${s.layers}L · base ${baseOf(s).toFixed(1)}` : 'drawing…'}</span>
                </button>
                <button className="lab-row-x" onClick={() => removeSketch(s.id)} title="Delete this sketch and everything on it">
                  ×
                </button>
              </div>
            ))}
            {sketches.length === 0 ? <Note>No sketches. Add one on the ground and click the plane to draw it.</Note> : null}
          </div>
        </Panel>
        {active ? (
          <>
            <Panel title={active.name} aside={<span className="lab-mono">{active.closed ? 'closed' : 'drawing'}</span>}>
              <Note>
                {active.closed
                  ? 'Drag a point to move it. Backspace deletes the selected point.'
                  : `Click the plane at height ${activeBase.toFixed(1)} to add points (Shift for a corner). Click the first point, double-click, or Enter to close.`}
              </Note>
              {selected !== null && active.points[selected] ? (
                <Field label={`Point ${selected + 1}`} hint="S toggles it too; Backspace deletes it">
                  <Segmented
                    value={active.points[selected].smooth ? 'smooth' : 'corner'}
                    options={[
                      { value: 'smooth', label: 'Smooth', title: 'Rounded by the smoothing' },
                      { value: 'corner', label: 'Corner', title: 'Keeps its exact position and angle' },
                    ]}
                    onChange={(kind) => patch(active.id, (s) => ({ points: s.points.map((pt, i) => (i === selected ? { ...pt, smooth: kind === 'smooth' } : pt)) }))}
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
                <Slider value={active.layers} min={1} max={16} step={1} onChange={(layers) => patch(active.id, { layers })} format={(v) => `${v} layers`} />
              </Field>
            </Panel>
            <Panel title="Wall profile" aside={<span className="lab-mono">side view</span>}>
              <ProfileEditor profile={active.profile} height={activeHeight} onChange={(profile) => patch(active.id, { profile })} />
              <Note>Drag points; click between them to add one; Backspace deletes. The lip is pinned to the outline, the ground point slides sideways.</Note>
              <Field label="Start from">
                <Segmented
                  value={'none' as 'none' | 'plumb' | 'straight' | 'curve'}
                  options={[
                    { value: 'plumb', label: 'Plumb' },
                    { value: 'straight', label: 'Taper' },
                    { value: 'curve', label: 'Curve' },
                  ]}
                  onChange={(kind) => kind !== 'none' && patch(active.id, { profile: wallProfilePreset(kind, 0.8) })}
                />
              </Field>
              <Field label="Smooth">
                <Segmented
                  value={active.profile.smooth ? 'on' : 'off'}
                  options={[
                    { value: 'off', label: 'Off' },
                    { value: 'on', label: 'On', title: 'Round the interior points, endpoints held' },
                  ]}
                  onChange={(v) => patch(active.id, (s) => ({ profile: { ...s.profile, smooth: v === 'on' } }))}
                />
              </Field>
            </Panel>
          </>
        ) : null}
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
                sketches: sketches.map((s) => ({ id: s.id, parent: s.parent, base: baseOf(s), height: heightOf(s), points: s.points.length })),
                active: active
                  ? {
                      id: active.id,
                      corners: active.points.filter((p) => !p.smooth).length,
                      profile: active.profile.points.length + (active.profile.smooth ? ' pts, smooth' : ' pts'),
                      outline: outline ? outline.points.length : 0,
                      perimeter: outline ? +outline.perimeter.toFixed(2) : 0,
                      area: outline ? +outline.area.toFixed(2) : 0,
                      triangles: activeMesh
                        ? { cap: activeMesh.cap.triangleCount, rim: activeMesh.rim.triangleCount, wallBody: activeMesh.wallBody.triangleCount, wallTop: activeMesh.wallTop.triangleCount, wallBottom: activeMesh.wallBottom.triangleCount }
                        : null,
                      repeats: { rim: +copies(rim).toFixed(2), top: +copies(top).toFixed(2), bottom: +copies(bottom).toFixed(2) },
                    }
                  : null,
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
