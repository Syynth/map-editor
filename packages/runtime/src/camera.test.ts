import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { applyRig, panToHold, type RigState } from './camera'
import { Picker } from './picking'

/** A camera placed by the rig, with its matrices current so a raycast sees it where it is. */
function place(camera: THREE.Camera, rig: RigState): void {
  applyRig(camera, rig)
  camera.updateMatrixWorld()
}

/** Where the cursor at `ndc` meets the plane at height `y`, cast from the camera as placed. */
function under(picker: Picker, camera: THREE.Camera, ndc: [number, number], y: number): THREE.Vector3 {
  const hit = picker.pickPlane(camera, ndc[0], ndc[1], y)
  if (!hit) throw new Error('the ray missed the plane')
  return hit
}

describe('a pan that holds the grabbed point', () => {
  const cameras = {
    perspective: () => new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 500),
    orthographic: () => new THREE.OrthographicCamera(-13 * (16 / 9), 13 * (16 / 9), 13, -13, 0.1, 500),
  }

  for (const [name, make] of Object.entries(cameras)) {
    it(`keeps the pressed point under the cursor after each move, ${name}`, () => {
      const picker = new Picker()
      const camera = make()
      const rig: RigState = { yaw: 45, pitch: 35, distance: 26, target: new THREE.Vector3(8, 1.5, 8) }
      place(camera, rig)

      // Pressed off-centre on a raised surface, then dragged along a wandering path.
      const pressed: [number, number] = [0.3, -0.4]
      const grab = under(picker, camera, pressed, 2.5)
      const path: Array<[number, number]> = [
        [0.2, -0.3],
        [-0.1, 0.1],
        [-0.6, 0.5],
        [0.4, 0.6],
        [0.3, -0.4],
      ]
      for (const cursor of path) {
        panToHold(rig, grab, under(picker, camera, cursor, grab.y))
        place(camera, rig)
        // The invariant: cast the cursor's ray again and it lands on the grabbed point.
        const held = under(picker, camera, cursor, grab.y)
        expect(held.distanceTo(grab)).toBeLessThan(1e-6)
      }
      // Back where the press was, the rig is back where it started.
      expect(rig.target.distanceTo(new THREE.Vector3(8, 1.5, 8))).toBeLessThan(1e-6)
    })
  }

  it('slides the target only along the plane, never up or down', () => {
    const rig: RigState = { yaw: 0, pitch: 45, distance: 10, target: new THREE.Vector3(0, 3, 0) }
    panToHold(rig, new THREE.Vector3(1, 7, 2), new THREE.Vector3(4, 7, -1))
    expect(rig.target.toArray()).toEqual([-3, 3, 3])
  })
})
