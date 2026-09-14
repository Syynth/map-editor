/**
 * The startup screen (design of 2026-09-14, `docs/design/project-flow`):
 * the mark and the name, two doors, the recent projects, and whether to
 * reopen the last one on launch. Mirrors brink's, in this vocabulary.
 *
 * Presentation only: the app hands in what the doors and the rows do. The
 * mark is drawn here rather than shipped as an asset, so it recolours with
 * the tokens and there is nothing to load before the screen shows.
 */

import type { ReactNode } from 'react'

export function StartupScreen({ name, tagline, children }: { name: string; tagline: string; children: ReactNode }) {
  return (
    <div className="ui-startup">
      <div className="ui-startup-column">
        <div className="ui-startup-lockup">
          <svg width="84" height="84" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" className="ui-startup-mark" aria-label={name}>
            <path d="M60,0 C12,0 0,12 0,60 C0,108 12,120 60,120 C108,120 120,108 120,60 C120,12 108,0 60,0 Z" fill="var(--ui-panel)" />
            <path d="M34 26 H72 L90 44 V94 H34 Z" fill="var(--ui-accent)" />
            <path d="M72 26 V44 H90 Z" fill="var(--ui-accent-ink)" />
            <path d="M44 58 H80 M44 70 H80 M44 82 H66" stroke="var(--ui-accent-ink)" strokeWidth="4" strokeLinecap="round" fill="none" />
          </svg>
          <div className="ui-startup-name">{name}</div>
          <div className="ui-startup-tagline">{tagline}</div>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Doors({ children }: { children: ReactNode }) {
  return <div className="ui-doors">{children}</div>
}

/** One way in: a title, what it does, and a tint that says which kind of thing it makes. */
export function Door({ title, body, tone, onClick }: { title: string; body: string; tone: 'ok' | 'accent'; onClick: () => void }) {
  return (
    <button type="button" className="ui-door" onClick={onClick}>
      <span className="ui-door-head">
        <span className={`ui-door-dot ${tone === 'ok' ? 'is-ok' : 'is-accent'}`} />
        <span className="ui-door-title">{title}</span>
      </span>
      <span className="ui-door-body">{body}</span>
    </button>
  )
}

export function StartupSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ui-startup-section">
      <div className="ui-startup-label">{label}</div>
      {children}
    </div>
  )
}

export function RecentList({ children, empty }: { children: ReactNode; empty: string }) {
  return <div className="ui-recents">{children ?? null}{Array.isArray(children) && children.length === 0 ? <div className="ui-recents-empty">{empty}</div> : null}</div>
}

export function RecentRow({ name, path, onClick }: { name: string; path: string; onClick: () => void }) {
  return (
    <button type="button" className="ui-recent" onClick={onClick}>
      <span className="ui-recent-name">{name}</span>
      <span className="ui-recent-path">{path}</span>
    </button>
  )
}

export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className="ui-checkbox">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span className={`ui-checkbox-box ${checked ? 'is-on' : ''}`} />
      <span className="ui-checkbox-label">{children}</span>
    </label>
  )
}

/** A line of feedback under a form: what went wrong, in the artist's terms. */
export function ErrorLine({ children }: { children: ReactNode }) {
  return <div className="ui-error-line">{children}</div>
}
