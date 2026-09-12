// PROTOTYPE — throwaway. A side-view editor for the wall profile: the
// island's edge seen from the side, outside to the right. Drag points, click
// a segment to add one, Backspace deletes the selected one. The lip point is
// pinned (the lip is the outline); the ground point slides sideways only.
import { useEffect, useRef, useState } from 'react'
import { wallProfilePolyline, type WallProfile, type WallProfilePoint } from '@map-editor/geometry'
import { colors } from '@map-editor/ui'

const W = 292
const H = 170
const PAD = 14
const LIP_X = 110
const PX_PER_UNIT = 44

function toPx(p: WallProfilePoint): [number, number] {
  return [LIP_X + p.out * PX_PER_UNIT, H - PAD - p.t * (H - PAD * 2)]
}

function fromPx(x: number, y: number): WallProfilePoint {
  return { out: (x - LIP_X) / PX_PER_UNIT, t: (H - PAD - y) / (H - PAD * 2) }
}

export function ProfileEditor({ profile, height, onChange }: { profile: WallProfile; height: number; onChange: (p: WallProfile) => void }) {
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

    // ground line and the cap: what the profile hangs between
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

    // the wall as the smoothed polyline actually swept, filled as earth with a grass cap
    const poly = wallProfilePolyline(profile)
    ctx.beginPath()
    ctx.moveTo(0, H - PAD)
    for (const p of poly) {
      const [x, y] = toPx(p)
      ctx.lineTo(x, y)
    }
    ctx.lineTo(0, PAD)
    ctx.closePath()
    ctx.fillStyle = '#5c4630'
    ctx.fill()
    ctx.fillStyle = '#5f9c3f'
    ctx.fillRect(0, PAD - 3, LIP_X, 4)
    ctx.strokeStyle = colors.accent
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < poly.length; i++) {
      const [x, y] = toPx(poly[i])
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // the drawn points, over the swept curve
    ctx.strokeStyle = colors.ink3
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    points.forEach((p, i) => {
      const [x, y] = toPx(p)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
    ctx.setLineDash([])
    points.forEach((p, i) => {
      const [x, y] = toPx(p)
      ctx.beginPath()
      ctx.arc(x, y, 5, 0, Math.PI * 2)
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
    ctx.fillText('out →', W - 36, H - 3)
  }, [profile, points, selected, height])

  const local = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  const hit = (x: number, y: number): number | null => {
    let best: number | null = null
    let bestD = 9
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

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus()
    const [x, y] = local(e)
    const i = hit(x, y)
    if (i !== null) {
      setSelected(i)
      drag.current = i
      return
    }
    // Clicking near a segment adds a point there, kept in height order.
    const p = fromPx(x, y)
    if (p.t <= 0 || p.t >= 1) return
    const next = [...points, p].sort((a, b) => a.t - b.t)
    onChange({ ...profile, points: next })
    const idx = next.indexOf(p)
    setSelected(idx)
    drag.current = idx
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const i = drag.current
    if (i === null) return
    const [x, y] = local(e)
    const p = fromPx(x, y)
    const last = points.length - 1
    const next = points.map((pt, k) => {
      if (k !== i) return pt
      if (k === last) return pt // the lip is the outline
      const out = Math.max(-1.5, Math.min(4, Math.round(p.out * 20) / 20))
      if (k === 0) return { out, t: 0 } // the ground point slides sideways
      const lo = points[k - 1].t + 0.02
      const hi = points[k + 1].t - 0.02
      return { out, t: Math.max(lo, Math.min(hi, Math.round(p.t * 100) / 100)) }
    })
    onChange({ ...profile, points: next })
  }

  const onPointerUp = () => void (drag.current = null)

  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if ((e.key === 'Backspace' || e.key === 'Delete') && selected !== null && selected > 0 && selected < points.length - 1) {
      e.preventDefault()
      onChange({ ...profile, points: points.filter((_, i) => i !== selected) })
      setSelected(null)
    }
  }

  return (
    <canvas
      ref={canvasRef}
      tabIndex={0}
      style={{ width: W, height: H, display: 'block', borderRadius: 4, border: `1px solid ${colors.line}`, cursor: 'crosshair', outline: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    />
  )
}
