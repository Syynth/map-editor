/**
 * The camera rig.
 *
 * A rig is data — yaw, pitch, distance, fov, bounds, snapping, projection —
 * and this module is the single place that turns it into an actual camera.
 * The editor viewport, play mode and the exported runtime all go through it,
 * so "the game camera" means exactly one thing.
 *
 * The editor is allowed to orbit outside the rig's bounds, because being able
 * to look at the map freely while building it is not the same question as what
 * the game permits. `withinBounds` tells the viewport when it has left the
 * game's envelope so it can say so, and `clampToBounds` is what the
 * game-camera toggle applies.
 */

import * as THREE from 'three'

import type { CameraRig, DeepReadonly } from '@map-editor/document'

export interface RigState {
  yaw: number
  pitch: number
  distance: number
  target: THREE.Vector3
}

export function wrapDegrees(value: number): number {
  let v = ((value + 180) % 360) - 180
  if (v < -180) v += 360
  return v
}

/**
 * True when the yaw range covers the full circle, in which case no yaw is ever
 * out of bounds. Without this a rig of -180..180 would reject yaw 180.0001.
 */
export function yawIsFree(rig: DeepReadonly<CameraRig>): boolean {
  return rig.bounds.yawMax - rig.bounds.yawMin >= 359.999
}

export function yawWithinBounds(rig: DeepReadonly<CameraRig>, yaw: number): boolean {
  if (yawIsFree(rig)) return true
  const { yawMin, yawMax } = rig.bounds
  const y = wrapDegrees(yaw)
  if (yawMin <= yawMax) return y >= yawMin && y <= yawMax
  // A range that wraps past 180, e.g. 150..-150.
  return y >= yawMin || y <= yawMax
}

export function withinBounds(rig: DeepReadonly<CameraRig>, state: Pick<RigState, 'yaw' | 'pitch' | 'distance'>): boolean {
  return (
    yawWithinBounds(rig, state.yaw) &&
    state.pitch >= rig.bounds.pitchMin - 1e-6 &&
    state.pitch <= rig.bounds.pitchMax + 1e-6 &&
    state.distance >= rig.bounds.distMin - 1e-6 &&
    state.distance <= rig.bounds.distMax + 1e-6
  )
}

function clampYaw(rig: DeepReadonly<CameraRig>, yaw: number): number {
  if (yawIsFree(rig)) return wrapDegrees(yaw)
  const { yawMin, yawMax } = rig.bounds
  const y = wrapDegrees(yaw)
  if (yawWithinBounds(rig, y)) return y
  // Snap to whichever end of the range is nearer, measured around the circle.
  const distanceTo = (edge: number) => Math.abs(wrapDegrees(y - edge))
  return distanceTo(yawMin) <= distanceTo(yawMax) ? yawMin : yawMax
}

export function clampToBounds(
  rig: DeepReadonly<CameraRig>,
  state: Pick<RigState, 'yaw' | 'pitch' | 'distance'>,
): { yaw: number; pitch: number; distance: number } {
  let yaw = clampYaw(rig, state.yaw)
  if (rig.yawSnapDeg > 0) {
    yaw = clampYaw(rig, Math.round(yaw / rig.yawSnapDeg) * rig.yawSnapDeg)
  }
  return {
    yaw,
    pitch: Math.min(rig.bounds.pitchMax, Math.max(rig.bounds.pitchMin, state.pitch)),
    distance: Math.min(rig.bounds.distMax, Math.max(rig.bounds.distMin, state.distance)),
  }
}

const DEG = Math.PI / 180

/** Camera position for a rig state, orbiting the target. */
export function rigPosition(state: RigState, out = new THREE.Vector3()): THREE.Vector3 {
  const yaw = state.yaw * DEG
  const pitch = state.pitch * DEG
  const horizontal = Math.cos(pitch) * state.distance
  return out.set(
    state.target.x + Math.sin(yaw) * horizontal,
    state.target.y + Math.sin(pitch) * state.distance,
    state.target.z + Math.cos(yaw) * horizontal,
  )
}

export function applyRig(camera: THREE.Camera, state: RigState): void {
  rigPosition(state, camera.position)
  camera.lookAt(state.target)
}

/**
 * Build the camera a rig describes. Orthographic is offered because a fixed
 * perspective HD-2D look often wants it, and swapping is cheap here.
 */
export function createCamera(rig: DeepReadonly<CameraRig>, aspect: number): THREE.PerspectiveCamera | THREE.OrthographicCamera {
  if (rig.projection === 'orthographic') {
    const halfHeight = rig.distance * 0.5
    const halfWidth = halfHeight * aspect
    return new THREE.OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, 0.1, 500)
  }
  return new THREE.PerspectiveCamera(rig.fov, aspect, 0.1, 500)
}

export function updateCameraProjection(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  rig: DeepReadonly<CameraRig>,
  aspect: number,
  distance: number,
): void {
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    const ortho = camera as THREE.OrthographicCamera
    const halfHeight = distance * 0.5
    const halfWidth = halfHeight * aspect
    ortho.left = -halfWidth
    ortho.right = halfWidth
    ortho.top = halfHeight
    ortho.bottom = -halfHeight
  } else {
    const perspective = camera as THREE.PerspectiveCamera
    perspective.fov = rig.fov
    perspective.aspect = aspect
  }
  camera.updateProjectionMatrix()
}

/**
 * Yaw angles the game camera can actually reach. Used by the sweep preview and
 * by the coverage analysis, so both agree on what "the allowed envelope" is.
 */
export function sampleYawEnvelope(rig: DeepReadonly<CameraRig>, samples = 32): number[] {
  if (rig.yawSnapDeg > 0) {
    const out: number[] = []
    const steps = Math.round(360 / rig.yawSnapDeg)
    for (let i = 0; i < steps; i++) {
      const yaw = wrapDegrees(i * rig.yawSnapDeg)
      if (yawWithinBounds(rig, yaw)) out.push(yaw)
    }
    return out.length > 0 ? out : [rig.yaw]
  }

  if (yawIsFree(rig)) {
    return Array.from({ length: samples }, (_, i) => wrapDegrees((i / samples) * 360))
  }

  const { yawMin, yawMax } = rig.bounds
  const span = yawMin <= yawMax ? yawMax - yawMin : 360 - yawMin + yawMax
  return Array.from({ length: samples }, (_, i) => wrapDegrees(yawMin + (i / (samples - 1)) * span))
}

export function samplePitchEnvelope(rig: DeepReadonly<CameraRig>, samples = 5): number[] {
  const { pitchMin, pitchMax } = rig.bounds
  if (samples <= 1 || pitchMax - pitchMin < 1e-6) return [rig.pitch]
  return Array.from({ length: samples }, (_, i) => pitchMin + (i / (samples - 1)) * (pitchMax - pitchMin))
}
