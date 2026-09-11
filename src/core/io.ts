/**
 * Native project format.
 *
 * Plain JSON, versioned from the first commit. glTF is strictly a build
 * output — nothing here ever tries to read one back in.
 *
 * The prototype keeps a map in a single file. Splitting into a folder of
 * files is cheap to do later precisely because everything goes through these
 * two functions.
 */

import {
  FORMAT_VERSION,
  createMap,
  defaultCameraRig,
  defaultFacing,
  makeAtmosphere,
  DEFAULT_MATERIALS,
  type MapDoc,
  type MapObject,
} from './document'

export class LoadError extends Error {}

/** Migrations run in order, each taking the document one version forward. */
const MIGRATIONS: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = {
  // 0 -> 1 exists as a worked example so the next one is a fill-in-the-blank
  // rather than a design exercise.
  0: (doc) => ({ ...doc, formatVersion: 1, materials: doc.materials ?? DEFAULT_MATERIALS }),
}

export function serialize(doc: MapDoc): string {
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

export function deserialize(text: string): MapDoc {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new LoadError(`Not valid JSON: ${(error as Error).message}`)
  }

  let version = typeof raw.formatVersion === 'number' ? raw.formatVersion : 0
  if (version > FORMAT_VERSION) {
    throw new LoadError(
      `This map was written by a newer editor (format ${version}; this build reads ${FORMAT_VERSION}).`,
    )
  }
  while (version < FORMAT_VERSION) {
    const migrate = MIGRATIONS[version]
    if (!migrate) throw new LoadError(`No migration from format version ${version}.`)
    raw = migrate(raw)
    version = raw.formatVersion as number
  }

  const size = must(raw.size as MapDoc['size'], 'Map has no size.')
  const count = size.width * size.height
  const terrain = must(raw.terrain as MapDoc['terrain'], 'Map has no terrain.')
  for (const field of ['height', 'material', 'ramp', 'water'] as const) {
    const arr = terrain[field]
    if (!Array.isArray(arr) || arr.length !== count) {
      throw new LoadError(
        `terrain.${field} should hold ${count} entries, found ${Array.isArray(arr) ? arr.length : 'none'}.`,
      )
    }
  }

  const base = createMap(size.width, size.height)
  const objectsRaw = (raw.objects ?? {}) as Record<string, Partial<MapObject>>
  const objects: Record<string, MapObject> = {}
  for (const [id, value] of Object.entries(objectsRaw)) objects[id] = normaliseObject(value, id)

  const order = Array.isArray(raw.objectOrder)
    ? (raw.objectOrder as string[]).filter((id) => id in objects)
    : Object.keys(objects)
  for (const id of Object.keys(objects)) if (!order.includes(id)) order.push(id)

  const paint = (raw.paint ?? {}) as Partial<MapDoc['paint']>

  return {
    ...base,
    formatVersion: FORMAT_VERSION,
    id: (raw.id as string) ?? base.id,
    name: (raw.name as string) ?? 'Untitled Map',
    size,
    texelDensity: (raw.texelDensity as number) ?? 16,
    filtering: (raw.filtering as MapDoc['filtering']) ?? 'nearest',
    materials: (raw.materials as MapDoc['materials']) ?? base.materials,
    terrain,
    paint: {
      top: paint.top ?? {},
      cliff: paint.cliff ?? {},
      tint: paint.tint ?? {},
    },
    objects,
    objectOrder: order,
    camera: { ...defaultCameraRig(), ...((raw.camera as MapDoc['camera']) ?? {}) },
    atmosphere: { ...makeAtmosphere(), ...((raw.atmosphere as MapDoc['atmosphere']) ?? {}) },
  }
}
