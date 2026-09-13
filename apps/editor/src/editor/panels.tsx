/**
 * The React side: the bodies of the inspector's sections, and the tile palette.
 *
 * Every control here is a DISPATCH, not a setter: the app's state object is
 * gone (#11, #66 step 7), so a panel takes what it shows as props and calls a
 * callback that the composition root turns into `host.dispatch`. The one
 * exception is the document itself, which the coverage readout selects
 * through `useDocument` — it is the only panel whose work is expensive enough
 * that recomputing it on an unrelated re-render would show.
 *
 * These are section BODIES: `inspector.tsx` wraps each in a `Section` with
 * the title and the glance, so the header is the frame's and the content is
 * the panel's. The terrain tool's controls are not here: they are the terrain
 * feature's own components, declared through the registry with a slot, and
 * rendered by `bars.tsx` and `inspector.tsx` under the tool's owner.
 */

import { useEffect, useState } from 'react'

import {
  ATMOSPHERE_PRESETS,
  DISPLAY_MODES,
  makeAtmosphere,
  type Atmosphere,
  type CameraRig,
  type DeepReadonly,
  type Placement,
  type ReadonlyMapDoc,
  type ReadonlyStructure,
  type MapObject,
  type RgbaImage,
} from '@map-editor/document'
import { useDocument } from '@map-editor/editor-host'
import { sheetLayoutFor, tileColumnRow } from '@map-editor/geometry'
import { analyseCoverage, type CoverageReport } from '@map-editor/runtime'
import {
  Action,
  Actions,
  ColorInput,
  Field,
  Item,
  List,
  Note,
  NumberInput,
  Row,
  Segmented,
  Select,
  Slider,
  TextInput,
  Toggle,
  Verb,
} from '@map-editor/ui'
import { rgbaToDataUrl } from './rgba'

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
  const scale = Math.min(14, Math.max(6, Math.floor(240 / layout.columns)))

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
      <Note>
        Rows 0–3 are the 16 autotile variants; row 4 is cliff top, middle, bottom, then the ramp.
        Each material owns four columns. Alt-click the map to pick a tile up.
      </Note>
    </div>
  )
}

// --- the selected object ------------------------------------------------------

/**
 * A structure's own properties: its name, its kind, and where it sits in its
 * parent — the placement the Select tool drags and the arrows nudge. The
 * root has no parent, so its placement is not offered.
 */
export function StructureProperties({
  doc,
  structure,
  deleteKbd,
  onChange,
  onDelete,
}: {
  doc: ReadonlyMapDoc
  structure: ReadonlyStructure
  deleteKbd?: string
  onChange: (changes: { name?: string; placement?: Placement }) => void
  onDelete: () => void
}) {
  const parent = structure.parent ? doc.structures[structure.parent] : null
  const place = (changes: Partial<Placement>) => onChange({ placement: { ...structure.placement, ...changes } })
  return (
    <>
      <Field label="Name">
        <TextInput value={structure.name} onChange={(name) => (name.trim() ? onChange({ name }) : undefined)} />
      </Field>
      <Row label="Kind" value={structure.kind === 'voxel' ? `voxel volume · ${structure.size.width} × ${structure.size.height}` : `sketch · ${structure.points.length} points · ${structure.layers} layers`} />
      {parent ? (
        <>
          <Row label="On" value={parent.name} />
          <Field label="Placement" hint={`cells from ${parent.name}'s origin`}>
            <Actions>
              <NumberInput value={structure.placement.x} step={structure.kind === 'voxel' ? 1 : 0.5} onChange={(x) => place({ x })} />
              <NumberInput value={structure.placement.z} step={structure.kind === 'voxel' ? 1 : 0.5} onChange={(z) => place({ z })} />
            </Actions>
          </Field>
          <Field label="Facing">
            <Segmented
              value={structure.placement.yaw}
              onChange={(yaw) => place({ yaw })}
              options={[
                { value: 0, label: '0°' },
                { value: 1, label: '90°' },
                { value: 2, label: '180°' },
                { value: 3, label: '270°' },
              ]}
            />
          </Field>
        </>
      ) : (
        <Row label="On" value="the level itself" muted />
      )}
      {parent ? (
        <Actions>
          <Action title="Delete" kbd={deleteKbd} tone="danger" onClick={onDelete} />
        </Actions>
      ) : null}
    </>
  )
}

export function ObjectProperties({
  object,
  deleteKbd,
  onChange,
  onDelete,
}: {
  object: DeepReadonly<MapObject>
  deleteKbd?: string
  onChange: (changes: Partial<MapObject>) => void
  onDelete: () => void
}) {
  return (
    <>
      <Field label="Name">
        <TextInput value={object.name} onChange={(name) => onChange({ name })} />
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

      <Row label="Anchored to the terrain">
        <Toggle
          title="Rides the terrain when it is sculpted"
          checked={object.anchorCell !== null}
          onChange={(checked) =>
            onChange({
              anchorCell: checked ? [Math.floor(object.position[0]), Math.floor(object.position[2])] : null,
            })
          }
        />
      </Row>

      <Actions>
        {/* `selection.delete` is the composite the keymap binds too: it
            expands to `objects.delete({ ids })` plus clearing the selection,
            with the ids filled in outside every actor (#11). */}
        <Action title="Delete" kbd={deleteKbd} tone="danger" onClick={onDelete} />
      </Actions>
    </>
  )
}

export function FacingProperties({
  object,
  onChange,
}: {
  object: DeepReadonly<MapObject>
  onChange: (changes: Partial<MapObject>) => void
}) {
  const facing = object.facing
  return (
    <>
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

      <Row label="Mirror the left from the right">
        <Toggle
          title="Left reuses the right-hand art"
          checked={facing.mirror}
          onChange={(mirror) => onChange({ facing: { ...facing, mirror } })}
        />
      </Row>

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
    </>
  )
}

// --- camera rig -------------------------------------------------------------

export function CameraRigProperties({ rig, onChange }: { rig: DeepReadonly<CameraRig>; onChange: (changes: Partial<CameraRig>) => void }) {
  const bounds = rig.bounds
  const setBounds = (changes: Partial<CameraRig['bounds']>) => onChange({ bounds: { ...bounds, ...changes } })
  const yawSpan = Math.abs(bounds.yawMax - bounds.yawMin)

  return (
    <>
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

      <Field label="Yaw range" hint="The primary question: how much rotation do the games allow?">
        <NumberInput value={bounds.yawMin} min={-180} max={180} onChange={(yawMin) => setBounds({ yawMin })} />
        <NumberInput value={bounds.yawMax} min={-180} max={180} onChange={(yawMax) => setBounds({ yawMax })} />
      </Field>

      <Actions>
        <Action title="Free" onClick={() => setBounds({ yawMin: -180, yawMax: 180 })} />
        <Action title="4 detents" onClick={() => onChange({ bounds: { ...bounds, yawMin: -180, yawMax: 180 }, yawSnapDeg: 90 })} />
        <Action title="Narrow" onClick={() => onChange({ bounds: { ...bounds, yawMin: 20, yawMax: 70 }, yawSnapDeg: 0 })} />
        <Action title="Fixed" onClick={() => onChange({ bounds: { ...bounds, yawMin: 45, yawMax: 45 }, yawSnapDeg: 0 })} />
      </Actions>

      <Field label="Pitch range">
        <NumberInput value={bounds.pitchMin} min={0} max={89} onChange={(pitchMin) => setBounds({ pitchMin })} />
        <NumberInput value={bounds.pitchMax} min={0} max={89} onChange={(pitchMax) => setBounds({ pitchMax })} />
      </Field>

      <Field label="Zoom range">
        <NumberInput value={bounds.distMin} min={2} max={200} onChange={(distMin) => setBounds({ distMin })} />
        <NumberInput value={bounds.distMax} min={2} max={200} onChange={(distMax) => setBounds({ distMax })} />
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
        viewport says when you have left the envelope, and the game-camera toggle clamps you to it.
      </Note>
    </>
  )
}

// --- coverage ---------------------------------------------------------------

/**
 * Module scope, so `useDocument` memoises on the revision alone: an inline
 * arrow is a new function every render and would re-analyse the whole map on
 * any re-render at all. The document is mutated in place, so the revision is
 * the only thing about it that ever changes identity.
 */
const coverageOf = (doc: ReadonlyMapDoc): CoverageReport => analyseCoverage(doc, doc.camera)

/** The one number the section header shows, without rendering the body. */
export function useCoverageFlags(): number {
  return useDocument(coverageOf).readsWrong
}

export function CoverageProperties({ onFix, onSelect }: { onFix: (id: string) => void; onSelect: (id: string) => void }) {
  const report = useDocument(coverageOf)
  const flagged = report.objects.filter((entry) => entry.readsWrong)
  const hiddenPercent =
    report.hiddenSurfaces.totalFaces === 0
      ? 0
      : Math.round((report.hiddenSurfaces.hiddenFaces / report.hiddenSurfaces.totalFaces) * 100)

  return (
    <>
      <Row label="Objects" value={report.total} />
      <Row label="With one facing" value={report.singleFacing} />
      <Row label={`Read wrong in a ${Math.round(report.yawSpanDeg)}° yaw range`} value={report.readsWrong} />
      <Row label="Images to draw to fix them" value={report.extraImagesToFix} />
      <Row label="Cliff faces never seen at these bounds" value={`${hiddenPercent}%`} muted />

      {flagged.length === 0 ? (
        <Note>Nothing reads wrong at the current bounds.</Note>
      ) : (
        <List>
          {flagged.map((entry) => (
            <Item
              key={entry.id}
              name={<span title={entry.suggestion ?? undefined}>{entry.name}</span>}
              meta={entry.edgeOn ? 'edge-on' : 'reads wrong'}
              onClick={() => onSelect(entry.id)}
              trailing={entry.edgeOn ? <Action title="Billboard it" onClick={() => onFix(entry.id)} /> : undefined}
            />
          ))}
        </List>
      )}
    </>
  )
}

// --- atmosphere -------------------------------------------------------------

export function AtmosphereProperties({
  atmosphere,
  onChange,
}: {
  atmosphere: DeepReadonly<Atmosphere>
  onChange: (changes: Partial<Atmosphere>) => void
}) {
  return (
    <>
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

      <Field label="Sun">
        <Slider value={atmosphere.sunIntensity} min={0} max={3} step={0.05} onChange={(sunIntensity) => onChange({ sunIntensity })} format={(v) => v.toFixed(2)} />
      </Field>
      <Field label="Ambient">
        <Slider value={atmosphere.ambientIntensity} min={0} max={2} step={0.05} onChange={(ambientIntensity) => onChange({ ambientIntensity })} format={(v) => v.toFixed(2)} />
      </Field>
      <Field label="Sun angle">
        <Slider value={atmosphere.sunElevation} min={-10} max={89} onChange={(sunElevation) => onChange({ sunElevation })} format={(v) => `${v}°`} />
      </Field>
      <Field label="Fog near">
        <Slider value={atmosphere.fogNear} min={0} max={120} onChange={(fogNear) => onChange({ fogNear })} />
      </Field>
      <Field label="Fog far">
        <Slider value={atmosphere.fogFar} min={10} max={300} onChange={(fogFar) => onChange({ fogFar })} />
      </Field>
      <Field label="Bloom">
        <Slider value={atmosphere.bloom} min={0} max={2} step={0.05} onChange={(bloom) => onChange({ bloom })} format={(v) => v.toFixed(2)} />
      </Field>
      <Field label="Tilt shift">
        <Slider value={atmosphere.tiltShift} min={0} max={1.5} step={0.05} onChange={(tiltShift) => onChange({ tiltShift })} format={(v) => v.toFixed(2)} />
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

      <Row label="Backdrop" value={atmosphere.backdrop.length === 0 ? 'none' : `${atmosphere.backdrop.length} card${atmosphere.backdrop.length === 1 ? '' : 's'}`} muted />
      {atmosphere.backdrop.length === 0 ? (
        <Note>Painted distant scenery on a cylinder around the map — the no-modeling answer to far-off mountains.</Note>
      ) : null}
      <Actions>
        <Action
          title={atmosphere.backdrop.length > 0 ? 'Remove mountains' : 'Add mountains'}
          onClick={() =>
            onChange({
              backdrop:
                atmosphere.backdrop.length > 0
                  ? []
                  : [{ sprite: 'mountains', base: -2, height: 15, radius: 70, parallax: 0.9, opacity: 1 }],
            })
          }
        />
      </Actions>
    </>
  )
}

// --- outliner ---------------------------------------------------------------

export function OutlinerList({
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
  if (doc.objectOrder.length === 0) return <Note>No objects placed yet. Place one with the Objects tool.</Note>
  return (
    <List>
      {doc.objectOrder.map((id) => {
        const object = doc.objects[id]
        if (!object) return null
        return (
          <Item
            key={id}
            name={object.name}
            meta={`${object.facing.facings}f`}
            active={id === selectedId}
            onClick={() => onSelect(id)}
            trailing={
              <>
                <Verb
                  icon={object.hidden ? 'eyeOff' : 'eye'}
                  title={object.hidden ? 'Show' : 'Hide'}
                  onClick={() => onChange(id, { hidden: !object.hidden })}
                />
                <Verb
                  icon={object.locked ? 'lock' : 'unlock'}
                  title={object.locked ? 'Unlock' : 'Lock'}
                  onClick={() => onChange(id, { locked: !object.locked })}
                />
              </>
            }
          />
        )
      })}
    </List>
  )
}
