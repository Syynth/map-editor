/**
 * What floats over the frame: a dialog, a menu, and the crumb button that
 * opens one from the top bar.
 *
 * Mantine's `Modal` and `Menu` underneath (#12: Mantine is this package's
 * implementation detail), skinned by the vocabulary's stylesheet through the
 * class names below. A dialog is quiet the way brink's are — a hairline, the
 * frame's radius, one shadow — and its footer is an `Actions` row, so a
 * dialog's buttons are the inspector's buttons.
 */

import { Menu as MantineMenu, Modal } from '@mantine/core'
import type { ComponentPropsWithRef, ReactNode } from 'react'

import { Icon, type IconName } from './icons'
import { Kbd } from './frame'

export function Dialog({ opened, onClose, title, description, children, footer, width = 460 }: { opened: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; footer?: ReactNode; width?: number }) {
  return (
    <Modal opened={opened} onClose={onClose} title={title} size={width} centered withCloseButton={false} classNames={{ content: 'ui-dialog', header: 'ui-dialog-header', title: 'ui-dialog-title', body: 'ui-dialog-body' }} overlayProps={{ className: 'ui-dialog-scrim' }}>
      {description ? <p className="ui-dialog-description">{description}</p> : null}
      <div className="ui-dialog-fields">{children}</div>
      {footer ? <div className="ui-dialog-footer">{footer}</div> : null}
    </Modal>
  )
}

/** A bordered list of what an action will leave behind — a dialog's "will create" panel. */
export function DialogManifest({ title, rows }: { title: string; rows: ReadonlyArray<{ readonly name: string; readonly note: string; readonly tone?: 'accent' | 'ok' | 'default' }> }) {
  return (
    <div className="ui-manifest">
      <div className="ui-manifest-title">{title}</div>
      <div className="ui-manifest-rows">
        {rows.map((row) => (
          <div key={row.name} className="ui-manifest-row">
            <span className={`ui-manifest-name ${row.tone === 'accent' ? 'is-accent' : row.tone === 'ok' ? 'is-ok' : ''}`}>{row.name}</span>
            <span className="ui-manifest-note">{row.note}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** A menu hanging off `trigger`. Items are `MenuItem`s, grouped by `MenuLabel`s and `MenuDivider`s. */
export function Menu({ trigger, children, width = 268 }: { trigger: ReactNode; children: ReactNode; width?: number }) {
  return (
    <MantineMenu shadow="md" width={width} position="bottom-start" offset={4} classNames={{ dropdown: 'ui-menu', item: 'ui-menu-item', label: 'ui-menu-label', divider: 'ui-menu-divider', itemSection: 'ui-menu-section' }}>
      <MantineMenu.Target>{trigger}</MantineMenu.Target>
      <MantineMenu.Dropdown>{children}</MantineMenu.Dropdown>
    </MantineMenu>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <MantineMenu.Label>{children}</MantineMenu.Label>
}

export function MenuDivider() {
  return <MantineMenu.Divider />
}

export function MenuItem({ title, meta, kbd, icon, active, disabled, tone = 'default', onClick }: { title: string; meta?: string; kbd?: string; icon?: IconName; active?: boolean; disabled?: boolean; tone?: 'default' | 'danger'; onClick: () => void }) {
  return (
    <MantineMenu.Item
      className={`ui-menu-item ${active ? 'is-active' : ''} ${tone === 'danger' ? 'is-danger' : ''}`}
      disabled={disabled}
      leftSection={icon ? <Icon name={icon} size={13} /> : undefined}
      rightSection={kbd ? <Kbd>{kbd}</Kbd> : meta ? <span className="ui-menu-meta">{meta}</span> : undefined}
      onClick={onClick}
    >
      {title}
    </MantineMenu.Item>
  )
}

/**
 * The project's name in the top bar, as the button that opens its menu.
 * Rendered as a `Menu` trigger, which clones it with a ref and handlers, so
 * whatever else arrives is spread onto the button.
 */
export function TopCrumb({ label, title, ...rest }: { label: string; title?: string } & ComponentPropsWithRef<'button'>) {
  return (
    <button type="button" className="ui-top-crumb-btn" title={title} {...rest}>
      <span className="ui-top-crumb">/</span>
      <b>{label}</b>
      <Icon name="chevronDown" size={12} />
    </button>
  )
}
