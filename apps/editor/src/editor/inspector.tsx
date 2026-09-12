/**
 * The inspector: a stack of collapsible sections, opened for what the active
 * tool cares about, with the level's own settings at the bottom behind the
 * rail's gear (2026-09-12 frame).
 *
 * Order is fixed and every section is always mounted, so an artist who folds
 * one finds it where they left it: what changes with the tool is the header
 * and which sections open by default. The three Level sections are the one
 * exception — the gear on the rail opens and closes them together.
 */

import type { Atmosphere, CameraRig, DeepReadonly, MapObject, ReadonlyMapDoc, RgbaImage } from '@map-editor/document'
import type { Selection } from '@map-editor/editor-host'
import type { EditorParams } from './params'
import type { Platform } from '@map-editor/registry'
import { FileButton, InspectorHead, Note, Row, Section } from '@map-editor/ui'

import { FeaturePanels } from './bars'
import {
  AtmosphereProperties,
  CameraRigProperties,
  CoverageProperties,
  FacingProperties,
  ObjectProperties,
  OutlinerList,
  TilePalette,
  useCoverageFlags,
} from './panels'

const TITLES: Record<string, string> = { select: 'Select', terrain: 'Terrain', object: 'Objects' }

export function Inspector({
  doc,
  params,
  set,
  platform,
  selection,
  selected,
  deleteKbd,
  levelOpen,
  onLevelToggle,
  sheet,
  sheetWarning,
  onLoadSheet,
  onSelect,
  onObject,
  onObjectChange,
  onDelete,
  onRig,
  onAtmosphere,
  onFix,
  message,
}: {
  doc: ReadonlyMapDoc
  params: EditorParams
  set: (changes: Partial<EditorParams>) => void
  platform: Platform
  selection: Selection | null
  selected: DeepReadonly<MapObject> | null
  deleteKbd?: string
  levelOpen: boolean
  onLevelToggle: (open: boolean) => void
  sheet: RgbaImage | null
  sheetWarning: string | null
  onLoadSheet: (file: File) => void
  /** Select an object by id, from the outliner or the coverage list. */
  onSelect: (id: string) => void
  /** A change to the selected object. */
  onObject: (changes: Partial<MapObject>) => void
  /** A change to any object by id. */
  onObjectChange: (id: string, changes: Partial<MapObject>) => void
  onDelete: () => void
  onRig: (changes: Partial<CameraRig>) => void
  onAtmosphere: (changes: Partial<Atmosphere>) => void
  onFix: (id: string) => void
  message: string | null
}) {
  const flags = useCoverageFlags()
  const isTerrain = params.tool === 'terrain'
  const tilePicker = isTerrain && params.terrainMode === 'paint' && params.paintVerb === 'tile'

  return (
    <>
      <InspectorHead>{TITLES[params.tool] ?? params.tool}</InspectorHead>

      <Section title="Selection" summary={selected ? selected.name : 'empty'} accent={selected !== null} defaultOpen>
        {selected ? (
          <ObjectProperties object={selected} deleteKbd={deleteKbd} onChange={onObject} onDelete={onDelete} />
        ) : (
          <Note>Nothing selected. Click an object with Select, or place one with Objects.</Note>
        )}
      </Section>

      {selected ? (
        <Section title="Facing & flip" summary={`${selected.facing.facings} facing${selected.facing.facings === 1 ? '' : 's'}`} defaultOpen={false}>
          <FacingProperties object={selected} onChange={onObject} />
        </Section>
      ) : null}

      {isTerrain ? (
        <Section title="Brush" summary={`${params.brush.size} · ${params.brush.shape}`}>
          <Row label="Size" value={`${params.brush.size} cells`} />
          <Row label="Shape" value={params.brush.shape} />
          <FeaturePanels slot="inspector" tool={params.tool} doc={doc} params={params} platform={platform} selection={selection} />
        </Section>
      ) : null}

      {/* The sheet itself is the app's: an artist loads a PNG here, and the
          generated fallback comes from the composition root (#47). The tile
          the brush lays down is a tool parameter like any other. */}
      {tilePicker ? (
        <Section title="Template sheet" summary={`tile ${params.tile}`}>
          <TilePalette doc={doc} sheet={sheet} selected={params.tile} onSelect={(tile) => set({ tile })} />
          <FileButton icon="open" title="Load PNG" accept="image/png,image/*" onFile={onLoadSheet} />
          {sheetWarning ? <Note tone="warn">{sheetWarning}</Note> : null}
        </Section>
      ) : null}

      <Section title="Objects" summary={doc.objectOrder.length} defaultOpen={params.tool !== 'terrain'}>
        <OutlinerList doc={doc} selectedId={selected?.id ?? null} onSelect={onSelect} onChange={onObjectChange} />
      </Section>

      <Section title="Camera rig" summary={`${Math.abs(doc.camera.bounds.yawMax - doc.camera.bounds.yawMin)}° yaw`} open={levelOpen} onToggle={onLevelToggle}>
        <CameraRigProperties rig={doc.camera} onChange={onRig} />
      </Section>

      <Section title="Atmosphere" summary={doc.atmosphere.preset} open={levelOpen} onToggle={onLevelToggle}>
        <AtmosphereProperties atmosphere={doc.atmosphere} onChange={onAtmosphere} />
      </Section>

      <Section title="Coverage" summary={flags === 0 ? 'clean' : `${flags} flagged`} accent={flags > 0} open={levelOpen} onToggle={onLevelToggle}>
        <CoverageProperties onSelect={onSelect} onFix={onFix} />
      </Section>

      {message ? (
        <Section title="Last action" defaultOpen>
          <Note>{message}</Note>
        </Section>
      ) : null}
    </>
  )
}
