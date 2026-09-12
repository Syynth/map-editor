/**
 * Serialisation.
 *
 * One format version, read strictly: no migrations until a level worth
 * keeping exists (ruling of 2026-09-12). A file from another version is
 * refused with a message that says so, never half-read.
 */

import {
  DEFAULT_MATERIALS,
  FORMAT_VERSION,
  createMap,
  defaultCameraRig,
  defaultFacing,
  makeAtmosphere,
  type MapDoc,
  type MapObject,
  type ReadonlyMapDoc,
} from './document'
import { DEFAULT_WALL_PROFILE } from './ops'
import type { SketchStructure, Structure, VoxelStructure } from './structure'

export class LoadError extends Error {}

export function serialize(doc: ReadonlyMapDoc): string {
  return JSON.stringify(doc, null, 2)
}

function must<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) throw new LoadError(message)
  return value
}

function normaliseObject(raw: Partial<MapObject>, id: string): MapObject {
  return {
    id,
    name: raw.name ?? 'Object',
    sprite: raw.sprite ?? 'tree',
    position: raw.position ?? [0, 0, 0],
    rotationY: raw.rotationY ?? 0,
    scale: raw.scale ?? 1,
    display: raw.display ?? 'auto',
    facing: { ...defaultFacing(), ...(raw.facing ?? {}) },
    anchorCell: raw.anchorCell ?? null,
    seed: raw.seed ?? 0,
    locked: raw.locked ?? false,
    hidden: raw.hidden ?? false,
  }
}

function normaliseStructure(raw: Record<string, unknown>, id: string): Structure {
  const base = {
    id,
    name: typeof raw.name === 'string' ? raw.name : 'Structure',
    parent: typeof raw.parent === 'string' ? raw.parent : null,
    placement: { x: 0, z: 0, yaw: 0 as const, ...((raw.placement as Record<string, number>) ?? {}) },
  }
  if (raw.kind === 'voxel') {
    const size = must(raw.size as VoxelStructure['size'], `Structure ${id} has no size.`)
    const count = size.width * size.height
    const terrain = must(raw.terrain as VoxelStructure['terrain'], `Structure ${id} has no terrain.`)
    for (const field of ['height', 'material', 'ramp', 'water'] as const) {
      const arr = terrain[field]
      if (!Array.isArray(arr) || arr.length !== count) {
        throw new LoadError(`${id}.terrain.${field} should hold ${count} entries, found ${Array.isArray(arr) ? arr.length : 'none'}.`)
      }
    }
    const paint = (raw.paint ?? {}) as Partial<VoxelStructure['paint']>
    return { ...base, kind: 'voxel', size, terrain, paint: { top: paint.top ?? {}, cliff: paint.cliff ?? {}, tint: paint.tint ?? {} } }
  }
  if (raw.kind === 'sketch') {
    const wall = (raw.wall ?? {}) as Partial<SketchStructure['wall']>
    return {
      ...base,
      kind: 'sketch',
      points: Array.isArray(raw.points) ? (raw.points as SketchStructure['points']) : [],
      closed: raw.closed === true,
      layers: typeof raw.layers === 'number' ? raw.layers : 3,
      wall: { points: Array.isArray(wall.points) ? wall.points : DEFAULT_WALL_PROFILE.points.map((p) => ({ ...p })), smooth: wall.smooth ?? true },
      lip: (raw.lip as SketchStructure['lip']) ?? 'skirt',
      capMaterial: typeof raw.capMaterial === 'string' ? raw.capMaterial : 'grass',
      wallMaterial: typeof raw.wallMaterial === 'string' ? raw.wallMaterial : 'earth',
    }
  }
  throw new LoadError(`Structure ${id} has an unknown kind: ${String(raw.kind)}.`)
}

export function deserialize(text: string): MapDoc {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch (error) {
    throw new LoadError(`Not valid JSON: ${(error as Error).message}`)
  }
  const version = typeof raw.formatVersion === 'number' ? raw.formatVersion : 0
  if (version !== FORMAT_VERSION) {
    throw new LoadError(
      version > FORMAT_VERSION
        ? `This map was written by a newer editor (format ${version}; this build reads ${FORMAT_VERSION}).`
        : `This map is format ${version}; this build reads only ${FORMAT_VERSION} and carries no migration (none exists yet by ruling).`,
    )
  }

  const structuresRaw = must(raw.structures as Record<string, Record<string, unknown>>, 'Map has no structures.')
  const structures: Record<string, Structure> = {}
  for (const [id, value] of Object.entries(structuresRaw)) structures[id] = normaliseStructure(value, id)
  const structureOrder = Array.isArray(raw.structureOrder) ? (raw.structureOrder as string[]).filter((id) => id in structures) : Object.keys(structures)
  for (const id of Object.keys(structures)) if (!structureOrder.includes(id)) structureOrder.push(id)
  for (const s of Object.values(structures)) {
    if (s.parent !== null && !structures[s.parent]) throw new LoadError(`Structure ${s.id} stands on ${s.parent}, which the map does not have.`)
  }

  const base = createMap(1, 1)
  const objectsRaw = (raw.objects ?? {}) as Record<string, Partial<MapObject>>
  const objects: Record<string, MapObject> = {}
  for (const [id, value] of Object.entries(objectsRaw)) objects[id] = normaliseObject(value, id)
  const order = Array.isArray(raw.objectOrder) ? (raw.objectOrder as string[]).filter((id) => id in objects) : Object.keys(objects)
  for (const id of Object.keys(objects)) if (!order.includes(id)) order.push(id)

  return {
    formatVersion: FORMAT_VERSION,
    id: (raw.id as string) ?? base.id,
    name: (raw.name as string) ?? 'Untitled Map',
    texelDensity: (raw.texelDensity as number) ?? 16,
    filtering: (raw.filtering as MapDoc['filtering']) ?? 'nearest',
    materials: (raw.materials as MapDoc['materials']) ?? DEFAULT_MATERIALS.map((m) => ({ ...m })),
    structures,
    structureOrder,
    objects,
    objectOrder: order,
    camera: { ...defaultCameraRig(), ...((raw.camera as MapDoc['camera']) ?? {}) },
    atmosphere: { ...makeAtmosphere(), ...((raw.atmosphere as MapDoc['atmosphere']) ?? {}) },
  }
}
