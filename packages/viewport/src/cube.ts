/**
 * The view cube: a chamfered cube in the viewport's corner that turns with the
 * camera, so the artist can see which way they are looking and click their
 * way to a view.
 *
 * Every face, chamfered edge and corner is a piece with a direction, and a
 * press on one aligns the camera to that direction (ruling of 2026-09-13,
 * "The view cube sets the editor's view"). Pieces on the underside have no
 * view: the terrain is a top skin, and nothing is under it to look at.
 *
 * The cube is its own tiny scene with its own orthographic camera, drawn
 * into a scissored corner of the main canvas after the level — one GL
 * context, no second canvas — and picked with a raycast against that scene.
 */

import * as THREE from 'three'

import { applyRig, wrapDegrees } from '@papercut/runtime'

export type Axis = -1 | 0 | 1

export interface CubeView {
  readonly yaw: number
  readonly pitch: number
}

export interface CubePiece {
  /** `+x`, `-y+z`, `+x+y-z`: the signs of its axes, in x y z order. */
  readonly id: string
  readonly kind: 'face' | 'edge' | 'corner'
  readonly axes: readonly [Axis, Axis, Axis]
  /** The camera pose that looks at this piece head-on, or `null` for a piece on the underside. */
  readonly view: CubeView | null
}

/** Straight down is the top view: at 90° the camera's up vector is undefined, and the orbit stops here anyway. */
export const TOP_PITCH = 89

/** The pose looking along `axes` at the origin: the same yaw and pitch `rigPosition` places a camera by. */
export function viewOf(axes: readonly [Axis, Axis, Axis]): CubeView | null {
  const [x, y, z] = axes
  if (y < 0) return null
  const length = Math.hypot(x, y, z)
  const pitch = (Math.asin(y / length) * 180) / Math.PI
  return {
    yaw: x === 0 && z === 0 ? 0 : wrapDegrees((Math.atan2(x, z) * 180) / Math.PI),
    pitch: Math.min(TOP_PITCH, pitch),
  }
}

const SIGNS: readonly Axis[] = [-1, 0, 1]

function idOf(axes: readonly [Axis, Axis, Axis]): string {
  return (['x', 'y', 'z'] as const).map((name, i) => (axes[i] === 0 ? '' : `${axes[i] > 0 ? '+' : '-'}${name}`)).join('')
}

/** Every piece of the cube: 6 faces, 12 edges, 8 corners. */
export function cubePieces(): CubePiece[] {
  const pieces: CubePiece[] = []
  for (const x of SIGNS)
    for (const y of SIGNS)
      for (const z of SIGNS) {
        const count = Math.abs(x) + Math.abs(y) + Math.abs(z)
        if (count === 0) continue
        const axes: [Axis, Axis, Axis] = [x, y, z]
        pieces.push({ id: idOf(axes), kind: count === 1 ? 'face' : count === 2 ? 'edge' : 'corner', axes, view: viewOf(axes) })
      }
  return pieces
}

/**
 * The geometry of one piece of a unit cube whose edges are cut back by
 * `chamfer`: a face is the quad left inside the cuts, an edge the strip
 * between two faces, a corner the triangle between three. The pieces tile the
 * surface exactly, so the cube is closed.
 */
export function pieceGeometry(piece: CubePiece, chamfer: number): THREE.BufferGeometry {
  const inner = 1 - chamfer
  const [x, y, z] = piece.axes
  let ring: THREE.Vector3[]
  if (piece.kind === 'face') {
    const [i, sign] = x !== 0 ? [0, x] : y !== 0 ? [1, y] : [2, z]
    const [j, k] = i === 0 ? [1, 2] : i === 1 ? [0, 2] : [0, 1]
    ring = [
      [-inner, -inner],
      [inner, -inner],
      [inner, inner],
      [-inner, inner],
    ].map(([a, b]) => {
      const v = new THREE.Vector3()
      v.setComponent(i, sign)
      v.setComponent(j, a)
      v.setComponent(k, b)
      return v
    })
  } else if (piece.kind === 'edge') {
    const [i, j, k] = x === 0 ? [1, 2, 0] : y === 0 ? [0, 2, 1] : [0, 1, 2]
    const si = piece.axes[i]
    const sj = piece.axes[j]
    const at = (ci: number, cj: number, ck: number) => {
      const v = new THREE.Vector3()
      v.setComponent(i, ci)
      v.setComponent(j, cj)
      v.setComponent(k, ck)
      return v
    }
    ring = [at(si, sj * inner, -inner), at(si, sj * inner, inner), at(si * inner, sj, inner), at(si * inner, sj, -inner)]
  } else {
    ring = [new THREE.Vector3(x, y * inner, z * inner), new THREE.Vector3(x * inner, y, z * inner), new THREE.Vector3(x * inner, y * inner, z)]
  }
  // Wound to face outward: flip the ring if its normal points into the cube.
  const normal = new THREE.Vector3().subVectors(ring[1], ring[0]).cross(new THREE.Vector3().subVectors(ring[2], ring[0]))
  if (normal.dot(new THREE.Vector3(x, y, z)) < 0) ring.reverse()
  const positions: number[] = []
  const uvs: number[] = []
  const [u, v] = faceAxes(piece)
  for (let t = 1; t + 1 < ring.length; t += 1) {
    for (const p of [ring[0], ring[t], ring[t + 1]]) {
      positions.push(p.x, p.y, p.z)
      uvs.push((p.dot(u) + 1) / 2, (p.dot(v) + 1) / 2)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.computeVertexNormals()
  return geometry
}

/**
 * The directions a face's label reads along, seen from outside with the
 * camera upright: `u` is the label's left-to-right, `v` its bottom-to-top.
 * Only faces carry labels; the rest get axes that keep their UVs finite.
 */
function faceAxes(piece: CubePiece): [THREE.Vector3, THREE.Vector3] {
  const [x, y, z] = piece.axes
  if (piece.kind !== 'face') return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)]
  if (y > 0) return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1)]
  if (y < 0) return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)]
  // A side, seen from its own direction: right is the direction's rotation by a quarter turn.
  return [new THREE.Vector3(z, 0, -x), new THREE.Vector3(0, 1, 0)]
}

/** What a face is called, from the game's front: the camera's default yaw of zero sits on +z. */
export const FACE_LABELS: Readonly<Record<string, string>> = { '+y': 'TOP', '+z': 'FRONT', '-z': 'BACK', '+x': 'RIGHT', '-x': 'LEFT' }

const CHAMFER = 0.22
/** The cube's own camera sits this far out; the frustum below is sized so the cube fills its corner with a margin. */
const CAMERA_DISTANCE = 6
const HALF_EXTENT = 1.55

export interface CubeColours {
  face: number
  chamfer: number
  inert: number
  highlight: number
  label: string
}

const DEFAULT_COLOURS: CubeColours = { face: 0xd9dde4, chamfer: 0xb8bec9, inert: 0x6f7480, highlight: 0x7fd4ff, label: '#3a3f4a' }

export class ViewCube {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.OrthographicCamera(-HALF_EXTENT, HALF_EXTENT, HALF_EXTENT, -HALF_EXTENT, 0.1, 20)
  readonly pieces: readonly CubePiece[]
  private meshes = new Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>>()
  private raycaster = new THREE.Raycaster()
  private highlighted: string | null = null
  private rig = { yaw: 0, pitch: 0, distance: CAMERA_DISTANCE, target: new THREE.Vector3() }
  private labels: THREE.CanvasTexture[] = []
  private outline: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>

  constructor(private colours: CubeColours = DEFAULT_COLOURS) {
    this.pieces = cubePieces()
    for (const piece of this.pieces) {
      const material = new THREE.MeshBasicMaterial({ color: this.baseColour(piece), toneMapped: false })
      const label = piece.kind === 'face' && piece.view ? FACE_LABELS[piece.id] : undefined
      if (label !== undefined) {
        const texture = this.labelTexture(label)
        if (texture) {
          material.map = texture
          this.labels.push(texture)
        }
      }
      const mesh = new THREE.Mesh(pieceGeometry(piece, CHAMFER), material)
      mesh.userData.piece = piece.id
      this.meshes.set(piece.id, mesh)
      this.scene.add(mesh)
    }
    // Chamfers are drawn as lines too, so the silhouette reads at a glance.
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(mergedGeometry(this.pieces.map((piece) => pieceGeometry(piece, CHAMFER))), 15),
      new THREE.LineBasicMaterial({ color: 0x4a505c, toneMapped: false }),
    )
    this.scene.add(this.outline)
    this.orient(0, 0)
  }

  /** Turn the cube to match the level camera's yaw and pitch. */
  orient(yaw: number, pitch: number): void {
    this.rig.yaw = yaw
    this.rig.pitch = pitch
    applyRig(this.camera, this.rig)
    this.camera.updateMatrixWorld()
  }

  /**
   * The piece under a point given in the cube's own viewport, as fractions
   * of its width and height from the top-left. Null between pieces or off
   * the cube.
   */
  pieceAt(fx: number, fy: number): CubePiece | null {
    this.raycaster.setFromCamera(new THREE.Vector2(fx * 2 - 1, 1 - fy * 2), this.camera)
    const hits = this.raycaster.intersectObjects([...this.meshes.values()], false)
    const id = hits[0]?.object.userData.piece as string | undefined
    return id === undefined ? null : (this.pieces.find((piece) => piece.id === id) ?? null)
  }

  /** Light up one piece, or none. */
  highlight(id: string | null): void {
    if (id === this.highlighted) return
    if (this.highlighted) this.paint(this.highlighted, false)
    if (id) this.paint(id, true)
    this.highlighted = id
  }

  /** Whether `view` is the pose the camera is already in, near enough that a second click means something else. */
  static atView(current: CubeView, view: CubeView, tolerance = 0.5): boolean {
    return Math.abs(wrapDegrees(current.yaw - view.yaw)) <= tolerance && Math.abs(current.pitch - view.pitch) <= tolerance
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
    for (const texture of this.labels) texture.dispose()
    this.outline.geometry.dispose()
    this.outline.material.dispose()
  }

  private baseColour(piece: CubePiece): number {
    if (!piece.view) return this.colours.inert
    return piece.kind === 'face' ? this.colours.face : this.colours.chamfer
  }

  private paint(id: string, lit: boolean): void {
    const mesh = this.meshes.get(id)
    const piece = this.pieces.find((candidate) => candidate.id === id)
    if (!mesh || !piece) return
    mesh.material.color.set(lit && piece.view ? this.colours.highlight : this.baseColour(piece))
  }

  /** A face's word, drawn once into a small canvas; null where there is no canvas to draw on (tests). */
  private labelTexture(text: string): THREE.CanvasTexture | null {
    if (typeof document === 'undefined') return null
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 128
    const context = canvas.getContext('2d')
    if (!context) return null
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, 128, 128)
    context.fillStyle = this.colours.label
    context.font = 'bold 30px system-ui, sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(text, 64, 66)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  }
}

function mergedGeometry(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = []
  for (const part of parts) {
    positions.push(...(part.getAttribute('position').array as Float32Array))
    part.dispose()
  }
  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  return merged
}
