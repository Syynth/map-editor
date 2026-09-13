/**
 * The feature's context keys and bindings, minted under its owner.
 *
 * Two keys: which mode the tool is in, and whether an outline is open under
 * the pen. The bindings hang off the second: Enter finishes the outline and
 * Escape abandons it only while one is open, so with none open both keys
 * fall through to whatever the core keymap does with them.
 */

import { defineContextKey, keymap, type ContextKey, type KeyValue, type OwnerId } from '@papercut/registry'

import type { SketchMode } from './params'

let mode: ContextKey<SketchMode> | null = null
let drawing: ContextKey<boolean> | null = null

export function defineSketchKeys(owner: OwnerId): void {
  mode = defineContextKey<SketchMode>(owner, 'sketch.mode', 'draw')
  drawing = defineContextKey<boolean>(owner, 'sketch.drawing', false)
  keymap.declare(owner, { chord: 'k', command: 'tools.set', args: { tool: 'sketch' }, weight: 'feature' })
  keymap.declare(owner, { chord: 'enter', command: 'sketch.finish', when: drawing.is(true), weight: 'feature' })
  keymap.declare(owner, { chord: 'escape', command: 'sketch.cancel', when: drawing.is(true), weight: 'feature' })
}

function minted<T extends KeyValue>(key: ContextKey<T> | null): ContextKey<T> {
  if (!key) throw new Error('sketch context keys are not minted yet: defineSketchKeys(owner) runs first, in index.ts')
  return key
}

export const sketchKeys = {
  get mode(): ContextKey<SketchMode> {
    return minted(mode)
  },
  get drawing(): ContextKey<boolean> {
    return minted(drawing)
  },
}
