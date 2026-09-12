// PROTOTYPE — throwaway. A bare three.js scene for the sketch lab: a sketch
// plane with a grid, an orbit camera, handles for profile points, and the
// five parts of a meshed sketch each with its own texture.
import * as THREE from 'three'
import type { MeshBuffers, SketchMesh } from '@map-editor/geometry'

import { texture } from './textures'

export interface Pick2 {
  x: number
  z: number
}

function geometryOf(buffers: MeshBuffers): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(buffers.normals, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(buffers.uvs, 2))
  g.setIndex(new THREE.BufferAttribute(buffers.indices, 1))
  return g
}

export class LabScene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  private readonly raycaster = new THREE.Raycaster()
  private readonly parts = new THREE.Group()
  private readonly handles = new THREE.Group()
  private readonly preview: THREE.Line
  private readonly handleGeometry = new THREE.SphereGeometry(0.16, 12, 8)
  private readonly handleMaterials = {
    corner: new THREE.MeshBasicMaterial({ color: 0xe9a23b }),
    smooth: new THREE.MeshBasicMaterial({ color: 0x7fd4ff }),
    selected: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  }
  private readonly materials: Record<keyof Omit<SketchMesh, 'outline'>, THREE.MeshLambertMaterial>
  orbit = { yaw: 35, pitch: 34, distance: 40, target: new THREE.Vector3(11, 1, 9) }
  private frame = 0

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.scene.background = new THREE.Color(0x9fc3e6)
    this.scene.fog = new THREE.Fog(0x9fc3e6, 40, 110)
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 500)

    const hemi = new THREE.HemisphereLight(0xdfeeff, 0x6b7a5a, 0.9)
    const sun = new THREE.DirectionalLight(0xfff3d6, 1.6)
    sun.position.set(12, 20, 6)
    this.scene.add(hemi, sun)

    // The sketch plane: a ground the island stands on, with the grid the points snap to.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshLambertMaterial({ color: 0x7fa85c }))
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.01
    const grid = new THREE.GridHelper(64, 64, 0x2c3140, 0x5c7a4a)
    grid.position.set(16, 0.002, 16)
    ;(grid.material as THREE.Material).transparent = true
    ;(grid.material as THREE.Material).opacity = 0.45
    this.scene.add(ground, grid, this.parts, this.handles)

    this.preview = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xe9a23b }))
    this.preview.position.y = 0.01
    this.scene.add(this.preview)

    const band = (map: THREE.Texture) => new THREE.MeshLambertMaterial({ map, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    this.materials = {
      cap: new THREE.MeshLambertMaterial({ map: texture('fill') }),
      rim: band(texture('rim')),
      wallBody: new THREE.MeshLambertMaterial({ map: texture('body') }),
      wallTop: band(texture('top')),
      wallBottom: band(texture('bottom')),
    }

    const loop = () => {
      this.frame = requestAnimationFrame(loop)
      this.render()
    }
    loop()
  }

  dispose(): void {
    cancelAnimationFrame(this.frame)
    this.renderer.dispose()
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect()
    const w = Math.max(1, Math.floor(rect.width))
    const h = Math.max(1, Math.floor(rect.height))
    if (this.canvas.width !== w * this.renderer.getPixelRatio() || this.canvas.height !== h * this.renderer.getPixelRatio()) {
      this.renderer.setSize(w, h, false)
      this.camera.aspect = w / h
      this.camera.updateProjectionMatrix()
    }
  }

  private render(): void {
    this.resize()
    const { yaw, pitch, distance, target } = this.orbit
    const y = (yaw * Math.PI) / 180
    const p = (pitch * Math.PI) / 180
    this.camera.position.set(
      target.x + Math.sin(y) * Math.cos(p) * distance,
      target.y + Math.sin(p) * distance,
      target.z + Math.cos(y) * Math.cos(p) * distance,
    )
    this.camera.lookAt(target)
    this.renderer.render(this.scene, this.camera)
  }

  private ndc(clientX: number, clientY: number): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect()
    return new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
  }

  /** Where the pointer's ray meets the horizontal plane at height `y` — the active sketch's plane. */
  pickPlane(clientX: number, clientY: number, y = 0): Pick2 | null {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera)
    const out = new THREE.Vector3()
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), out) ? { x: out.x, z: out.z } : null
  }

  pickHandle(clientX: number, clientY: number): number | null {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera)
    const hit = this.raycaster.intersectObjects(this.handles.children, false)[0]
    return hit ? (hit.object.userData.index as number) : null
  }

  setHandles(points: readonly { x: number; z: number; smooth: boolean }[], selected: number | null, y: number): void {
    while (this.handles.children.length > points.length) this.handles.remove(this.handles.children[this.handles.children.length - 1])
    points.forEach((pt, i) => {
      let mesh = this.handles.children[i] as THREE.Mesh | undefined
      if (!mesh) {
        mesh = new THREE.Mesh(this.handleGeometry, this.handleMaterials.corner)
        this.handles.add(mesh)
      }
      mesh.userData.index = i
      mesh.material = i === selected ? this.handleMaterials.selected : pt.smooth ? this.handleMaterials.smooth : this.handleMaterials.corner
      mesh.position.set(pt.x, y + 0.02, pt.z)
    })
  }

  setPreview(points: readonly { x: number; z: number }[], closed: boolean, y: number): void {
    const list = closed && points.length > 1 ? [...points, points[0]] : points
    const arr = new Float32Array(list.length * 3)
    list.forEach((p, i) => {
      arr[i * 3] = p.x
      arr[i * 3 + 1] = y
      arr[i * 3 + 2] = p.z
    })
    this.preview.geometry.dispose()
    this.preview.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(arr, 3))
    this.preview.visible = list.length > 1
  }

  /** Every sketch's parts, each group lifted to the sketch's base height (its parent's cap). */
  setMeshes(list: readonly { mesh: SketchMesh; base: number }[]): void {
    for (const group of [...this.parts.children]) {
      this.parts.remove(group)
      for (const child of group.children) (child as THREE.Mesh).geometry.dispose()
    }
    for (const { mesh, base } of list) {
      const group = new THREE.Group()
      group.position.y = base
      for (const key of ['cap', 'rim', 'wallBody', 'wallTop', 'wallBottom'] as const) {
        const buffers = mesh[key]
        if (buffers.triangleCount === 0) continue
        const m = new THREE.Mesh(geometryOf(buffers), this.materials[key])
        m.renderOrder = key === 'cap' || key === 'wallBody' ? 0 : 1
        group.add(m)
      }
      this.parts.add(group)
    }
  }
}
