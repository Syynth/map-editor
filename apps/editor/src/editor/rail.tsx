/**
 * The rail: one button per declared tool, in declaration order, plus the two
 * subjects the design names that no feature implements yet, and the Level
 * gear at the bottom.
 *
 * The list is the registry's, not this file's: `tools.all()` is what the host
 * and the features declared, so a new feature's tool appears here by
 * declaring itself. The glyph is the declaration's `icon`, the chord is
 * whatever the keymap binds `tools.set { tool }` to — a preset that rebinds
 * a tool changes the tooltip without touching this.
 */

import type { ToolId } from '@papercut/editor-host'
import { chordFor, tools, type Platform } from '@papercut/registry'
import { RailButton, RailGap, RailRule, isIconName, type IconName } from '@papercut/ui'

/** Named in the design (Buildings, Fences) and drawn dimmer until a feature declares them. */
const PLANNED: ReadonlyArray<{ title: string; icon: IconName }> = [
  { title: 'Buildings', icon: 'buildings' },
  { title: 'Fences', icon: 'fences' },
]

export function Rail({
  tool,
  onTool,
  levelOpen,
  onLevel,
  platform,
}: {
  tool: ToolId
  onTool: (tool: ToolId) => void
  levelOpen: boolean
  onLevel: () => void
  platform: Platform
}) {
  return (
    <>
      {tools.all().map((decl) => (
        <RailButton
          key={decl.id}
          icon={decl.icon !== undefined && isIconName(decl.icon) ? decl.icon : 'objects'}
          title={decl.title}
          kbd={chordFor('tools.set', { tool: decl.id }, platform)}
          active={tool === decl.id}
          onClick={() => onTool(decl.id)}
        />
      ))}
      {PLANNED.map((entry) => (
        <RailButton key={entry.title} icon={entry.icon} title={entry.title} planned onClick={() => undefined} />
      ))}
      <RailGap />
      <RailRule />
      <RailButton icon="level" title="Level settings" active={levelOpen} onClick={onLevel} />
    </>
  )
}
