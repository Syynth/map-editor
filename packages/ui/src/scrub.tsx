/**
 * The scrub field: a number you drag sideways to change, click to type into,
 * or nudge with the arrow keys, shift for coarse steps (ruling of
 * 2026-09-13, "Numeric tool parameters are scrub fields, not sliders").
 *
 * Two faces of one control: `BarScrub` for the context bar, label and value
 * in a compact chip, and `Scrub` for the inspector, stretched across the row.
 * Both share `useScrub`, so a drag, a click and a key mean the same thing
 * everywhere a number is.
 */

import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

import { Tip } from './frame'

export interface ScrubProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  /** Shown after the value: a unit, like `½` for half-tiles. */
  unit?: string
  onChange: (value: number) => void
  format?: (value: number) => string
  /** The tooltip; the label alone when absent. */
  title?: string
  kbd?: string
}

/** Pixels of drag per step. */
const PIXELS_PER_STEP = 8
const COARSE = 4

function useScrub({ value, min, max, step = 1, onChange }: Pick<ScrubProps, 'value' | 'min' | 'max' | 'step' | 'onChange'>) {
  const [editing, setEditing] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ x0: number; v0: number; moved: boolean } | null>(null)
  const decimals = step < 1 ? Math.ceil(-Math.log10(step)) : 0

  const clamp = (v: number): number => {
    if (Number.isNaN(v)) return value
    const snapped = Math.round(v / step) * step
    return Number(Math.min(max, Math.max(min, snapped)).toFixed(decimals))
  }

  const onPointerDown = (event: PointerEvent<HTMLElement>): void => {
    if (editing !== null || event.button !== 0) return
    drag.current = { x0: event.clientX, v0: value, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    const d = drag.current
    if (!d) return
    const dx = event.clientX - d.x0
    if (!d.moved && Math.abs(dx) < 3) return
    if (!d.moved) setDragging(true)
    d.moved = true
    const next = clamp(d.v0 + Math.round(dx / PIXELS_PER_STEP) * step * (event.shiftKey ? COARSE : 1))
    if (next !== value) onChange(next)
  }
  const onPointerUp = (): void => {
    const d = drag.current
    drag.current = null
    setDragging(false)
    // A press that never moved is a click: open the field to type into.
    if (d && !d.moved) setEditing(String(value))
  }
  /** A cancelled or lost pointer ends the drag where it is, without opening the field. */
  const onPointerCancel = (): void => {
    drag.current = null
    setDragging(false)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (editing !== null) return
    const by = step * (event.shiftKey ? COARSE : 1)
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') onChange(clamp(value + by))
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') onChange(clamp(value - by))
    else if (event.key === 'Enter') setEditing(String(value))
    else return
    event.preventDefault()
  }
  const commit = (): void => {
    if (editing !== null) {
      const parsed = clamp(parseFloat(editing))
      if (parsed !== value) onChange(parsed)
    }
    setEditing(null)
  }

  return { editing, setEditing, dragging, commit, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onLostPointerCapture: onPointerCancel, onKeyDown } }
}

function ScrubBody({ label, value, unit, format, wide, ...props }: ScrubProps & { wide: boolean }) {
  const { editing, setEditing, dragging, commit, handlers } = useScrub({ value, min: props.min, max: props.max, step: props.step, onChange: props.onChange })
  return (
    <span className={`ui-scrub ${wide ? 'is-wide' : ''} ${dragging ? 'is-drag' : ''}`} role="spinbutton" aria-label={label} aria-valuenow={value} aria-valuemin={props.min} aria-valuemax={props.max} tabIndex={0} {...handlers}>
      <span className="ui-scrub-label">{label}</span>
      {editing !== null ? (
        <input
          autoFocus
          value={editing}
          onChange={(event) => setEditing(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') setEditing(null)
            event.stopPropagation()
          }}
          onPointerDown={(event) => event.stopPropagation()}
        />
      ) : (
        <span className="ui-scrub-value">{format ? format(value) : value}</span>
      )}
      {unit ? <span className="ui-scrub-unit">{unit}</span> : null}
    </span>
  )
}

/** A scrub field in the context bar. */
export function BarScrub(props: ScrubProps) {
  return (
    <Tip title={props.title ?? `${props.label}: drag to change, click to type, ⇧ for coarse steps`} kbd={props.kbd}>
      <ScrubBody {...props} wide={false} />
    </Tip>
  )
}

/** A scrub field across an inspector row. */
export function Scrub(props: ScrubProps) {
  return <ScrubBody {...props} wide />
}
