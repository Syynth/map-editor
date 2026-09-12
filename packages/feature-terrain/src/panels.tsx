/**
 * The terrain tool panel, as COMPONENTS (#12): `panels.declare` takes a React
 * component rather than a descriptor, which is exactly why a feature package
 * may depend on `ui` and on nothing that knows what Mantine is. Every control
 * here is a `ui` primitive; there is not a style in the file, which is the
 * no-styles rule doing its job rather than being remembered.
 *
 * These take their state as PROPS rather than reading an actor: the tool
 * parameters live on the host's tools actor, and a feature may not import the
 * host to select from it. Whatever renders a declared panel fills the props in
 * — the app, today, once #66 step 7 rewires it; until then the app's own copy
 * of these controls keeps rendering and this one is declared, enumerable and
 * unmounted.
 *
 * Two panels, not one, because the second has a `when`: the ramp direction is
 * meaningless unless the ramp verb is selected, and the app expressed that as
 * a conditional render inside the panel body. As a declaration it is a
 * predicate over the feature's own context key, which a palette or a panel
 * host can evaluate — and explain — without rendering anything.
 */

import { DIR_NAMES, type ReadonlyMapDoc } from '@map-editor/document'
import { ColorInput, Field, Segmented, Select, Slider } from '@map-editor/ui'
import { panels, type OwnerId } from '@map-editor/registry'

import { terrainKeys } from './keys'
import type { TerrainParams } from './verbs'

export interface TerrainPanelProps {
  readonly doc: ReadonlyMapDoc
  readonly params: TerrainParams
  /** A parameter change, as the partial the tools actor takes. */
  readonly set: (changes: Partial<TerrainParams>) => void
}

export function TerrainBrushPanel({ doc, params, set }: TerrainPanelProps) {
  return (
    <>
      <Segmented
        value={params.terrainMode}
        onChange={(terrainMode) => set({ terrainMode })}
        options={[
          { value: 'sculpt', label: 'Sculpt', title: 'Tab' },
          { value: 'paint', label: 'Paint', title: 'Tab' },
        ]}
      />

      {params.terrainMode === 'sculpt' ? (
        <Field label="Verb">
          <Segmented
            value={params.sculptVerb}
            onChange={(sculptVerb) => set({ sculptVerb })}
            options={[
              { value: 'raise', label: 'Raise' },
              { value: 'flatten', label: 'Flatten' },
              { value: 'ramp', label: 'Ramp' },
              { value: 'water', label: 'Water' },
            ]}
          />
        </Field>
      ) : (
        <Field label="Verb">
          <Segmented
            value={params.paintVerb}
            onChange={(paintVerb) => set({ paintVerb })}
            options={[
              { value: 'tile', label: 'Tile' },
              { value: 'material', label: 'Material' },
              { value: 'tint', label: 'Tint' },
            ]}
          />
        </Field>
      )}

      <Field label="Stroke">
        <Segmented
          value={params.strokeShape}
          onChange={(strokeShape) => set({ strokeShape })}
          options={[
            { value: 'brush', label: 'Brush' },
            { value: 'rect', label: 'Rect' },
            { value: 'fill', label: 'Fill' },
          ]}
        />
      </Field>

      <Field label="Brush size" hint="[ and ]">
        <Slider value={params.brush.size} min={1} max={12} onChange={(size) => set({ brush: { ...params.brush, size } })} />
      </Field>

      <Field label="Brush shape">
        <Segmented
          value={params.brush.shape}
          onChange={(shape) => set({ brush: { ...params.brush, shape } })}
          options={[
            { value: 'square', label: 'Square' },
            { value: 'circle', label: 'Circle' },
          ]}
        />
      </Field>

      {params.terrainMode === 'paint' && params.paintVerb === 'tint' ? (
        <Field label="Tint">
          <ColorInput value={params.tint} onChange={(tint) => set({ tint })} />
        </Field>
      ) : null}

      {params.terrainMode === 'paint' && params.paintVerb === 'material' ? (
        <Field label="Material">
          <Select
            value={String(params.material)}
            onChange={(value) => set({ material: Number(value) })}
            options={doc.materials.map((material, index) => ({ value: String(index), label: material.name }))}
          />
        </Field>
      ) : null}
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

export function declareTerrainPanels(owner: OwnerId): void {
  panels.declare(owner, { id: 'terrain.brush', title: 'Terrain', component: TerrainBrushPanel })
  panels.declare(owner, { id: 'terrain.ramp', title: 'Ramp', component: TerrainRampPanel, when: terrainKeys.verb.is('ramp') })
}
