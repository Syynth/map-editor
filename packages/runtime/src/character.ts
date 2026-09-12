/**
 * Play mode's character.
 *
 * Deliberately thin. Its job is to exercise the runtime's billboard behaviour
 * from a game's point of view — the brief's play mode exists to check that a
 * character walking the map uses the same facing and flip code the editor
 * previews, not to be a character controller worth keeping.
 *
 * Note it faces by *movement direction relative to the camera*, not by camera
 * yaw. That is the same mechanism four-direction NPC sheets need, which is why
 * `ObjectView` takes a facing override rather than always reading the camera.
 */

import * as THREE from 'three'

import {
  rootVoxel,
  defaultFacing,
  groundHeight,
  inBounds,
  type DeepReadonly,
  type ReadonlyMapDoc,
  type MapObject,
  type SpriteAsset,
} from '@map-editor/document'
import { ObjectView, type ObjectViewContext } from './billboard'

const SPEED = 6
/** Steepest slope the character can walk up, in world units per world unit. */
const MAX_STEP = 0.85

export interface CharacterInput {
  forward: number
  strafe: number
}

export class Character {
  readonly view: ObjectView
  position = new THREE.Vector3()
  /** Degrees; the direction the character is moving, in world space. */
  heading = 0

  private object: DeepReadonly<MapObject>

  constructor(asset: SpriteAsset, context: ObjectViewContext, start: THREE.Vector3) {
    this.object = {
      id: 'play_character',
      name: 'Character',
      sprite: 'hero',
      position: [start.x, start.y, start.z],
      rotationY: 0,
      scale: 1,
      display: 'fixed',
      facing: { ...defaultFacing(), facings: 4, mirror: true, transition: 'flip', durationMs: 180 },
      anchorCell: null,
      seed: 0,
      locked: true,
      hidden: false,
    }
    this.position.copy(start)
    this.view = new ObjectView(this.object, asset, context)
  }

  /**
   * @param cameraYaw  degrees; input is interpreted relative to the camera, as
   *                   in most third-person games
   */
  update(doc: ReadonlyMapDoc, input: CharacterInput, cameraYaw: number, dt: number, context: ObjectViewContext): void {
    const yaw = cameraYaw * (Math.PI / 180)
    // Screen-relative movement: forward walks away from the camera.
    const forwardX = -Math.sin(yaw)
    const forwardZ = -Math.cos(yaw)
    const rightX = Math.cos(yaw)
    const rightZ = -Math.sin(yaw)

    let dx = forwardX * input.forward + rightX * input.strafe
    let dz = forwardZ * input.forward + rightZ * input.strafe
    const length = Math.hypot(dx, dz)

    if (length > 1e-4) {
      dx /= length
      dz /= length
      const step = SPEED * dt
      const nextX = this.position.x + dx * step
      const nextZ = this.position.z + dz * step

      // Refuse a step that would mean climbing a cliff, using the same ground
      // query the mesher builds geometry from, so the two cannot disagree.
      const currentY = groundHeight(doc, this.position.x, this.position.z)
      if (inBounds(rootVoxel(doc).size, Math.floor(nextX), Math.floor(nextZ))) {
        const nextY = groundHeight(doc, nextX, nextZ)
        if (nextY - currentY <= MAX_STEP) {
          this.position.set(nextX, nextY, nextZ)
        } else {
          // Slide along whichever axis is still walkable.
          const slideX = groundHeight(doc, nextX, this.position.z)
          if (slideX - currentY <= MAX_STEP) this.position.set(nextX, slideX, this.position.z)
          else {
            const slideZ = groundHeight(doc, this.position.x, nextZ)
            if (slideZ - currentY <= MAX_STEP) this.position.set(this.position.x, slideZ, nextZ)
          }
        }
      }

      this.heading = (Math.atan2(dx, dz) * 180) / Math.PI
    } else {
      this.position.y = groundHeight(doc, this.position.x, this.position.z)
    }

    this.view.setPosition([this.position.x, this.position.y, this.position.z])

    // The facing override: the character shows the side of itself that the
    // camera would see given where it is walking.
    this.view.update(cameraYaw, dt, { ...context, facingOverride: cameraYaw - this.heading + 180 })
  }

  dispose(): void {
    this.view.dispose()
  }
}
