/**
 * The layer view as a section cut, done on the GPU (ruling of 2026-09-13).
 *
 * The slider on the stage narrows the heights drawn to a range. Everything
 * above its ceiling is clipped away by a clipping plane on every solid
 * material; where the plane cut through something, a cap is drawn at the
 * ceiling in the cut colour; below the floor, surfaces darken, so what is
 * under the range reads as context.
 *
 * Nothing is remeshed for any of it. Moving the slider changes a plane's
 * constant and two uniforms, which is why dragging it costs nothing at any
 * height. It replaced clamping every column on the CPU and meshing every
 * chunk again per step, which allocated half a gigabyte a second while the
 * slider moved (`pnpm perf`, #131).
 *
 * The caps are their own geometry, because the terrain is only a top skin: a
 * ray that goes down through a cut never meets the surface again, so there
 * is no inside to show. A voxel volume's cap is one quad over its footprint,
 * lifted to the ceiling in the vertex shader, that keeps only the cells whose
 * column reaches past the ceiling — read from a one-byte-per-cell height
 * texture updated when the volume is. A sketch's cap is its own cap geometry,
 * lifted to the ceiling the same way, drawn while the ceiling passes through
 * the sketch. The true section of a flared wall is a little wider than the cap
 * outline; the difference shows the ground the sketch stands on.
 */

import * as THREE from 'three'

import { HALF } from '@papercut/document'

import { CUT_TINT, GHOST_TINT, type LayerRange } from './layers'

/** Far enough that nothing is ever clipped or darkened while no range is set. */
const FAR = 1e6
/** How far above the ceiling the clip plane sits, in world units: well under anything the grid can express. */
const CLIP_SLACK = 0.002

const CAP_VERTEX = /* glsl */ `
uniform float sectionCeiling;
uniform float sectionBase;
varying vec2 vSectionCell;
void main() {
  vSectionCell = position.xz;
  // Lifted to the ceiling, measured from the structure's own base: the mesh sits in the structure's group.
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.x, sectionCeiling - sectionBase, position.z, 1.0);
}
`

const CAP_COLOUR = /* glsl */ `
  gl_FragColor = vec4(sectionCap, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`

const VOXEL_CAP_FRAGMENT = /* glsl */ `
uniform sampler2D sectionHeights;
uniform float sectionCeiling;
uniform float sectionBase;
uniform vec3 sectionCap;
varying vec2 vSectionCell;
void main() {
  ivec2 size = textureSize(sectionHeights, 0);
  ivec2 cell = clamp(ivec2(floor(vSectionCell)), ivec2(0), size - 1);
  // Heights are half-tiles, one byte a cell; a ramp's cell counts at its high side.
  float top = sectionBase + texelFetch(sectionHeights, cell, 0).r * 255.0 * ${HALF.toFixed(2)};
  if (top <= sectionCeiling) discard;
  ${CAP_COLOUR}
}
`

const SKETCH_CAP_FRAGMENT = /* glsl */ `
uniform float sectionCeiling;
uniform float sectionBase;
uniform float sectionTop;
uniform vec3 sectionCap;
varying vec2 vSectionCell;
void main() {
  if (sectionCeiling <= sectionBase || sectionCeiling >= sectionBase + sectionTop) discard;
  ${CAP_COLOUR}
}
`

export class SectionCut {
  /**
   * Keeps what is at or below the ceiling. Three keeps the side of a clipping
   * plane its normal points to, and a downward normal with the ceiling as the
   * constant is exactly `y <= ceiling`.
   */
  readonly plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), FAR)
  private readonly ceilingUniform = { value: FAR }
  private readonly floor = { value: -FAR }
  private readonly cap = { value: new THREE.Color(CUT_TINT) }
  private readonly ghost = { value: new THREE.Color(GHOST_TINT) }
  private readonly caps = new Set<THREE.Mesh>()
  private range: LayerRange | null = null

  /** The world height things are cut at, or `null` while the whole level is drawn. */
  get ceiling(): number | null {
    return this.range === null ? null : this.range.hi * HALF
  }

  get active(): boolean {
    return this.range !== null
  }

  /** Narrow the view to `range`, or `null` for the whole level: a plane, two uniforms, and whether the caps draw. */
  set(range: LayerRange | null): void {
    this.range = range
    const ceiling = range === null ? FAR : range.hi * HALF
    // A hair above the ceiling: a top that sits exactly at it is kept, not clipped by float error into streaks.
    this.plane.constant = ceiling + CLIP_SLACK
    this.ceilingUniform.value = ceiling
    this.floor.value = range === null ? -FAR : range.lo * HALF
    for (const cap of this.caps) cap.visible = range !== null
  }

  /** Cut a solid surface: clipped at the ceiling, darkened below the floor. */
  solid(material: THREE.MeshStandardMaterial): void {
    this.clip(material)
    material.onBeforeCompile = (shader) => {
      shader.uniforms.sectionFloor = this.floor
      shader.uniforms.sectionGhost = this.ghost
      shader.vertexShader = `varying float vSectionY;\n${shader.vertexShader.replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n\tvSectionY = (modelMatrix * vec4(transformed, 1.0)).y;',
      )}`
      shader.fragmentShader = `uniform float sectionFloor;\nuniform vec3 sectionGhost;\nvarying float vSectionY;\n${shader.fragmentShader.replace(
        '#include <tonemapping_fragment>',
        // Before tone mapping, so the ghost goes through the same colour pipeline as everything lit.
        'if (vSectionY < sectionFloor) gl_FragColor.rgb *= sectionGhost;\n\t#include <tonemapping_fragment>',
      )}`
    }
    // The injected program differs from a plain standard material's; without its own key three would share one.
    material.customProgramCacheKey = () => 'papercut-section-solid'
  }

  /** Clip without a cap: water, and the editor's overlays, which have no inside to show. */
  clip(material: THREE.Material): void {
    material.clippingPlanes = [this.plane]
    material.clipShadows = true
  }

  /** The cap over a voxel volume of this footprint. Add its mesh to the volume's group and `update` it with the volume. */
  voxelCap(width: number, height: number): VoxelCap {
    const cap = new VoxelCap(width, height, { sectionCeiling: this.ceilingUniform, sectionCap: this.cap })
    this.track(cap.mesh)
    return cap
  }

  /** The cap over a sketch, drawn from its cap geometry (which it does not own). Add its mesh to the sketch's group. */
  sketchCap(geometry: THREE.BufferGeometry, base: number, top: number): SketchCap {
    const cap = new SketchCap(geometry, base, top, { sectionCeiling: this.ceilingUniform, sectionCap: this.cap })
    this.track(cap.mesh)
    return cap
  }

  /** Stop drawing a cap that is being disposed. */
  forget(mesh: THREE.Mesh): void {
    this.caps.delete(mesh)
  }

  private track(mesh: THREE.Mesh): void {
    mesh.visible = this.range !== null
    // Drawn where the vertex shader lifts it, not where its vertices are: the bounds would cull it wrongly.
    mesh.frustumCulled = false
    mesh.userData.surface = 'section'
    this.caps.add(mesh)
  }
}

interface SharedUniforms {
  readonly sectionCeiling: { value: number }
  readonly sectionCap: { value: THREE.Color }
}

/** A voxel volume's cap: its footprint as one quad, and its column heights as one byte a cell. */
export class VoxelCap {
  readonly mesh: THREE.Mesh
  private readonly heights: Uint8Array
  private readonly texture: THREE.DataTexture
  private readonly material: THREE.ShaderMaterial
  private readonly base = { value: 0 }

  constructor(
    readonly width: number,
    readonly height: number,
    shared: SharedUniforms,
  ) {
    this.heights = new Uint8Array(width * height)
    this.texture = new THREE.DataTexture(this.heights, width, height, THREE.RedFormat, THREE.UnsignedByteType)
    this.texture.magFilter = THREE.NearestFilter
    this.texture.minFilter = THREE.NearestFilter
    this.texture.generateMipmaps = false
    this.texture.unpackAlignment = 1
    this.texture.needsUpdate = true
    const geometry = new THREE.PlaneGeometry(width, height)
    // Flat, and over the volume's cells: local x across its width, local z down its height.
    geometry.rotateX(-Math.PI / 2)
    geometry.translate(width / 2, 0, height / 2)
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...shared, sectionBase: this.base, sectionHeights: { value: this.texture } },
      vertexShader: CAP_VERTEX,
      fragmentShader: VOXEL_CAP_FRAGMENT,
    })
    this.mesh = new THREE.Mesh(geometry, this.material)
  }

  /** The volume's column heights (half-tiles, row by row) and the world height of its base. */
  update(heights: ArrayLike<number>, base: number): void {
    for (let i = 0; i < this.heights.length; i++) this.heights[i] = Math.max(0, Math.min(255, heights[i] ?? 0))
    this.texture.needsUpdate = true
    this.base.value = base
  }

  setBase(base: number): void {
    this.base.value = base
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.texture.dispose()
  }
}

/** A sketch's cap: its cap geometry lifted to the ceiling while the ceiling passes through it. */
export class SketchCap {
  readonly mesh: THREE.Mesh
  private readonly material: THREE.ShaderMaterial
  private readonly base: { value: number }

  constructor(geometry: THREE.BufferGeometry, base: number, top: number, shared: SharedUniforms) {
    this.base = { value: base }
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...shared, sectionBase: this.base, sectionTop: { value: top } },
      vertexShader: CAP_VERTEX,
      fragmentShader: SKETCH_CAP_FRAGMENT,
    })
    this.mesh = new THREE.Mesh(geometry, this.material)
  }

  setBase(base: number): void {
    this.base.value = base
  }

  /** The geometry is the sketch's own cap part, disposed with it. */
  dispose(): void {
    this.material.dispose()
  }
}
