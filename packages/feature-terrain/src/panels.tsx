/**
 * The terrain tool's panels, as COMPONENTS (#12): `panels.declare` takes a
 * React component rather than a descriptor, which is exactly why a feature
 * package may depend on `ui` and on nothing that knows what Mantine is. Every
 * control here is a `ui` primitive; there is not a style in the file, which
 * is the no-styles rule doing its job rather than being remembered.
 *
 * Two slots (2026-09-12 frame): the BAR is the tool's mode switch, verbs and
 * parameters in one icon-only row — mode first, because it changes what a
 * drag means, then the verb, then the stroke shape and the brush — and the
 * INSPECTOR holds what needs more room than a row: the ramp direction when
 * the ramp verb is up, and the material or tint picker when painting. The
 * tile picker is not here: it needs the loaded sheet, which is the app's.
 *
 * Panels take their state as PROPS rather than reading an actor: the tool
 * parameters live on the host's tools actor, and a feature may not import the
 * host to select from it. Whatever renders a declared panel fills the props
 * in — including `platform`, so the chords the tooltips show come from the
 * keymap rather than from a string written here.
 */

import { DIR_NAMES, type ReadonlyMapDoc } from '@map-editor/document'
import { chordFor, panels, type OwnerId, type Platform } from '@map-editor/registry'
import { BarDivider, BarLabel, BarSlider, ColorInput, Field, IconSegmented, Select } from '@map-editor/ui'

import { terrainKeys } from './keys'
import type { TerrainParams } from './verbs'

export interface TerrainPanelProps {
  readonly doc: ReadonlyMapDoc
  readonly params: TerrainParams
  /** A parameter change, as the partial the tools actor takes. */
  readonly set: (changes: Partial<TerrainParams>) => void
  /** For the chords the tooltips show; the renderer detects it, since this package compiles without a window. */
  readonly platform: Platform
}

export function TerrainBar({ params, set, platform }: TerrainPanelProps) {
  const modeKbd = chordFor('tools.set', { terrainMode: params.terrainMode === 'sculpt' ? 'paint' : 'sculpt' }, platform)
  return (
    <>
      <IconSegmented
        value={params.terrainMode}
        onChange={(terrainMode) => set({ terrainMode })}
        options={[
          { value: 'sculpt', icon: 'sculpt', title: 'Sculpt', kbd: modeKbd },
          { value: 'paint', icon: 'paint', title: 'Paint', kbd: modeKbd },
        ]}
      />
      <BarDivider />
      {params.terrainMode === 'sculpt' ? (
        <IconSegmented
          value={params.sculptVerb}
          onChange={(sculptVerb) => set({ sculptVerb })}
          options={[
            { value: 'raise', icon: 'raise', title: 'Raise — shift lowers' },
            { value: 'flatten', icon: 'flatten', title: 'Flatten to the height under the press' },
            { value: 'ramp', icon: 'ramp', title: 'Ramp — click a cliff face' },
            { value: 'water', icon: 'water', title: 'Water — shift removes it' },
          ]}
        />
      ) : (
        <IconSegmented
          value={params.paintVerb}
          onChange={(paintVerb) => set({ paintVerb })}
          options={[
            { value: 'tile', icon: 'tile', title: 'Paint a tile from the sheet' },
            { value: 'material', icon: 'material', title: 'Paint a material' },
            { value: 'tint', icon: 'tint', title: 'Tint' },
          ]}
        />
      )}
      <BarDivider />
      <BarLabel>Stroke</BarLabel>
      <IconSegmented
        value={params.strokeShape}
        onChange={(strokeShape) => set({ strokeShape })}
        options={[
          { value: 'brush', icon: 'brush', title: 'Brush stroke' },
          { value: 'rect', icon: 'rect', title: 'Rectangle — press to release' },
          { value: 'fill', icon: 'fill', title: 'Flood fill the plateau under the press' },
        ]}
      />
      <IconSegmented
        value={params.brush.shape}
        onChange={(shape) => set({ brush: { ...params.brush, shape } })}
        options={[
          { value: 'square', icon: 'square', title: 'Square brush' },
          { value: 'circle', icon: 'circle', title: 'Round brush' },
        ]}
      />
      <BarLabel>Size</BarLabel>
      <BarSlider
        title="Brush size"
        kbd={[chordFor('brush.resize', { by: -1 }, platform), chordFor('brush.resize', { by: 1 }, platform)].filter(Boolean).join(' ')}
        value={params.brush.size}
        min={1}
        max={12}
        onChange={(size) => set({ brush: { ...params.brush, size } })}
      />
    </>
  )
}

export function TerrainRampPanel({ params, set }: TerrainPanelProps) {
  return (
    <Field label="Ramp faces" hint="Or just click a cliff face directly">
      <Select
        value={String(params.rampDir)}
        onChange={(value) => set({ rampDir: Number(value) })}
        options={[{ value: '-1', label: 'Click a cliff' }, ...DIR_NAMES.map((name, index) => ({ value: String(index), label: name }))]}
      />
    </Field>
  )
}

export function TerrainPaintPanel({ doc, params, set }: TerrainPanelProps) {
  if (params.paintVerb === 'tint') {
    return (
      <Field label="Tint">
        <ColorInput value={params.tint} onChange={(tint) => set({ tint })} />
      </Field>
    )
  }
  if (params.paintVerb === 'material') {
    return (
      <Field label="Material">
        <Select
          value={String(params.material)}
          onChange={(value) => set({ material: Number(value) })}
          options={doc.materials.map((material, index) => ({ value: String(index), label: material.name }))}
        />
      </Field>
    )
  }
  return null
}

export function declareTerrainPanels(owner: OwnerId): void {
  panels.declare(owner, { id: 'terrain.bar', title: 'Terrain', slot: 'bar', component: TerrainBar })
  panels.declare(owner, { id: 'terrain.ramp', title: 'Ramp', component: TerrainRampPanel, when: terrainKeys.verb.is('ramp') })
  panels.declare(owner, { id: 'terrain.paint', title: 'Paint', component: TerrainPaintPanel, when: terrainKeys.mode.is('paint') })
}
