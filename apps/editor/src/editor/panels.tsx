/** The React side: palettes, properties, outliner, coverage. */

import { useEffect, useMemo, useRef, useState } from 'react'

import {
  ATMOSPHERE_PRESETS,
  DISPLAY_MODES,
  DIR_NAMES,
  makeAtmosphere,
  type Atmosphere,
  type CameraRig,
  type DeepReadonly,
  type ReadonlyMapDoc,
  type MapObject,
  type RgbaImage,
} from '@map-editor/document'
// Behind the `./textures` subpath, not the package root — see the comment in
// `App.tsx`'s import of the same package.
import { SPRITE_NAMES } from '@map-editor/fixtures/textures'
import { sheetLayoutFor, tileColumnRow } from '@map-editor/geometry'
import { analyseCoverage, type CoverageReport } from '@map-editor/runtime'
import { ColorInput, Field, Note, NumberInput, Panel, Segmented, Select, Slider } from '@map-editor/ui'
import { rgbaToDataUrl } from './rgba'
import type { EditorState } from './state'

// --- tile palette -----------------------------------------------------------

export function TilePalette({
  doc,
  sheet,
  selected,
  onSelect,
}: {
  doc: ReadonlyMapDoc
  sheet: RgbaImage | null
  selected: number
  onSelect: (tile: number) => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const layout = sheetLayoutFor(doc)

  useEffect(() => {
    if (!sheet) return setUrl(null)
    setUrl(rgbaToDataUrl(sheet))
  }, [sheet])

  const { column, row } = tileColumnRow(layout, selected)
  const scale = Math.min(14, Math.max(6, Math.floor(220 / layout.columns)))

  return (
    <div className="palette">
      <div
        className="palette-sheet"
        style={{
          width: layout.columns * scale,
          height: layout.rows * scale,
          backgroundImage: url ? `url(${url})` : undefined,
          backgroundSize: `${layout.columns * scale}px ${layout.rows * scale}px`,
        }}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const tx = Math.floor(((event.clientX - rect.left) / rect.width) * layout.columns)
          const ty = Math.floor(((event.clientY - rect.top) / rect.height) * layout.rows)
          onSelect(ty * layout.columns + tx)
        }}
      >
        <span
          className="palette-cursor"
          style={{ left: column * scale, top: row * scale, width: scale, height: scale }}
        />
      </div>
      <p className="palette-legend">
        Rows 0–3 are the 16 autotile variants; row 4 is cliff top, middle, bottom, then the ramp.
        Each material owns four columns. Alt-click the map to pick a tile up.
      </p>
    </div>
  )
}

// --- tool panel -------------------------------------------------------------

export function ToolPanel({
  doc,
  state,
  sheet,
  set,
  onLoadSheet,
  sheetWarning,
}: {
  doc: ReadonlyMapDoc
  state: EditorState
  sheet: RgbaImage | null
  set: (changes: Partial<EditorState>) => void
  onLoadSheet: (file: File) => void
  sheetWarning: string | null
}) {
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <>
      <Panel title="Tool">
        <Segmented
          value={state.tool}
          onChange={(tool) => set({ tool })}
          options={[
            { value: 'terrain', label: 'Terrain', title: '1' },
            { value: 'object', label: 'Objects', title: '2' },
            { value: 'camera', label: 'Camera', title: '3' },
          ]}
        />

        {state.tool === 'terrain' ? (
          <>
            <Segmented
              value={state.terrainMode}
              onChange={(terrainMode) => set({ terrainMode })}
              options={[
                { value: 'sculpt', label: 'Sculpt', title: 'Tab' },
                { value: 'paint', label: 'Paint', title: 'Tab' },
              ]}
            />

            {state.terrainMode === 'sculpt' ? (
              <Field label="Verb">
                <Segmented
                  value={state.sculptVerb}
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
                  value={state.paintVerb}
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
                value={state.strokeShape}
                onChange={(strokeShape) => set({ strokeShape })}
                options={[
                  { value: 'brush', label: 'Brush' },
                  { value: 'rect', label: 'Rect' },
                  { value: 'fill', label: 'Fill' },
                ]}
              />
            </Field>

            <Field label="Brush size" hint="[ and ]">
              <Slider
                value={state.brush.size}
                min={1}
                max={12}
                onChange={(size) => set({ brush: { ...state.brush, size } })}
              />
            </Field>

            <Field label="Brush shape">
              <Segmented
                value={state.brush.shape}
                onChange={(shape) => set({ brush: { ...state.brush, shape } })}
                options={[
                  { value: 'square', label: 'Square' },
                  { value: 'circle', label: 'Circle' },
                ]}
              />
            </Field>

            {state.sculptVerb === 'ramp' && state.terrainMode === 'sculpt' ? (
              <Field label="Ramp faces" hint="Or just click a cliff face directly">
                <Select
                  value={String(state.rampDir)}
                  onChange={(value) => set({ rampDir: Number(value) })}
                  options={[
                    { value: '-1', label: 'Click a cliff' },
                    ...DIR_NAMES.map((name, index) => ({ value: String(index), label: name })),
                  ]}
                />
              </Field>
            ) : null}

            {state.terrainMode === 'paint' && state.paintVerb === 'tint' ? (
              <Field label="Tint">
                <ColorInput value={state.tint} onChange={(tint) => set({ tint })} />
              </Field>
            ) : null}

            {state.terrainMode === 'paint' && state.paintVerb === 'material' ? (
              <Field label="Material">
                <Select
                  value={String(state.material)}
                  onChange={(value) => set({ material: Number(value) })}
                  options={doc.materials.map((material, index) => ({
                    value: String(index),
                    label: material.name,
                  }))}
                />
              </Field>
            ) : null}
          </>
        ) : null}

        {state.tool === 'object' ? (
          <Field label="Sprite">
            <Select
              value={state.spriteName}
              onChange={(spriteName) => set({ spriteName })}
              options={SPRITE_NAMES.map((name) => ({ value: name, label: name }))}
            />
          </Field>
        ) : null}
      </Panel>

      {state.tool === 'terrain' && state.terrainMode === 'paint' && state.paintVerb === 'tile' ? (
        <Panel
          title="Template sheet"
          aside={
            <button type="button" onClick={() => fileRef.current?.click()}>
              Load PNG
            </button>
          }
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) onLoadSheet(file)
              event.target.value = ''
            }}
          />
          <TilePalette doc={doc} sheet={sheet} selected={state.tile} onSelect={(tile) => set({ tile })} />
          {sheetWarning ? <Note tone="warn">{sheetWarning}</Note> : null}
        </Panel>
      ) : null}
    </>
  )
}

// --- object inspector -------------------------------------------------------

export function ObjectInspector({
  object,
  onChange,
  onDelete,
}: {
  object: DeepReadonly<MapObject> | null
  onChange: (changes: Partial<MapObject>) => void
  onDelete: () => void
}) {
  if (!object) {
    return (
      <Panel title="Properties">
        <Note>Nothing selected. Click an object, or place one with the Objects tool.</Note>
      </Panel>
    )
  }

  const facing = object.facing

  return (
    <Panel
      title="Properties"
      aside={
        <button type="button" onClick={onDelete}>
          Delete
        </button>
      }
    >
      <Field label="Name">
        <input value={object.name} onChange={(event) => onChange({ name: event.target.value })} />
      </Field>

      <Field label="Display" hint="auto picks from the map's camera bounds">
        <Select
          value={object.display}
          onChange={(display) => onChange({ display })}
          options={DISPLAY_MODES.map((mode) => ({ value: mode, label: mode }))}
        />
      </Field>

      <Field label="Scale">
        <Slider
          value={object.scale}
          min={0.2}
          max={4}
          step={0.1}
          onChange={(scale) => onChange({ scale })}
          format={(value) => `${value.toFixed(1)}x`}
        />
      </Field>

      <Field label="Rotation">
        <Slider
          value={object.rotationY}
          min={-180}
          max={180}
          onChange={(rotationY) => onChange({ rotationY })}
          format={(value) => `${Math.round(value)}°`}
        />
      </Field>

      <Field label="Anchored" hint="Rides the terrain when it is sculpted">
        <input
          type="checkbox"
          checked={object.anchorCell !== null}
          onChange={(event) =>
            onChange({
              anchorCell: event.target.checked
                ? [Math.floor(object.position[0]), Math.floor(object.position[2])]
                : null,
            })
          }
        />
      </Field>

      <h3>Facing and flip</h3>

      <Field label="Facings">
        <Segmented
          value={facing.facings}
          onChange={(facings) => onChange({ facing: { ...facing, facings } })}
          options={[
            { value: 1 as const, label: '1' },
            { value: 2 as const, label: '2' },
            { value: 4 as const, label: '4' },
            { value: 8 as const, label: '8' },
          ]}
        />
      </Field>

      <Field label="Mirror" hint="Left reuses the right-hand art">
        <input
          type="checkbox"
          checked={facing.mirror}
          onChange={(event) => onChange({ facing: { ...facing, mirror: event.target.checked } })}
        />
      </Field>

      <Field label="Back side">
        <Select
          value={facing.back}
          onChange={(back) => onChange({ facing: { ...facing, back } })}
          options={[
            { value: 'mirror' as const, label: 'Mirrored front' },
            { value: 'image' as const, label: 'Its own image' },
            { value: 'dark' as const, label: 'Dark silhouette' },
            { value: 'none' as const, label: 'Nothing' },
          ]}
        />
      </Field>

      <Field label="Transition">
        <Select
          value={facing.transition}
          onChange={(transition) => onChange({ facing: { ...facing, transition } })}
          options={[
            { value: 'flip' as const, label: 'Paper flip' },
            { value: 'instant' as const, label: 'Instant' },
            { value: 'crossfade' as const, label: 'Crossfade' },
          ]}
        />
      </Field>

      <Field label="Duration">
        <Slider
          value={facing.durationMs}
          min={60}
          max={900}
          step={20}
          onChange={(durationMs) => onChange({ facing: { ...facing, durationMs } })}
          format={(value) => `${value}ms`}
        />
      </Field>

      <Field label="Hysteresis" hint="Stops the facing flickering on a boundary">
        <Slider
          value={facing.hysteresisDeg}
          min={0}
          max={30}
          onChange={(hysteresisDeg) => onChange({ facing: { ...facing, hysteresisDeg } })}
          format={(value) => `${value}°`}
        />
      </Field>

      <Field label="Hinge">
        <Segmented
          value={facing.hinge}
          onChange={(hinge) => onChange({ facing: { ...facing, hinge } })}
          options={[
            { value: 'center' as const, label: 'Centre' },
            { value: 'base' as const, label: 'Base' },
            { value: 'edge' as const, label: 'Edge' },
          ]}
        />
      </Field>
    </Panel>
  )
}

// --- camera rig -------------------------------------------------------------

export function CameraPanel({
  rig,
  onChange,
  onSweep,
  onPreview,
}: {
  rig: DeepReadonly<CameraRig>
  onChange: (changes: Partial<CameraRig>) => void
  onSweep: () => void
  onPreview: () => void
}) {
  const bounds = rig.bounds
  const setBounds = (changes: Partial<CameraRig['bounds']>) =>
    onChange({ bounds: { ...bounds, ...changes } })

  const yawSpan = Math.abs(bounds.yawMax - bounds.yawMin)

  return (
    <Panel
      title="Camera rig"
      aside={
        <>
          <button type="button" onClick={onPreview}>
            Reset view
          </button>
          <button type="button" onClick={onSweep}>
            Sweep
          </button>
        </>
      }
    >
      <Field label="Projection">
        <Segmented
          value={rig.projection}
          onChange={(projection) => onChange({ projection })}
          options={[
            { value: 'perspective' as const, label: 'Perspective' },
            { value: 'orthographic' as const, label: 'Ortho' },
          ]}
        />
      </Field>

      <Field label="Field of view">
        <Slider value={rig.fov} min={12} max={70} onChange={(fov) => onChange({ fov })} format={(v) => `${v}°`} />
      </Field>

      <h3>Bounds</h3>

      <Field label="Yaw range" hint="The primary question: how much rotation do the games allow?">
        <span className="pair">
          <NumberInput value={bounds.yawMin} min={-180} max={180} onChange={(yawMin) => setBounds({ yawMin })} />
          <NumberInput value={bounds.yawMax} min={-180} max={180} onChange={(yawMax) => setBounds({ yawMax })} />
        </span>
      </Field>

      <div className="preset-row">
        <button type="button" onClick={() => setBounds({ yawMin: -180, yawMax: 180 })}>
          Free
        </button>
        <button type="button" onClick={() => onChange({ bounds: { ...bounds, yawMin: -180, yawMax: 180 }, yawSnapDeg: 90 })}>
          4 detents
        </button>
        <button type="button" onClick={() => onChange({ bounds: { ...bounds, yawMin: 20, yawMax: 70 }, yawSnapDeg: 0 })}>
          Narrow
        </button>
        <button type="button" onClick={() => onChange({ bounds: { ...bounds, yawMin: 45, yawMax: 45 }, yawSnapDeg: 0 })}>
          Fixed
        </button>
      </div>

      <Field label="Pitch range">
        <span className="pair">
          <NumberInput value={bounds.pitchMin} min={0} max={89} onChange={(pitchMin) => setBounds({ pitchMin })} />
          <NumberInput value={bounds.pitchMax} min={0} max={89} onChange={(pitchMax) => setBounds({ pitchMax })} />
        </span>
      </Field>

      <Field label="Zoom range">
        <span className="pair">
          <NumberInput value={bounds.distMin} min={2} max={200} onChange={(distMin) => setBounds({ distMin })} />
          <NumberInput value={bounds.distMax} min={2} max={200} onChange={(distMax) => setBounds({ distMax })} />
        </span>
      </Field>

      <Field label="Yaw detents" hint="0 is continuous rotation">
        <Slider
          value={rig.yawSnapDeg}
          min={0}
          max={90}
          step={15}
          onChange={(yawSnapDeg) => onChange({ yawSnapDeg })}
          format={(value) => (value === 0 ? 'continuous' : `${value}°`)}
        />
      </Field>

      <Note>
        The yaw range spans {Math.round(yawSpan)}°. Free orbit stays available while editing; the
        viewport says when you have left the envelope, and the game-camera toggle (G) clamps you to
        it.
      </Note>
    </Panel>
  )
}

// --- coverage ---------------------------------------------------------------

export function CoveragePanel({
  doc,
  revision,
  onFix,
  onSelect,
}: {
  doc: ReadonlyMapDoc
  /**
   * The store's revision counter. The document is mutated in place, so `doc`
   * never changes identity and memoising on it alone would freeze this readout
   * at whatever the map looked like when the panel first mounted.
   */
  revision: number
  onFix: (id: string) => void
  onSelect: (id: string) => void
}) {
  const report: CoverageReport = useMemo(() => analyseCoverage(doc, doc.camera), [doc, revision])
  const flagged = report.objects.filter((entry) => entry.readsWrong)
  const hiddenPercent =
    report.hiddenSurfaces.totalFaces === 0
      ? 0
      : Math.round((report.hiddenSurfaces.hiddenFaces / report.hiddenSurfaces.totalFaces) * 100)

  return (
    <Panel title="Coverage">
      <p className="readout">
        <strong>{report.total}</strong> objects · <strong>{report.singleFacing}</strong> with one
        facing · <strong>{report.readsWrong}</strong> read wrong inside a {Math.round(report.yawSpanDeg)}°
        yaw range.
      </p>
      <p className="readout">
        Fixing every flag costs about <strong>{report.extraImagesToFix}</strong> more images to draw.
      </p>
      <p className="readout">
        <strong>{hiddenPercent}%</strong> of cliff faces ({report.hiddenSurfaces.hiddenFaces} of{' '}
        {report.hiddenSurfaces.totalFaces}) can never be seen at these bounds, so they need no
        painting.
      </p>

      {flagged.length === 0 ? (
        <Note>Nothing reads wrong at the current bounds.</Note>
      ) : (
        <ul className="coverage-list">
          {flagged.map((entry) => (
            <li key={entry.id}>
              <button type="button" className="link" onClick={() => onSelect(entry.id)}>
                {entry.name}
              </button>
              <span className="coverage-why">{entry.suggestion}</span>
              {entry.edgeOn ? (
                <button type="button" onClick={() => onFix(entry.id)}>
                  Billboard it
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

// --- atmosphere -------------------------------------------------------------

export function AtmospherePanel({
  atmosphere,
  onChange,
}: {
  atmosphere: DeepReadonly<Atmosphere>
  onChange: (changes: Partial<Atmosphere>) => void
}) {
  return (
    <Panel title="Atmosphere">
      <Field label="Preset">
        <Select
          value={atmosphere.preset}
          onChange={(preset) =>
            onChange({
              // Keep the fog distances this map already has: they are scaled to
              // its size, and the preset's are authored against a reference.
              ...makeAtmosphere(preset),
              fogNear: atmosphere.fogNear,
              fogFar: atmosphere.fogFar,
              // Copied, not aliased: the change becomes a patch value the store
              // installs as-is, and the document it came from is read-only.
              backdrop: atmosphere.backdrop.map((card) => ({ ...card })),
            })
          }
          options={Object.keys(ATMOSPHERE_PRESETS).map((name) => ({ value: name, label: name }))}
        />
      </Field>

      <details>
        <summary>Fine tuning</summary>

        <Field label="Sun">
          <Slider
            value={atmosphere.sunIntensity}
            min={0}
            max={3}
            step={0.05}
            onChange={(sunIntensity) => onChange({ sunIntensity })}
            format={(v) => v.toFixed(2)}
          />
        </Field>
        <Field label="Ambient">
          <Slider
            value={atmosphere.ambientIntensity}
            min={0}
            max={2}
            step={0.05}
            onChange={(ambientIntensity) => onChange({ ambientIntensity })}
            format={(v) => v.toFixed(2)}
          />
        </Field>
        <Field label="Sun angle">
          <Slider
            value={atmosphere.sunElevation}
            min={-10}
            max={89}
            onChange={(sunElevation) => onChange({ sunElevation })}
            format={(v) => `${v}°`}
          />
        </Field>
        <Field label="Fog near">
          <Slider value={atmosphere.fogNear} min={0} max={120} onChange={(fogNear) => onChange({ fogNear })} />
        </Field>
        <Field label="Fog far">
          <Slider value={atmosphere.fogFar} min={10} max={300} onChange={(fogFar) => onChange({ fogFar })} />
        </Field>
        <Field label="Bloom">
          <Slider
            value={atmosphere.bloom}
            min={0}
            max={2}
            step={0.05}
            onChange={(bloom) => onChange({ bloom })}
            format={(v) => v.toFixed(2)}
          />
        </Field>
        <Field label="Tilt shift">
          <Slider
            value={atmosphere.tiltShift}
            min={0}
            max={1.5}
            step={0.05}
            onChange={(tiltShift) => onChange({ tiltShift })}
            format={(v) => v.toFixed(2)}
          />
        </Field>
        <Field label="Sky top">
          <ColorInput value={atmosphere.skyTop} onChange={(skyTop) => onChange({ skyTop })} />
        </Field>
        <Field label="Horizon">
          <ColorInput value={atmosphere.skyHorizon} onChange={(skyHorizon) => onChange({ skyHorizon })} />
        </Field>
        <Field label="Fog colour">
          <ColorInput value={atmosphere.fogColor} onChange={(fogColor) => onChange({ fogColor })} />
        </Field>
      </details>

      <h3>Backdrop cards</h3>
      {atmosphere.backdrop.length === 0 ? (
        <Note>
          Painted distant scenery on a cylinder around the map — the no-modeling answer to far-off
          mountains.
        </Note>
      ) : null}
      <button
        type="button"
        onClick={() =>
          onChange({
            backdrop:
              atmosphere.backdrop.length > 0
                ? []
                : [{ sprite: 'mountains', base: -2, height: 15, radius: 70, parallax: 0.9, opacity: 1 }],
          })
        }
      >
        {atmosphere.backdrop.length > 0 ? 'Remove mountains' : 'Add mountains'}
      </button>
    </Panel>
  )
}

// --- outliner ---------------------------------------------------------------

export function Outliner({
  doc,
  selectedId,
  onSelect,
  onChange,
}: {
  doc: ReadonlyMapDoc
  selectedId: string | null
  onSelect: (id: string) => void
  onChange: (id: string, changes: Partial<MapObject>) => void
}) {
  return (
    <Panel title={`Outliner (${doc.objectOrder.length})`}>
      {doc.objectOrder.length === 0 ? <Note>No objects placed yet.</Note> : null}
      <ul className="outliner">
        {doc.objectOrder.map((id) => {
          const object = doc.objects[id]
          if (!object) return null
          return (
            <li key={id} className={id === selectedId ? 'selected' : ''}>
              <button type="button" className="link" onClick={() => onSelect(id)}>
                {object.name}
              </button>
              <span className="outliner-meta">{object.facing.facings}f</span>
              <button
                type="button"
                title={object.hidden ? 'Show' : 'Hide'}
                onClick={() => onChange(id, { hidden: !object.hidden })}
              >
                {object.hidden ? '○' : '●'}
              </button>
              <button
                type="button"
                title={object.locked ? 'Unlock' : 'Lock'}
                onClick={() => onChange(id, { locked: !object.locked })}
              >
                {object.locked ? '🔒' : '🔓'}
              </button>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}
