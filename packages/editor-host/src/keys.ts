/**
 * The default keymap (#14, #66 step 6).
 *
 * Every binding the editor shipped before there was a keymap, read off the
 * `window` keydown handler `App.tsx` used to install and restated as data.
 * Nothing here knows about a window: these are declarations, and the one
 * listener that feeds them is the app's, because `registry` and this package
 * both compile without `DOM` and a keydown listener is exactly the thing that
 * would change that.
 *
 * Three of them are TOGGLES, and a toggle is two bindings on one chord rather
 * than one binding that reads the current value — which is #14's fall-through
 * doing the work. `P` is the clearest: `mode.play` and `mode.edit` are
 * already gated on `host.mode`, so the two bindings need no scope of their
 * own and the resolver picks whichever command is available. `Tab` and `G`
 * say the same thing with an explicit `when`, because `tools.set` and
 * `view.set` take any value at any time and cannot gate themselves.
 *
 * `Ctrl` AND `Meta` are both bound for undo and redo, rather than `mod`,
 * because that is what the old handler did — `(event.ctrlKey ||
 * event.metaKey)` on every platform — and this step preserves behaviour
 * rather than tidying it. `mod` is what a USER binding should use; the two
 * specs stay distinct at declare time (`canonicalSpec` leaves `mod` alone) so
 * neither platform sees a phantom conflict.
 */

import { keymap, reserveOwner, type KeyBinding } from '@map-editor/registry'

// `./host` for its side effect only: `mode.play`, `mode.edit`,
// `commands.run` and `selection.delete` are declared at its import, and a
// binding is checked against the command it names. This file is itself
// side-effect-only in the same way — the barrel exports `CORE_KEYMAP_OWNER`
// so that importing `editor-host` is what installs the defaults.

import './host'
import { toolKeys } from './tools'
import { viewKeys } from './view'

export const CORE_KEYMAP_OWNER = reserveOwner('core-keymap')

/** Declaration order is resolution order within a weight, and the resolver scans in reverse. */
const CORE_BINDINGS: readonly KeyBinding[] = [
  { chord: 'ctrl+z', command: 'undo' },
  { chord: 'meta+z', command: 'undo' },
  { chord: 'ctrl+shift+z', command: 'redo' },
  { chord: 'meta+shift+z', command: 'redo' },

  { chord: '1', command: 'tools.set', args: { tool: 'terrain' } },
  { chord: '2', command: 'tools.set', args: { tool: 'object' } },
  // The one composite: the old handler's `set({ tool: 'camera', inspector:
  // 'coverage' })` is two owners' commands, and a binding carries one id.
  {
    chord: '3',
    command: 'commands.run',
    args: {
      commands: [
        { id: 'tools.set', args: { tool: 'camera' } },
        { id: 'view.set', args: { inspector: 'coverage' } },
      ],
    },
  },

  { chord: 'tab', command: 'tools.set', args: { terrainMode: 'paint' }, when: toolKeys.terrainMode.is('sculpt') },
  { chord: 'tab', command: 'tools.set', args: { terrainMode: 'sculpt' }, when: toolKeys.terrainMode.is('paint') },

  { chord: '[', command: 'brush.resize', args: { by: -1 } },
  { chord: ']', command: 'brush.resize', args: { by: 1 } },

  { chord: 'g', command: 'view.set', args: { gameCamera: true }, when: viewKeys.gameCamera.is(false) },
  { chord: 'g', command: 'view.set', args: { gameCamera: false }, when: viewKeys.gameCamera.is(true) },

  // No `when` on either: `hostKeys.mode` already gates the commands, and the
  // resolver ANDs a command's own availability into the binding's condition.
  { chord: 'p', command: 'mode.play' },
  { chord: 'p', command: 'mode.edit' },

  { chord: 'delete', command: 'selection.delete' },
  { chord: 'backspace', command: 'selection.delete' },
]

for (const binding of CORE_BINDINGS) keymap.declare(CORE_KEYMAP_OWNER, { ...binding, weight: 'core' })
