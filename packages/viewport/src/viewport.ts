/**
 * The 3D viewport.
 *
 * Managed imperatively rather than through react-three-fiber, because bulk
 * terrain geometry changes on every brush tick and React has no business in
 * that loop. React owns the panels; this owns the canvas.
 *
 * Everything visible here is rendered by the runtime package. The only things
 * this adds are editor overlays — grid, hover highlight, brush preview — which
 * are exactly the things that must NOT ship in the game.
 */

import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

import {
  SURFACE_CLIFF,
  SURFACE_TOP,
  cellIndex,
  cornerHeights,
  groundHeight,
  inBounds,
  type EditorStore,
  type ReadonlyMapDoc,
  type SurfaceAddress,
} from '@map-editor/document'
import {
  Character,
  Picker,
  RuntimeScene,
  applyRig,
  clampToBounds,
  createCamera,
  sampleYawEnvelope,
  updateCameraProjection,
  withinBounds,
  wrapDegrees,
  type ObjectViewContext,
  type PickResult,
  type SceneAssets,
} from '@map-editor/runtime'
import type { RgbaImage, SpriteAsset } from '@map-editor/document'

/** Tilt-shift: a cheap vertical-gradient blur, the HD-2D miniature look. */
const TiltShiftShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    amount: { value: 0.3 },
    focus: { value: 0.55 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float amount;
    uniform float focus;
    varying vec2 vUv;
    void main() {
      float d = abs(vUv.y - focus);
      float blur = smoothstep(0.10, 0.5, d) * amount;
      if (blur < 0.001) { gl_FragColor = texture2D(tDiffuse, vUv); return; }
      vec4 sum = vec4(0.0);
      float total = 0.0;
      for (int i = -4; i <= 4; i++) {
        float w = 1.0 - abs(float(i)) / 5.0;
        vec2 offset = vec2(float(i) * blur * 0.005, float(i) * blur * 0.005);
        sum += texture2D(tDiffuse, vUv + offset) * w;
        total += w;
      }
      gl_FragColor = sum / total;
    }
  `,
}

export interface PointerModifiers {
  shift: boolean
  alt: boolean
  ctrl: boolean
  button: number
}

export interface ViewportHandlers {
  onStrokeStart(pick: PickResult, modifiers: PointerModifiers): void
  onStrokeMove(pick: PickResult, modifiers: PointerModifiers): void
  onStrokeEnd(): void
  onHover(pick: PickResult): void
  onCameraChange(state: { yaw: number; pitch: number; distance: number; inBounds: boolean }): void
  onStats(stats: { fps: number; triangles: number; meshMs: number }): void
}

export interface ViewportOptions {
  /** Cells the brush would affect, previewed under the cursor. */
  brushPreview: Array<[number, number]>
  showGrid: boolean
  /** Clamp the editor camera to what the game rig allows. */
  gameCamera: boolean
  playing: boolean
  /** Hovered surface, highlighted. */
  hover: SurfaceAddress | null
  selectedObjectId: string | null
}

/** How far an alt+left press must travel before it counts as an orbit drag
 *  rather than an eyedropper click. Small enough that a deliberate drag is
 *  never swallowed, large enough to absorb trackpad jitter during a tap. */
const ORBIT_DRAG_THRESHOLD = 4

const DEFAULT_OPTIONS: ViewportOptions = {
  brushPreview: [],
  showGrid: true,
  gameCamera: false,
  playing: false,
  hover: null,
  selectedObjectId: null,
}

/**
 * Software rasterizers (SwiftShader in headless Chromium, llvmpipe on a
 * machine with no GPU driver) render the bloom pass as a black frame: the
 * scene itself draws correctly, and putting UnrealBloomPass in front of it
 * turns the whole image black. Measured, not guessed — see FINDINGS.md.
 *
 * Rather than lose the whole viewport on such a machine, detect it and drop
 * post-processing. The editor says so in the status bar so nobody concludes
 * the atmosphere sliders are broken.
 */
function isSoftwareRenderer(renderer: THREE.WebGLRenderer): boolean {
  try {
    const gl = renderer.getContext()
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    const name = info
      ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER))
    return /swiftshader|llvmpipe|software|mesa offscreen/i.test(name)
  } catch {
    return false
  }
}

// window.__viewport (wired in apps/editor) exposes this class's *ForProbe
// methods to an unlinted, untypechecked consumer — see the "scripting hooks"
// section below for which scripts and why a rename needs a grep first.
export class Viewport {
  /** True when post-processing had to be switched off. */
  readonly softwareRenderer: boolean
  private renderer: THREE.WebGLRenderer
  private composer: EffectComposer
  private bloom: UnrealBloomPass
  private tiltShift: ShaderPass
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
  private scene: RuntimeScene
  private picker = new Picker()
  private store: EditorStore

  private orbit = { yaw: 45, pitch: 35, distance: 26, target: new THREE.Vector3() }
  private options: ViewportOptions = { ...DEFAULT_OPTIONS }
  private handlers: ViewportHandlers

  private overlay = new THREE.Group()
  private gridLines: THREE.LineSegments | null = null
  private brushMesh: THREE.Mesh
  private hoverMesh: THREE.Mesh
  private selectionBox: THREE.Box3Helper

  private character: Character | null = null
  private keys = new Set<string>()

  private dragging: 'none' | 'stroke' | 'orbit' | 'pan' | 'pending' = 'none'
  /** An alt+left press that has not yet moved far enough to count as an orbit.
   *  Held here so a click can still reach the eyedropper on release. */
  private pending: { x: number; y: number; event: PointerEvent } | null = null
  private lastPointer = { x: 0, y: 0 }
  private frameHandle = 0
  private lastTime = performance.now()
  private fpsAccumulator = 0
  private fpsFrames = 0
  private sweep: { active: boolean; t: number; yaws: number[] } = { active: false, t: 0, yaws: [] }
  private disposed = false

  constructor(
    private canvas: HTMLCanvasElement,
    store: EditorStore,
    // The art comes in from the composition root, never from here (#47): the
    // viewport is a GL shell around the runtime and draws nothing itself.
    assets: SceneAssets,
    handlers: ViewportHandlers,
  ) {
    this.store = store
    this.handlers = handlers

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0

    this.scene = new RuntimeScene(store.reader.doc, assets)
    this.scene.rebuildChunks()

    const centre = this.scene.mapCentre()
    this.orbit.target.copy(centre)
    this.orbit.yaw = store.reader.doc.camera.yaw
    this.orbit.pitch = store.reader.doc.camera.pitch
    this.orbit.distance = store.reader.doc.camera.distance

    this.camera = createCamera(store.reader.doc.camera, canvas.clientWidth / Math.max(1, canvas.clientHeight))
    applyRig(this.camera, this.orbit)

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene.scene, this.camera))
    // Built at the real size rather than a placeholder that resize() fixes up
    // later. (That was a suspect for the software-GL black frame below; it was
    // not the cause, but sizing it correctly up front is right anyway.)
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight)),
      0.35,
      0.55,
      0.85,
    )
    this.composer.addPass(this.bloom)
    this.tiltShift = new ShaderPass(TiltShiftShader)
    this.composer.addPass(this.tiltShift)
    this.composer.addPass(new OutputPass())

    this.softwareRenderer = isSoftwareRenderer(this.renderer)
    if (this.softwareRenderer) {
      this.bloom.enabled = false
      this.tiltShift.enabled = false
    }

    // --- overlays ---------------------------------------------------------
    const overlayMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.28,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    this.brushMesh = new THREE.Mesh(new THREE.BufferGeometry(), overlayMaterial)
    this.brushMesh.renderOrder = 900
    this.hoverMesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0xffe98a,
        transparent: true,
        opacity: 0.55,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    this.hoverMesh.renderOrder = 901
    this.selectionBox = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(0x7fd4ff))
    this.selectionBox.visible = false

    this.overlay.add(this.brushMesh, this.hoverMesh, this.selectionBox)
    this.scene.scene.add(this.overlay)
    this.rebuildGrid()

    this.attachEvents()
    this.resize()
    this.loop()
  }

  // --- public API -------------------------------------------------------------

  setOptions(options: Partial<ViewportOptions>): void {
    const wasPlaying = this.options.playing
    this.options = { ...this.options, ...options }
    if (this.options.playing !== wasPlaying) this.togglePlay(this.options.playing)
  }

  /** Called when the store's document changed identity (load, new map). */
  reset(): void {
    this.scene.setDocument(this.store.reader.doc)
    this.scene.applyAtmosphere()
    this.scene.rebuildChunks()
    this.rebuildGrid()
    const centre = this.scene.mapCentre()
    this.orbit.target.copy(centre)
  }

  /** Rebuild only what the store says moved. */
  syncDirty(): void {
    if (!this.store.hasDirtyChunks()) return
    this.scene.rebuildChunks(this.store.takeDirtyChunks())
    // The grid follows the terrain, so sculpting invalidates it too. Rebuilt
    // wholesale rather than per chunk: it is one cheap line buffer, and only
    // the editor pays for it.
    if (this.options.showGrid) this.rebuildGrid()
  }

  refreshAtmosphere(): void {
    this.scene.applyAtmosphere()
  }

  loadSheet(sheet: RgbaImage): void {
    this.scene.refreshSheet(sheet)
  }

  loadSprites(sprites: Record<string, SpriteAsset>): void {
    this.scene.setSprites(sprites)
  }

  startSweep(): void {
    this.sweep = { active: true, t: 0, yaws: sampleYawEnvelope(this.store.reader.doc.camera, 64) }
  }

  cameraState(): { yaw: number; pitch: number; distance: number } {
    return { yaw: this.orbit.yaw, pitch: this.orbit.pitch, distance: this.orbit.distance }
  }

  // --- scripting hooks --------------------------------------------------------
  //
  // Driven by scripts/tour.mjs and scripts/probe.mjs, which run the editor in a
  // headless browser to capture screenshots and to measure rendering. They are
  // here rather than in test-only code because the thing worth driving is the
  // real viewport; nothing in the app calls them.

  /** Skip the post-processing chain, to isolate it when diagnosing. */
  bypassComposer = false

  setCameraForProbe(state: Partial<{ yaw: number; pitch: number; distance: number }>): void {
    if (state.yaw !== undefined) this.orbit.yaw = state.yaw
    if (state.pitch !== undefined) this.orbit.pitch = state.pitch
    if (state.distance !== undefined) this.orbit.distance = state.distance
  }

  /** Look at a particular cell, so a script can click something specific. */
  focusCellForProbe(x: number, y: number, distance?: number): void {
    this.orbit.target.set(x + 0.5, groundHeight(this.store.reader.doc, x + 0.5, y + 0.5), y + 0.5)
    if (distance !== undefined) this.orbit.distance = distance
  }

  /** Aim at an arbitrary world point — a cliff face's middle, say, which is
   *  not the same as the ground height at its cell. */
  setTargetForProbe(x: number, y: number, z: number, distance?: number): void {
    this.orbit.target.set(x, y, z)
    if (distance !== undefined) this.orbit.distance = distance
  }

  hideOverlayForProbe(): void {
    this.overlay.visible = false
  }

  setPassForProbe(name: 'bloom' | 'tiltShift', enabled: boolean): void {
    if (name === 'bloom') this.bloom.enabled = enabled
    else this.tiltShift.enabled = enabled
  }

  /** Adopt the document's rig as the current view, for the "preview" button. */
  applyRigDefaults(): void {
    const rig = this.store.reader.doc.camera
    this.orbit.yaw = rig.yaw
    this.orbit.pitch = rig.pitch
    this.orbit.distance = rig.distance
  }

  /**
   * Open on the map centre at the rig's own distance.
   *
   * Not a fit-the-whole-map framing: at the narrow field of view this look
   * wants, fitting a 36-tile map means standing 80 units back, where the map's
   * own fog — correctly, for gameplay — has already swallowed everything. The
   * rig distance is what the game will actually use, so it is also the honest
   * thing to open on. Zooming out from there is one scroll away.
   */
  frameMap(): void {
    const { width, height } = this.store.reader.doc.size
    const rig = this.store.reader.doc.camera
    this.orbit.target.set(width / 2, 1, height / 2)
    this.orbit.distance = Math.min(rig.bounds.distMax, Math.max(rig.bounds.distMin, rig.distance))
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.frameHandle)
    this.detachEvents()
    this.character?.dispose()
    this.scene.dispose()
    this.composer.dispose()
    this.renderer.dispose()
  }

  // --- internals --------------------------------------------------------------

  private rebuildGrid(): void {
    if (this.gridLines) {
      this.overlay.remove(this.gridLines)
      this.gridLines.geometry.dispose()
    }
    // The grid hugs the terrain rather than lying on the ground plane, where
    // any raised cell would bury it.
    const doc = this.store.reader.doc
    const { width, height } = doc.size
    const points: number[] = []
    const lift = 0.025
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [c00, c01, c11, c10] = cornerHeights(doc, x, y).map((h) => h * 0.5 + lift)
        points.push(
          x, c00, y, x, c01, y + 1,
          x, c01, y + 1, x + 1, c11, y + 1,
          x + 1, c11, y + 1, x + 1, c10, y,
          x + 1, c10, y, x, c00, y,
        )
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
    this.gridLines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 }),
    )
    this.overlay.add(this.gridLines)
  }

  /** A flat overlay quad hugging a cell's top surface. */
  private cellQuad(doc: ReadonlyMapDoc, x: number, y: number, out: number[], lift = 0.03): void {
    if (!inBounds(doc.size, x, y)) return
    const [c00, c01, c11, c10] = cornerHeights(doc, x, y).map((h) => h * 0.5 + lift)
    out.push(
      x, c00, y, x, c01, y + 1, x + 1, c11, y + 1,
      x, c00, y, x + 1, c11, y + 1, x + 1, c10, y,
    )
  }

  private updateBrushPreview(): void {
    const doc = this.store.reader.doc
    const points: number[] = []
    for (const [x, y] of this.options.brushPreview) this.cellQuad(doc, x, y, points)
    const geometry = this.brushMesh.geometry
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
    geometry.computeBoundingSphere()
    this.brushMesh.visible = points.length > 0 && !this.options.playing
  }

  private updateHover(): void {
    const address = this.options.hover
    const doc = this.store.reader.doc
    const points: number[] = []

    if (address && address.kind === SURFACE_TOP) {
      this.cellQuad(doc, address.x, address.y, points, 0.04)
    } else if (address && address.kind === SURFACE_CLIFF) {
      // Highlight exactly the band that was picked, so the artist can see the
      // level their paint would land on.
      const geometry = [
        { origin: [1, 1], u: [0, -1] },
        { origin: [0, 1], u: [1, 0] },
        { origin: [0, 0], u: [0, 1] },
        { origin: [1, 0], u: [-1, 0] },
      ][address.dir]
      const ox = address.x + geometry.origin[0]
      const oz = address.y + geometry.origin[1]
      const ex = ox + geometry.u[0]
      const ez = oz + geometry.u[1]
      const bottom = address.level * 0.5
      const top = (address.level + 1) * 0.5
      const nudge = 0.012
      const nx = geometry.u[1] * nudge
      const nz = -geometry.u[0] * nudge
      points.push(
        ox + nx, bottom, oz + nz, ex + nx, bottom, ez + nz, ex + nx, top, ez + nz,
        ox + nx, bottom, oz + nz, ex + nx, top, ez + nz, ox + nx, top, oz + nz,
      )
    }

    const geometry = this.hoverMesh.geometry
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
    geometry.computeBoundingSphere()
    this.hoverMesh.visible = points.length > 0 && !this.options.playing
  }

  private updateSelection(): void {
    const id = this.options.selectedObjectId
    if (!id || this.options.playing) {
      this.selectionBox.visible = false
      return
    }
    const view = this.scene.objectViews().find((entry) => entry.object.id === id)
    if (!view) {
      this.selectionBox.visible = false
      return
    }
    const box = new THREE.Box3().setFromObject(view.group)
    if (box.isEmpty()) {
      this.selectionBox.visible = false
      return
    }
    this.selectionBox.box.copy(box)
    this.selectionBox.visible = true
    this.selectionBox.updateMatrixWorld(true)
  }

  private viewContext(): ObjectViewContext {
    return {
      rig: this.store.reader.doc.camera,
      nearest: this.store.reader.doc.filtering === 'nearest',
      facingOverride: null,
    }
  }

  private togglePlay(playing: boolean): void {
    if (playing && !this.character) {
      const doc = this.store.reader.doc
      const start = new THREE.Vector3(
        doc.size.width / 2,
        0,
        doc.size.height / 2,
      )
      start.y = groundHeight(doc, start.x, start.z)
      this.character = new Character(this.scene.sprites.hero, this.viewContext(), start)
      this.scene.scene.add(this.character.view.group)
      this.orbit.distance = Math.min(this.orbit.distance, 14)
    } else if (!playing && this.character) {
      this.scene.scene.remove(this.character.view.group)
      this.character.dispose()
      this.character = null
    }
    this.overlay.visible = !playing
  }

  private ndc(event: PointerEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect()
    return [
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    ]
  }

  private modifiers(event: PointerEvent | MouseEvent): PointerModifiers {
    return {
      shift: event.shiftKey,
      alt: event.altKey,
      ctrl: event.ctrlKey || event.metaKey,
      button: (event as PointerEvent).button ?? 0,
    }
  }

  private pickAt(event: PointerEvent): PickResult {
    const [x, y] = this.ndc(event)
    return this.picker.pick(this.scene, this.camera, x, y, event.ctrlKey || event.metaKey)
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.canvas.setPointerCapture(event.pointerId)
    this.lastPointer = { x: event.clientX, y: event.clientY }

    // Middle drags orbit and right drags pan, but a MacBook trackpad has no
    // middle button, so alt+drag orbits as well — the Maya/Unity gesture. Alt
    // is also the eyedropper, so the press is held as 'pending' until it moves
    // far enough to be a drag; a release before that is treated as the click.
    if (event.button === 1) {
      this.dragging = 'orbit'
      return
    }
    if (event.button === 2) {
      this.dragging = 'pan'
      return
    }
    if (event.button === 0 && event.altKey) {
      this.dragging = 'pending'
      this.pending = { x: event.clientX, y: event.clientY, event }
      return
    }
    if (event.button !== 0 || this.options.playing) return

    this.dragging = 'stroke'
    this.handlers.onStrokeStart(this.pickAt(event), this.modifiers(event))
  }

  private onPointerMove = (event: PointerEvent): void => {
    const dx = event.clientX - this.lastPointer.x
    const dy = event.clientY - this.lastPointer.y
    this.lastPointer = { x: event.clientX, y: event.clientY }

    if (this.dragging === 'pending' && this.pending) {
      const moved = Math.hypot(event.clientX - this.pending.x, event.clientY - this.pending.y)
      if (moved < ORBIT_DRAG_THRESHOLD) return
      this.dragging = 'orbit'
      this.pending = null
    }
    if (this.dragging === 'orbit') {
      this.orbit.yaw = wrapDegrees(this.orbit.yaw - dx * 0.4)
      this.orbit.pitch = Math.min(89, Math.max(-5, this.orbit.pitch + dy * 0.3))
      return
    }
    if (this.dragging === 'pan') {
      const yaw = this.orbit.yaw * (Math.PI / 180)
      const scale = this.orbit.distance * 0.0016
      this.orbit.target.x -= (Math.cos(yaw) * dx - Math.sin(yaw) * dy) * scale
      this.orbit.target.z += (Math.sin(yaw) * dx + Math.cos(yaw) * dy) * scale
      return
    }
    if (this.options.playing) return

    const pick = this.pickAt(event)
    this.handlers.onHover(pick)
    if (this.dragging === 'stroke') this.handlers.onStrokeMove(pick, this.modifiers(event))
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId)
    }
    if (this.dragging === 'stroke') this.handlers.onStrokeEnd()
    if (this.dragging === 'pending' && this.pending && !this.options.playing) {
      // Never moved: replay it as the click it turned out to be. Picking uses
      // the press position, not the release position, so a stray pixel of
      // travel cannot land the eyedropper on a different cell.
      const press = this.pending.event
      this.handlers.onStrokeStart(this.pickAt(press), this.modifiers(press))
      this.handlers.onStrokeEnd()
    }
    this.pending = null
    this.dragging = 'none'
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const factor = Math.exp(event.deltaY * 0.0012)
    this.orbit.distance = Math.min(200, Math.max(3, this.orbit.distance * factor))
  }

  private onContextMenu = (event: Event): void => event.preventDefault()

  private onKeyDown = (event: KeyboardEvent): void => {
    this.keys.add(event.key.toLowerCase())
  }

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.key.toLowerCase())
  }

  private attachEvents(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('resize', this.resize)
  }

  private detachEvents(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('resize', this.resize)
  }

  resize = (): void => {
    const width = this.canvas.clientWidth || 1
    const height = this.canvas.clientHeight || 1
    this.renderer.setSize(width, height, false)
    this.composer.setSize(width, height)
    this.bloom.setSize(width, height)
    updateCameraProjection(this.camera, this.store.reader.doc.camera, width / height, this.orbit.distance)
  }

  private loop = (): void => {
    if (this.disposed) return
    this.frameHandle = requestAnimationFrame(this.loop)

    const now = performance.now()
    const realDt = (now - this.lastTime) / 1000
    // Simulation uses a clamped step so a long stall does not teleport the
    // character, but the fps readout must use real time — clamping it made a
    // 2 fps software renderer report 20.
    const dt = Math.min(0.05, realDt)
    this.lastTime = now

    const doc = this.store.reader.doc
    const rig = doc.camera

    // --- camera ------------------------------------------------------------
    if (this.sweep.active) {
      this.sweep.t += dt * 0.25
      if (this.sweep.t >= 1) this.sweep.active = false
      const index = Math.min(
        this.sweep.yaws.length - 1,
        Math.floor(this.sweep.t * this.sweep.yaws.length),
      )
      this.orbit.yaw = this.sweep.yaws[index] ?? this.orbit.yaw
    }

    if (this.options.gameCamera || this.options.playing) {
      const clamped = clampToBounds(rig, this.orbit)
      this.orbit.yaw = clamped.yaw
      this.orbit.pitch = clamped.pitch
      this.orbit.distance = clamped.distance
    }

    const insideEnvelope = withinBounds(rig, this.orbit)

    // --- play mode ---------------------------------------------------------
    if (this.options.playing && this.character) {
      const input = {
        forward: (this.keys.has('w') ? 1 : 0) - (this.keys.has('s') ? 1 : 0),
        strafe: (this.keys.has('d') ? 1 : 0) - (this.keys.has('a') ? 1 : 0),
      }
      this.character.update(doc, input, this.orbit.yaw, dt, this.viewContext())
      // The camera trails the character rather than the map centre.
      this.orbit.target.lerp(
        new THREE.Vector3(this.character.position.x, this.character.position.y + 1, this.character.position.z),
        Math.min(1, dt * 6),
      )
    }

    updateCameraProjection(
      this.camera,
      rig,
      (this.canvas.clientWidth || 1) / (this.canvas.clientHeight || 1),
      this.orbit.distance,
    )
    applyRig(this.camera, this.orbit)

    // --- scene -------------------------------------------------------------
    this.syncDirty()
    this.scene.syncObjects(this.viewContext())
    this.scene.updateObjects(this.orbit.yaw, dt, this.viewContext())
    this.scene.sky.update(this.camera.position, this.scene.mapCentre())

    if (this.gridLines) this.gridLines.visible = this.options.showGrid && !this.options.playing
    this.updateBrushPreview()
    this.updateHover()
    this.updateSelection()

    if (!this.softwareRenderer) {
      this.bloom.strength = doc.atmosphere.bloom
      this.tiltShift.uniforms.amount.value = doc.atmosphere.tiltShift
    }

    if (this.bypassComposer) this.renderer.render(this.scene.scene, this.camera)
    else this.composer.render()

    // --- reporting ---------------------------------------------------------
    this.handlers.onCameraChange({
      yaw: this.orbit.yaw,
      pitch: this.orbit.pitch,
      distance: this.orbit.distance,
      inBounds: insideEnvelope,
    })

    this.fpsAccumulator += realDt
    this.fpsFrames += 1
    if (this.fpsAccumulator >= 0.5) {
      this.handlers.onStats({
        fps: this.fpsFrames / this.fpsAccumulator,
        // Not renderer.info.render.triangles: with a composer that reports the
        // last pass, which is a fullscreen quad.
        triangles: this.scene.stats.triangles,
        meshMs: this.scene.stats.lastMeshMs,
      })
      this.fpsAccumulator = 0
      this.fpsFrames = 0
    }
  }

  /** Where on the ground a screen point lands, for object placement. */
  groundAt(ndcX: number, ndcY: number): THREE.Vector3 | null {
    const hit = this.picker.pick(this.scene, this.camera, ndcX, ndcY, true)
    if (hit.point) return hit.point
    return this.picker.pickPlane(this.camera, ndcX, ndcY, 0)
  }

  cellUnder(address: SurfaceAddress | null): number | null {
    if (!address) return null
    const doc = this.store.reader.doc
    if (!inBounds(doc.size, address.x, address.y)) return null
    return doc.terrain.height[cellIndex(doc.size, address.x, address.y)]
  }
}
