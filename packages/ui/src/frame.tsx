/**
 * The frame vocabulary: the five regions of the editor and what goes in them.
 *
 * Rail, context bar, stage, inspector, status bar — the shape the 2026-09-12
 * ruling fixed (see `docs/design/select-first.html`). Every control here is
 * icon-only with its label and key in a tooltip, by the same ruling; the
 * words live in `Tip`, and a caller passes a `title` it would otherwise have
 * printed. Nothing here knows what a tool or a command is — an app hands a
 * `RailButton` its title, glyph and chord, and the registry is where those
 * came from.
 *
 * Mantine appears once, for the tooltip: positioning a floating label
 * against the viewport edge is exactly the kind of thing worth not writing.
 */

import { Slider as MantineSlider, Tooltip } from '@mantine/core'
import { useState, type ReactNode } from 'react'

import { Icon, type IconName } from './icons'

// --- atoms -----------------------------------------------------------------------

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>
}

/**
 * A tooltip that carries a control's name and, when it has one, its chord.
 * `kbd` is already formatted for the platform — `formatChord`'s output — so
 * this component never learns what a chord is.
 */
export function Tip({ title, kbd, children }: { title: string; kbd?: string; children: ReactNode }) {
  const label = (
    <span className="ui-tip">
      <span>{title}</span>
      {kbd ? <Kbd>{kbd}</Kbd> : null}
    </span>
  )
  return (
    <Tooltip label={label} openDelay={220} position="bottom" withArrow={false} offset={6}>
      {children}
    </Tooltip>
  )
}

// --- the frame -----------------------------------------------------------------

/** The grid. Each slot is a region; the stage is whatever the app renders the viewport into. */
export function Frame({
  top,
  rail,
  bar,
  stage,
  inspector,
  status,
}: {
  top: ReactNode
  rail: ReactNode
  bar: ReactNode
  stage: ReactNode
  inspector: ReactNode
  status: ReactNode
}) {
  return (
    <div className="ui-frame">
      <header className="ui-top">{top}</header>
      <nav className="ui-rail" aria-label="Tools">
        {rail}
      </nav>
      <div className="ui-bar">{bar}</div>
      <main className="ui-stage">{stage}</main>
      <aside className="ui-insp">{inspector}</aside>
      <footer className="ui-status">{status}</footer>
    </div>
  )
}

// --- top bar -------------------------------------------------------------------

export function Brand({ name, level, dirty }: { name: string; level: string; dirty?: boolean }) {
  return (
    <>
      <span className="ui-top-brand">{name}</span>
      <span className="ui-top-crumb">
        / <b>{level}</b>
      </span>
      {dirty ? <span className="ui-top-dirty" title="Unsaved changes" /> : null}
    </>
  )
}

export function TopGroup({ children }: { children: ReactNode }) {
  return <span className="ui-top-group">{children}</span>
}

export function TopSep() {
  return <span className="ui-top-sep" />
}

export function TopGrow() {
  return <span className="ui-top-grow" />
}

/**
 * A top-bar action. Icon-only unless `primary` (the one accented button) or
 * `labelled` — a file picker, an export — where the word is the affordance.
 */
export function TopButton({
  icon,
  title,
  kbd,
  onClick,
  disabled,
  active,
  primary,
  labelled,
}: {
  icon: IconName
  title: string
  kbd?: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  primary?: boolean
  labelled?: boolean
}) {
  const showLabel = primary || labelled
  const className = ['ui-btn', showLabel ? '' : 'is-icon', active ? 'is-active' : '', primary ? 'is-primary' : ''].join(' ')
  const button = (
    <button type="button" className={className} onClick={onClick} disabled={disabled} aria-label={showLabel ? undefined : title}>
      <Icon name={icon} size={showLabel ? 13 : 16} />
      {showLabel ? <span>{title}</span> : null}
      {showLabel && kbd ? <Kbd>{kbd}</Kbd> : null}
    </button>
  )
  return showLabel ? (
    button
  ) : (
    <Tip title={title} kbd={kbd}>
      {button}
    </Tip>
  )
}

/** A labelled button that opens the file picker; the input rides inside it. */
export function FileButton({ icon, title, accept, onFile }: { icon: IconName; title: string; accept: string; onFile: (file: File) => void }) {
  return (
    <label className="ui-btn is-file">
      <Icon name={icon} size={13} />
      <span>{title}</span>
      <input
        type="file"
        accept={accept}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onFile(file)
          event.target.value = ''
        }}
      />
    </label>
  )
}

// --- rail ----------------------------------------------------------------------

export function RailButton({
  icon,
  title,
  kbd,
  active,
  planned,
  onClick,
}: {
  icon: IconName
  title: string
  kbd?: string
  active?: boolean
  /** Declared in the design but not built: drawn dimmer, with a dot, and still clickable. */
  planned?: boolean
  onClick: () => void
}) {
  const className = ['ui-rail-btn', active ? 'is-active' : '', planned ? 'is-planned' : ''].join(' ')
  return (
    <Tip title={planned ? `${title} (planned)` : title} kbd={kbd}>
      <button type="button" className={className} onClick={onClick} aria-pressed={active} aria-label={title}>
        <Icon name={icon} />
      </button>
    </Tip>
  )
}

export function RailGap() {
  return <span className="ui-rail-gap" />
}

export function RailRule() {
  return <hr className="ui-rail-rule" />
}

// --- context bar ---------------------------------------------------------------

export function BarLabel({ children }: { children: ReactNode }) {
  return <span className="ui-bar-label">{children}</span>
}

export function BarGroup({ children }: { children: ReactNode }) {
  return <span className="ui-bar-group">{children}</span>
}

export function BarDivider() {
  return <span className="ui-bar-divider" />
}

export function BarValue({ children }: { children: ReactNode }) {
  return <span className="ui-bar-value">{children}</span>
}

/** A verb: one icon button in the bar. `active` is for a verb that is a selected mode of its own. */
export function Verb({
  icon,
  title,
  kbd,
  active,
  disabled,
  onClick,
}: {
  icon: IconName
  title: string
  kbd?: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Tip title={title} kbd={kbd}>
      <button type="button" className={`ui-verb ${active ? 'is-active' : ''}`} onClick={onClick} disabled={disabled} aria-pressed={active} aria-label={title}>
        <Icon name={icon} size={17} />
      </button>
    </Tip>
  )
}

/** A parameter in the bar: a short slider with its value beside it, the name and chord in the tooltip. */
export function BarSlider({
  title,
  kbd,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
}: {
  title: string
  kbd?: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  format?: (value: number) => string
}) {
  return (
    <Tip title={title} kbd={kbd}>
      <span className="ui-bar-group">
        <span className="ui-bar-slider">
          <MantineSlider size="xs" min={min} max={max} step={step} value={value} onChange={onChange} label={null} />
        </span>
        <BarValue>{format ? format(value) : value}</BarValue>
      </span>
    </Tip>
  )
}

export interface IconOption<T> {
  readonly value: T
  readonly icon: IconName
  readonly title: string
  readonly kbd?: string
}

/** A mode switch: one of N, icon-only, the active one underlined in the accent. */
export function IconSegmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T
  options: ReadonlyArray<IconOption<T>>
  onChange: (value: T) => void
}) {
  return (
    <span className="ui-seg" role="radiogroup">
      {options.map((option) => (
        <Tip key={String(option.value)} title={option.title} kbd={option.kbd}>
          <button
            type="button"
            role="radio"
            aria-checked={option.value === value}
            aria-label={option.title}
            className={`ui-seg-btn ${option.value === value ? 'is-active' : ''}`}
            onClick={() => onChange(option.value)}
          >
            <Icon name={option.icon} size={16} />
          </button>
        </Tip>
      ))}
    </span>
  )
}

/**
 * A library entry in the bar: a material, a sprite, a style. Shows a glyph
 * when the entry names one, a swatch when it has a colour, and otherwise a
 * two-letter monogram, so an entry the icon set has never heard of still
 * gets a chip rather than a blank.
 */
export function Chip({
  title,
  icon,
  swatch,
  active,
  onClick,
}: {
  title: string
  icon?: IconName
  swatch?: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <Tip title={title}>
      <button type="button" className={`ui-chip ${active ? 'is-active' : ''}`} onClick={onClick} aria-pressed={active} aria-label={title}>
        {icon ? (
          <Icon name={icon} size={16} />
        ) : swatch ? (
          <span className="ui-chip-swatch" style={{ background: swatch }} />
        ) : (
          <span className="ui-chip-mono">{monogram(title)}</span>
        )}
      </button>
    </Tip>
  )
}

function monogram(title: string): string {
  const words = title.trim().split(/[\s_-]+/).filter(Boolean)
  const letters = words.length >= 2 ? words[0][0] + words[1][0] : title.slice(0, 2)
  return letters.toUpperCase()
}

// --- inspector -----------------------------------------------------------------

export function InspectorHead({ children }: { children: ReactNode }) {
  return <div className="ui-insp-head">{children}</div>
}

/**
 * One collapsible section of the inspector. `summary` is the glance at the
 * right of the header — "10 voxels", "Layer 2" — accented when it names
 * something selected. Open state is the section's own by default: what the
 * artist folded stays folded across re-renders, and a caller sets only
 * `defaultOpen`. A caller that needs to open a group of sections from
 * elsewhere — the Level gear on the rail — passes `open` and `onToggle`.
 */
export function Section({
  title,
  summary,
  accent,
  defaultOpen = true,
  open: controlled,
  onToggle,
  children,
}: {
  title: string
  summary?: ReactNode
  accent?: boolean
  defaultOpen?: boolean
  open?: boolean
  onToggle?: (open: boolean) => void
  children: ReactNode
}) {
  const [own, setOwn] = useState(defaultOpen)
  const open = controlled ?? own
  return (
    <details
      className="ui-sec"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open
        if (next === open) return
        setOwn(next)
        onToggle?.(next)
      }}
    >
      <summary>
        {title}
        {summary !== undefined ? <span className={`ui-sec-sum ${accent ? 'is-accent' : ''}`}>{summary}</span> : null}
      </summary>
      <div className="ui-sec-body">{children}</div>
    </details>
  )
}

/** A label on the left and a value or a control on the right. */
export function Row({ label, value, muted, children }: { label: ReactNode; value?: ReactNode; muted?: boolean; children?: ReactNode }) {
  return (
    <div className="ui-row">
      <span>{label}</span>
      {children !== undefined ? (
        <span className="ui-row-control">{children}</span>
      ) : (
        <span className={`ui-row-value ${muted ? 'is-muted' : ''}`}>{value}</span>
      )}
    </div>
  )
}

export function Actions({ children }: { children: ReactNode }) {
  return <div className="ui-actions">{children}</div>
}

export function Action({
  title,
  kbd,
  tone = 'default',
  disabled,
  onClick,
}: {
  title: string
  kbd?: string
  tone?: 'default' | 'accent' | 'danger'
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={`ui-action ${tone === 'accent' ? 'is-accent' : tone === 'danger' ? 'is-danger' : ''}`} onClick={onClick} disabled={disabled}>
      {title}
      {kbd ? <Kbd>{kbd}</Kbd> : null}
    </button>
  )
}

export function List({ children }: { children: ReactNode }) {
  return <div className="ui-list">{children}</div>
}

/** A row in a list: a dot or swatch, a name, and a glance at the right. */
export function Item({
  name,
  meta,
  swatch,
  active,
  onClick,
  trailing,
}: {
  name: ReactNode
  meta?: ReactNode
  swatch?: string
  active?: boolean
  onClick?: () => void
  /** Small controls at the right edge — a hide toggle, a lock — rendered outside the button so a click on them does not also select. */
  trailing?: ReactNode
}) {
  return (
    <div className={`ui-item ${active ? 'is-active' : ''} ${trailing ? 'has-trailing' : ''}`}>
      <span className="ui-item-dot" style={swatch ? { background: swatch } : undefined} />
      {onClick ? (
        <button type="button" className="ui-item-name ui-item-link" onClick={onClick}>
          {name}
        </button>
      ) : (
        <span className="ui-item-name">{name}</span>
      )}
      <span className="ui-item-meta">{meta}</span>
      {trailing ? <span className="ui-row-control">{trailing}</span> : null}
    </div>
  )
}

// --- status bar ----------------------------------------------------------------

export function StatusHints({ children }: { children: ReactNode }) {
  return <div className="ui-status-hints">{children}</div>
}

export function StatusRight({ children }: { children: ReactNode }) {
  return <div className="ui-status-right">{children}</div>
}

/** One hint: a chord and what it does. */
export function Hint({ kbd, children }: { kbd?: string; children: ReactNode }) {
  return (
    <span className="ui-hint">
      {kbd ? <Kbd>{kbd}</Kbd> : null}
      {children}
    </span>
  )
}

// --- viewport overlays ---------------------------------------------------------

export function Overlay({ at, children }: { at: 'top-left' | 'top-center' | 'bottom-center' | 'bottom-right'; children: ReactNode }) {
  return <div className={`ui-overlay is-${at}`}>{children}</div>
}

export function Pill({ warn, children }: { warn?: boolean; children: ReactNode }) {
  return <span className={`ui-pill ${warn ? 'is-warn' : ''}`}>{children}</span>
}
