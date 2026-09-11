/**
 * Coverage analysis.
 *
 * The brief's primary open question is whether the target games should let the
 * camera rotate at all, and what that costs in art. Without a readout that is
 * a matter of taste; with one it is a trade you can actually price.
 *
 * For every object this asks: across all the yaw angles the rig permits, does
 * this thing ever read wrong — seen close to edge-on, invisible from behind,
 * or showing a facing that is too far from the angle it is being viewed at?
 * Then it prices the fix in images the artist would have to draw.
 *
 * The other half is the payoff the brief hopes for: surfaces that no allowed
 * camera angle can ever see do not need painting, and the mesher could skip
 * them. `hiddenSurfaces` counts those.
 */

import { DIR_VECTORS, type CameraRig, type MapDoc, type MapObject } from '@core/document'
import { cellIndex, inBounds } from '@core/document'
import { resolveDisplayMode } from './billboard'
import { sampleYawEnvelope, wrapDegrees, yawIsFree } from './camera'

const DEG = Math.PI / 180

/** Beyond this incidence a flat plane is edge-on enough to read as a sliver. */
export const EDGE_ON_THRESHOLD_DEG = 68

/** Facing error an 8-direction sprite would never exceed. */
export const FACING_ERROR_BUDGET_DEG = 30

export interface ObjectCoverage {
  id: string
  name: string
  sprite: string
  mode: string
  facings: number
  /** Closest this object ever gets to edge-on, in degrees from face-on. */
  worstIncidenceDeg: number
  edgeOn: boolean
  invisibleFromSomeAngle: boolean
  /** Worst angular gap between the image shown and the angle it is seen from. */
  maxFacingErrorDeg: number
  readsWrong: boolean
  suggestion: string | null
}

export interface CoverageReport {
  objects: ObjectCoverage[]
  total: number
  singleFacing: number
  readsWrong: number
  edgeOn: number
  invisible: number
  yawSpanDeg: number
  /** Images the artist would have to draw to clear every flag. */
  extraImagesToFix: number
  hiddenSurfaces: HiddenSurfaces
}

export interface HiddenSurfaces {
  /** Cliff faces that exist in the mesh. */
  totalFaces: number
  /** Faces no permitted camera angle can see. */
  hiddenFaces: number
}

function analyseObject(object: MapObject, rig: CameraRig, yaws: number[]): ObjectCoverage {
  const mode = resolveDisplayMode(object, rig)
  const facings = object.facing.facings

  // A flat plane is worst when the camera is square to its side. Measure how
  // edge-on it ever gets: 0 is face-on, 90 is a sliver.
  let worstIncidenceDeg = 0
  let invisible = false
  let maxFacingError = 0

  for (const yaw of yaws) {
    const relative = wrapDegrees(yaw - object.rotationY)
    const incidence = Math.abs(relative)

    if (mode === 'fixed') {
      worstIncidenceDeg = Math.max(worstIncidenceDeg, 90 - Math.abs(90 - incidence))
      if (incidence > 90 && object.facing.back === 'none' && facings === 1) invisible = true
    }

    if (facings > 1) {
      // Distance from the angle being viewed to the nearest facing's centre.
      const sector = 360 / facings
      const nearest = Math.round(relative / sector) * sector
      maxFacingError = Math.max(maxFacingError, Math.abs(wrapDegrees(relative - nearest)))
    } else if (mode === 'fixed') {
      // One image seen from every angle: the error is how far the camera has
      // swung off the front, treating the back as a mirror of the front.
      maxFacingError = Math.max(maxFacingError, Math.min(incidence, 180 - incidence))
    }
  }

  const edgeOn = mode === 'fixed' && worstIncidenceDeg >= EDGE_ON_THRESHOLD_DEG

  const facingTooCoarse = facings > 1 && maxFacingError > FACING_ERROR_BUDGET_DEG
  const singleFacingSeenWidely = facings === 1 && mode === 'fixed' && maxFacingError > 60

  const readsWrong = edgeOn || invisible || facingTooCoarse || singleFacingSeenWidely

  let suggestion: string | null = null
  if (edgeOn) suggestion = 'Seen edge-on — switch to a Y billboard or an extruded slab'
  else if (invisible) suggestion = 'Disappears from behind — give it a back side'
  else if (facingTooCoarse) suggestion = `Only ${facings} facings for this yaw range — add more`
  else if (singleFacingSeenWidely) suggestion = 'One image seen from a wide arc — billboard it or add facings'

  return {
    id: object.id,
    name: object.name,
    sprite: object.sprite,
    mode,
    facings,
    worstIncidenceDeg,
    edgeOn,
    invisibleFromSomeAngle: invisible,
    maxFacingErrorDeg: maxFacingError,
    readsWrong,
    suggestion,
  }
}

/**
 * Cliff faces no permitted camera angle can see. A face pointing in direction
 * d is visible from yaw y when the camera stands on its outward side.
 */
function analyseHiddenSurfaces(doc: MapDoc, yaws: number[]): HiddenSurfaces {
  // Direction the camera sits in, for each sampled yaw.
  const eyes = yaws.map((yaw) => [Math.sin(yaw * DEG), Math.cos(yaw * DEG)] as const)

  let totalFaces = 0
  let hiddenFaces = 0

  for (let y = 0; y < doc.size.height; y++) {
    for (let x = 0; x < doc.size.width; x++) {
      const h = doc.terrain.height[cellIndex(doc.size, x, y)]
      for (let dir = 0; dir < 4; dir++) {
        const [dx, dy] = DIR_VECTORS[dir]
        const nx = x + dx
        const ny = y + dy
        const neighbour = inBounds(doc.size, nx, ny)
          ? doc.terrain.height[cellIndex(doc.size, nx, ny)]
          : 0
        const bands = h - neighbour
        if (bands <= 0) continue
        totalFaces += bands

        const visible = eyes.some(([ex, ez]) => ex * dx + ez * dy > 0.08)
        if (!visible) hiddenFaces += bands
      }
    }
  }

  return { totalFaces, hiddenFaces }
}

export function analyseCoverage(doc: MapDoc, rig: CameraRig): CoverageReport {
  const yaws = sampleYawEnvelope(rig, 48)
  const objects = doc.objectOrder
    .map((id) => doc.objects[id])
    .filter((object): object is MapObject => Boolean(object))
    .map((object) => analyseObject(object, rig, yaws))

  const singleFacing = objects.filter((entry) => entry.facings === 1).length
  const readsWrong = objects.filter((entry) => entry.readsWrong).length

  // Bringing a flagged object to four facings takes three images, because the
  // left side mirrors the right.
  const extraImagesToFix = objects
    .filter((entry) => entry.readsWrong)
    .reduce((sum, entry) => sum + Math.max(0, 3 - Math.min(entry.facings, 3)), 0)

  const yawSpanDeg = yawIsFree(rig)
    ? 360
    : Math.abs(wrapDegrees(rig.bounds.yawMax - rig.bounds.yawMin)) || 360

  return {
    objects,
    total: objects.length,
    singleFacing,
    readsWrong,
    edgeOn: objects.filter((entry) => entry.edgeOn).length,
    invisible: objects.filter((entry) => entry.invisibleFromSomeAngle).length,
    yawSpanDeg,
    extraImagesToFix,
    hiddenSurfaces: analyseHiddenSurfaces(doc, yaws),
  }
}
