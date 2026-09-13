/**
 * The context bar: the ACTIVE tool's mode switch, verbs and parameters in one
 * icon-only row. Switching tools swaps the whole bar.
 *
 * Which bar is the registry's decision where it can be: a tool's owner may
 * declare panels with `slot: 'bar'`, and `FeaturePanels` renders those under
 * the owner's own `when`s. The host's two tools declare no panels — Select
 * and Objects are the app's to draw, since their controls (the selection's
 * name, the sprite library) are things only the app holds.
 */

import type { Selection } from '@map-editor/editor-host'
import type { EditorParams } from './params'
import { useHost } from '@map-editor/editor-host'
import type { ReadonlyMapDoc, SnapMode } from '@map-editor/document'
import { SPRITE_NAMES } from '@map-editor/fixtures/textures'
import type { TerrainPanelProps } from '@map-editor/feature-terrain'
import { always, chordFor, evaluate, panels, tools, type PanelSlot, type Platform } from '@map-editor/registry'
import { BarDivider, BarGroup, BarLabel, BarValue, Chip, IconSegmented, Verb, type IconName } from '@map-editor/ui'
import type { ComponentType } from 'react'

/**
 * The panels the active tool's owner declared for `slot`, in declaration
 * order, each shown only while its own `when` holds (#9, #12). The rule is
 * the registry's rather than a list of feature names: the tool registry says
 * whose tool `terrain` is, and that owner's panels are the ones that edit the
 * parameters a stroke with that tool reads — the same join by declaring owner
 * that `Host.toolContract` makes for the handler.
 *
 * The cast is the app's to make and nobody else's. A `PanelDecl` carries an
 * opaque component because `registry` sits below React (#3), and what props
 * it takes is the feature's business; an app is the only thing that sees both
 * halves (#35), and this app installs one feature, whose panels take the doc,
 * the parameters, a setter and the platform.
 */
export function FeaturePanels({
  slot,
  tool,
  doc,
  params,
  platform,
  selection,
}: {
  slot: PanelSlot
  tool: string
  doc: ReadonlyMapDoc
  params: EditorParams
  platform: Platform
  selection: Selection | null
}) {
  const host = useHost()
  const owner = tools.ownerOf(tool)
  // A feature's panels set the feature's own parameters: the command it declared, under its owner's name.
  const setOwn = (changes: Partial<EditorParams>) => void host.dispatch(`${owner}.params`, changes)
  // Derived per render, never held: the same rule `dispatch` follows (#8's
  // finding 2). A panel gated on the ramp verb has to appear the render after
  // the verb changed, and this component re-renders with the parameters.
  const keys = host.contextKeys()
  if (owner === undefined) return null

  return (
    <>
      {panels
        .all()
        .filter((decl) => panels.ownerOf(decl.id) === owner && (decl.slot ?? 'inspector') === slot && evaluate(decl.when ?? always, keys).available)
        .map((decl) => {
          const Component = decl.component as ComponentType<TerrainPanelProps & { dispatch?: (id: string, args?: unknown) => void; selection?: Selection | null }>
          return <Component key={decl.id} doc={doc} params={params} set={setOwn} platform={platform} dispatch={(id, args) => void host.dispatch(id, args)} selection={selection} />
        })}
    </>
  )
}

/** The glyphs the fixture sprites have; the rest get a monogram chip. */
const SPRITE_ICONS: Partial<Record<string, IconName>> = { tree: 'tree', bush: 'bush', rock: 'rock', lamp: 'lamp', sign: 'sign' }

/** What the selection is, in words: the object's or structure's name, or which point of which sketch. */
export function describeSelection(doc: ReadonlyMapDoc, selection: Selection | null): string | null {
  switch (selection?.kind) {
    case 'object':
      return doc.objects[selection.id]?.name ?? null
    case 'structure':
      return doc.structures[selection.id]?.name ?? null
    case 'sketchPoint':
      return doc.structures[selection.structure] ? `point ${selection.index + 1} of ${doc.structures[selection.structure]?.name}` : null
    default:
      return null
  }
}

/** The snap setting, as both host tools offer it (ruling of 2026-09-12, "Select tool"); icons, as every bar control is. */
export function SnapControl({ value, onChange }: { value: SnapMode; onChange: (snap: SnapMode) => void }) {
  return (
    <>
      <BarLabel>Snap</BarLabel>
      <IconSegmented
        value={value}
        onChange={onChange}
        options={[
          { value: 'grid', icon: 'snapGrid', title: 'Snap to whole cells' },
          { value: 'half', icon: 'snapHalf', title: 'Snap to half cells' },
          { value: 'free', icon: 'snapFree', title: 'No snapping — holding ctrl (⌘ on a Mac) does this too' },
        ]}
      />
    </>
  )
}

export function SelectBar({
  doc,
  selection,
  params,
  set,
  platform,
  onDelete,
  onClear,
}: {
  doc: ReadonlyMapDoc
  selection: Selection | null
  params: EditorParams
  set: (changes: Partial<EditorParams>) => void
  platform: Platform
  onDelete: () => void
  onClear: () => void
}) {
  const named = describeSelection(doc, selection)
  return (
    <>
      <BarLabel>Selection</BarLabel>
      <BarValue>{named ?? 'nothing'}</BarValue>
      <BarDivider />
      <BarGroup>
        <Verb icon="trash" title="Delete the selection" kbd={chordFor('selection.delete', undefined, platform)} disabled={named === null} onClick={onDelete} />
        <Verb icon="clear" title="Clear the selection" disabled={named === null} onClick={onClear} />
      </BarGroup>
      <BarDivider />
      <SnapControl value={params.snap} onChange={(snap) => set({ snap })} />
      <BarDivider />
      {/* The region half of Select — marquee, expand, contract, invert — is
          designed (docs/design/select-first.html) and waits on a typed
          selection on the view actor (#100 records the voxel data it wants).
          Shown disabled so the bar has its final shape rather than growing
          later; each tooltip says why it does nothing yet. */}
      <BarGroup>
        <Verb icon="move" title="Move the region — not built yet" disabled onClick={() => undefined} />
        <Verb icon="expand" title="Expand the region — not built yet" disabled onClick={() => undefined} />
        <Verb icon="contract" title="Contract the region — not built yet" disabled onClick={() => undefined} />
        <Verb icon="invert" title="Invert the region — not built yet" disabled onClick={() => undefined} />
      </BarGroup>
    </>
  )
}

export function ObjectBar({ params, set }: { params: EditorParams; set: (changes: Partial<EditorParams>) => void }) {
  return (
    <>
      <BarLabel>Sprite</BarLabel>
      <BarGroup>
        {SPRITE_NAMES.map((name) => (
          <Chip key={name} title={name} icon={SPRITE_ICONS[name]} active={params.spriteName === name} onClick={() => set({ spriteName: name })} />
        ))}
      </BarGroup>
      <BarDivider />
      <BarValue>{params.spriteName}</BarValue>
      <BarDivider />
      <SnapControl value={params.snap} onChange={(snap) => set({ snap })} />
    </>
  )
}
