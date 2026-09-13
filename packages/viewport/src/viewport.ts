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
  type DocumentReader,
  type SurfaceAddress,
  structureOf,
  type ReadonlyVoxel,
  frameOf,
  levelCentre,
  toWorld,
  type DocumentTarget,
} from '@papercut/document'
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
  type LayerRange,
} from '@papercut/runtime'
import type { RgbaImage, SpriteAsset } from '@papercut/document'

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
}

/**
 * Which gesture a press turned out to be — the arbitration actor's answer,
 * not a flag this class keeps (#11). The `dragging` union that used to live
 * here SPLIT: deciding which gesture a press is, and replaying an alt press
 * that never travelled as a click, went to `editor-host`'s gesture actor;
 * the per-frame yaw, pitch and pan deltas stayed, because sixty round trips
 * a second through an actor is not what an actor is for.
 */
export type Gesture = 'none' | 'pending' | 'stroke' | 'orbit' | 'pan'

export interface PointerPress {
  x: number
  y: number
  /** DOM button: 0 left, 1 middle, 2 right. */
  button: number
  modifiers: PointerModifiers
  /**
   * What is under a left press, picked HERE and picked ONCE. The old code
   * kept the press event and re-picked it at release to replay an alt click,
   * against a scene the drag may have moved; carrying the pick with the press
   * is what makes the replay land on the cell that was actually pressed.
   */
  pick: EditorPick | null
}

export interface PointerMotion {
  x: number
  y: number
  modifiers: PointerModifiers
}

/**
 * A stroke tick's pick, plus where the pointer's ray meets the horizontal
 * plane through the PRESS's hit. A drag that moves something wants the
 * second and not the first: what is under the cursor mid-drag is whatever
 * the drag put there — the dragged sprite itself, a cliff face the ray
 * crossed — and following it makes the motion lurch along that surface. The
 * plane is fixed at the press, so the pointer's travel maps to ground travel
 * the same way for the whole gesture. `null` when the ray misses the plane
 * (a near-horizontal camera) or the press hit nothing.
 */
/** A press or a hover: the raycast, plus the sketch point under the pointer if one is drawn there. */
export interface EditorPick extends PickResult {
  /**
   * The overlay handle within a few pixels of the pointer, hit-tested where it
   * is DRAWN: the dots are screen-sized and sit on the cap, so a raycast
   * through one lands on the wall or the ground behind, nowhere near it.
   */
  handle: SketchHandle | null
}

export interface SketchHandle {
  readonly structure: string
  readonly index: number
}

export interface StrokePick extends EditorPick {
  plane: { x: number; z: number } | null
}

export interface ViewportHandlers {
  /** A press on the canvas. What gesture it became is not answered here: a press moves nothing, and the next move asks. */
  onPointerDown(press: PointerPress): void
  /** Motion anywhere; the answer is the gesture now in progress, which is what the deltas below are applied against. */
  onPointerMove(motion: PointerMotion): Gesture
  onPointerUp(release: { x: number; y: number }): void
  /** One tick of an open stroke: only sent while `onPointerMove` answers `'stroke'`. */
  onStrokeMove(pick: StrokePick, modifiers: PointerModifiers): void
  /** What the open stroke is carrying: the pick looks past these ids so it answers what they would land on. */
  carrying(): ReadonlySet<string>
  /**
   * Keys held right now, lower-cased. Read every frame for WASD; the set
   * itself lives in the gesture actor and is fed by the app's one keydown
   * dispatcher (#14). This class installed its own `keydown`/`keyup` pair
   * until #66 step 6 — two independent listeners on `window` was the thing
   * that ticket exists to remove.
   */
  heldKeys(): ReadonlySet<string>
  onHover(pick: EditorPick): void
  onCameraChange(state: { yaw: number; pitch: number; distance: number; inBounds: boolean }): void
  onStats(stats: { fps: number; triangles: number; meshMs: number }): void
}

/** Where a play session puts the character down, in world units. The host's play actor computes it. */
export interface PlaySession {
  readonly start: readonly [number, number, number]
}

export interface ViewportOptions {
  /** Cells the brush would affect, previewed under the cursor. */
  brushPreview: Array<[number, number]>
  showGrid: boolean
  /** Clamp the editor camera to what the game rig allows. */
  gameCamera: boolean
  /**
   * The play session, or `null` while editing (#11). Not a boolean: the
   * session is an ACTOR in the host, spawned by `mode.play` and stopped by
   * `mode.edit`, and where the hero starts is the one thing it reads off the
   * document when it starts. Taking the start from the session rather than
   * recomputing it here is what makes the session's lifetime and the
   * character's the same lifetime.
   */
  play: PlaySession | null
  /** Hovered surface, highlighted. */
  hover: SurfaceAddress | null
  /** What is selected, as the scene knows it: framed with a box, whatever its kind. */
  selection: DocumentTarget | null
  /** The height range drawn, in half-tiles, or `null` for all of it — the layer view. */
  layers: LayerRange | null
  /** The sketch being drawn or edited: its points in world space, whether its outline closes, and which point is selected. */
  sketch: SketchOverlay | null
}

export interface SketchOverlay {
  readonly structure: string
  readonly points: ReadonlyArray<readonly [number, number, number]>
  readonly closed: boolean
  readonly selected: number | null
}

const DEFAULT_OPTIONS: ViewportOptions = {
  brushPreview: [],
  showGrid: true,
  gameCamera: false,
  play: null,
  hover: null,
  selection: null,
  layers: null,
  sketch: null,
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
  /** World height of the current left press's hit — the plane `StrokePick.plane` is measured on. */
  private strokePlaneY: number | null = null
  private reader: DocumentReader

  private orbit = { yaw: 45, pitch: 35, distance: 26, target: new THREE.Vector3() }
  private options: ViewportOptions = { ...DEFAULT_OPTIONS }
  private handlers: ViewportHandlers

  private overlay = new THREE.Group()
  private gridLines: THREE.LineSegments | null = null
  private brushMesh: THREE.Mesh
  private hoverMesh: THREE.Mesh
  private sketchLine: THREE.Line
  private sketchPoints: THREE.Points
  private sketchSelected: THREE.Points
  private selectionBox: THREE.Box3Helper

  private character: Character | null = null

  private lastPointer = { x: 0, y: 0 }
  private frameHandle = 0
  private lastTime = performance.now()
  private fpsAccumulator = 0
  private fpsFrames = 0
  private sweep: { active: boolean; t: number; yaws: number[] } = { active: false, t: 0, yaws: [] }
  private disposed = false
  /**
   * The `reader.generation` this viewport last drew. `syncDirty` compares it
   * every frame, so a `document.load` or `document.new` from ANY dispatcher
   * re-points the scene; nothing has to remember to call `reset()` beside the
   * dispatch.
   */
  private drawnGeneration = 0

  constructor(
    private canvas: HTMLCanvasElement,
    reader: DocumentReader,
    // The art comes in from the composition root, never from here (#47): the
    // viewport is a GL shell around the runtime and draws nothing itself.
    assets: SceneAssets,
    handlers: ViewportHandlers,
  ) {
    this.reader = reader
    this.handlers = handlers

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0

    this.scene = new RuntimeScene(reader.doc, assets)
    this.scene.rebuildAll()
    this.drawnGeneration = reader.generation

    const centre = this.scene.mapCentre()
    this.orbit.target.copy(centre)
    this.orbit.yaw = reader.doc.camera.yaw
    this.orbit.pitch = reader.doc.camera.pitch
    this.orbit.distance = reader.doc.camera.distance

    this.camera = createCamera(reader.doc.camera, canvas.clientWidth / Math.max(1, canvas.clientHeight))
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
    // The sketch under the Sketch tool: its outline, its points, the selected point. Drawn on top of everything.
    this.sketchLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xe9a23b, depthTest: false }))
    this.sketchLine.renderOrder = 950
    this.sketchPoints = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xe9a23b, size: 9, sizeAttenuation: false, depthTest: false }))
    this.sketchPoints.renderOrder = 951
    this.sketchSelected = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffffff, size: 13, sizeAttenuation: false, depthTest: false }))
    this.sketchSelected.renderOrder = 952

    this.overlay.add(this.brushMesh, this.hoverMesh, this.selectionBox, this.sketchLine, this.sketchPoints, this.sketchSelected)
    this.scene.scene.add(this.overlay)
    this.rebuildGrid()

    this.attachEvents()
    this.resize()
    this.loop()
  }

  // --- public API -------------------------------------------------------------

  setOptions(options: Partial<ViewportOptions>): void {
    const wasPlaying = this.playing
    const wasLayers = this.options.layers
    this.options = { ...this.options, ...options }
    if (this.playing !== wasPlaying) this.togglePlay(this.options.play)
    // The range changes what every chunk looks like, so it is a full rebuild
    // — the one other thing besides a document swap that is.
    const layers = this.options.layers
    if (layers?.lo !== wasLayers?.lo || layers?.hi !== wasLayers?.hi) {
      this.scene.setLayerRange(layers)
      this.scene.rebuildAll()
    }
  }

  /** A session is running. The flag this replaced was a second copy of the same fact. */
  private get playing(): boolean {
    return this.options.play !== null
  }

  /**
   * Called when the document changed identity (load, new map) — the one
   * change no patch and no dirty chunk describes.
   *
   * `syncDirty` drives this off `reader.generation`, so it is not something a
   * dispatch site has to remember; it stays public only because a script may
   * want to force a full rebuild.
   */
  reset(): void {
    this.scene.setDocument(this.reader.doc)
    this.scene.applyAtmosphere()
    this.scene.rebuildAll()
    this.rebuildGrid()
    // Framing, not re-pointing: the previous map's orbit target can sit
    // outside a smaller new map entirely, and the new map carries its own rig.
    this.frameMap()
  }

  /**
   * Rebuild only what the reader says moved — or everything, when what moved
   * is the document itself.
   */
  syncDirty(): void {
    // Identity first. `replace` marks every chunk dirty as well, so draining
    // the queue against the OLD document is exactly what this branch exists
    // to prevent: the keys are sized for the new map, the arrays are not.
    if (this.reader.generation !== this.drawnGeneration) {
      this.drawnGeneration = this.reader.generation
      this.reader.takeDirtyChunks()
      this.reader.takeDirtyStructures()
      this.reset()
      return
    }
    const structures = this.reader.takeDirtyStructures()
    if (!this.reader.hasDirtyChunks() && structures.length === 0) return
    this.scene.rebuild({ chunks: this.reader.takeDirtyChunks(), structures })
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
    this.sweep = { active: true, t: 0, yaws: sampleYawEnvelope(this.reader.doc.camera, 64) }
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
    this.orbit.target.set(x + 0.5, groundHeight(this.reader.doc, x + 0.5, y + 0.5), y + 0.5)
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
    const rig = this.reader.doc.camera
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
    const [cx, cy, cz] = levelCentre(this.reader.doc)
    const rig = this.reader.doc.camera
    this.orbit.target.set(cx, cy + 1, cz)
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
    // any raised cell would bury it. Every voxel volume's cells, each in its
    // own frame.
    const doc = this.reader.doc
    const points: number[] = []
    const lift = 0.025
    for (const id of doc.structureOrder) {
      const voxel = doc.structures[id]
      if (!voxel || voxel.kind !== 'voxel') continue
      const frame = frameOf(doc, id)
      const at = (lx: number, h: number, lz: number) => {
        const [wx, wz] = toWorld(frame, lx, lz)
        return [wx, frame.y + h, wz]
      }
      const { width, height } = voxel.size
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const [c00, c01, c11, c10] = cornerHeights(voxel, x, y).map((h) => h * 0.5 + lift)
          points.push(
            ...at(x, c00, y), ...at(x, c01, y + 1),
            ...at(x, c01, y + 1), ...at(x + 1, c11, y + 1),
            ...at(x + 1, c11, y + 1), ...at(x + 1, c10, y),
            ...at(x + 1, c10, y), ...at(x, c00, y),
          )
        }
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

  /** A flat overlay quad hugging a cell's top surface, in world space through the volume's frame. */
  private cellQuad(voxel: ReadonlyVoxel, x: number, y: number, out: number[], lift = 0.03): void {
    if (!inBounds(voxel.size, x, y)) return
    // On the ground, under any water: the water surface neither writes depth
    // nor draws before the overlays (see the scene's water material), so a
    // preview on a lake bed shows through the water rather than under it.
    // Under the layer view, the preview sits on the cap the column was cut to.
    const layers = this.options.layers
    const frame = frameOf(this.reader.doc, voxel.id)
    const at = (lx: number, h: number, lz: number) => {
      const [wx, wz] = toWorld(frame, lx, lz)
      return [wx, frame.y + h, wz]
    }
    const [c00, c01, c11, c10] = cornerHeights(voxel, x, y).map((h) => (layers === null ? h : Math.min(h, layers.hi)) * 0.5 + lift)
    out.push(
      ...at(x, c00, y), ...at(x, c01, y + 1), ...at(x + 1, c11, y + 1),
      ...at(x, c00, y), ...at(x + 1, c11, y + 1), ...at(x + 1, c10, y),
    )
  }

  /** The voxel volume a cell-addressed overlay belongs to: the hovered one, else the first. */
  private overlayVoxel(): ReadonlyVoxel | undefined {
    const doc = this.reader.doc
    const hovered = this.options.hover ? structureOf(doc, this.options.hover.structure, 'voxel') : undefined
    if (hovered) return hovered
    for (const id of doc.structureOrder) {
      const s = doc.structures[id]
      if (s && s.kind === 'voxel') return s
    }
    return undefined
  }

  private updateBrushPreview(): void {
    const voxel = this.overlayVoxel()
    const points: number[] = []
    if (voxel) for (const [x, y] of this.options.brushPreview) this.cellQuad(voxel, x, y, points)
    const geometry = this.brushMesh.geometry
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
    geometry.computeBoundingSphere()
    this.brushMesh.visible = points.length > 0 && !this.playing
  }

  private updateHover(): void {
    const address = this.options.hover
    const doc = this.reader.doc
    const points: number[] = []
    const voxel = address ? structureOf(doc, address.structure, 'voxel') : undefined

    if (address && voxel && address.kind === SURFACE_TOP) {
      this.cellQuad(voxel, address.x, address.y, points, 0.04)
    } else if (address && voxel && address.kind === SURFACE_CLIFF) {
      // Highlight exactly the band that was picked, so the artist can see the
      // level their paint would land on.
      const frame = frameOf(doc, voxel.id)
      const at = (lx: number, h: number, lz: number) => {
        const [wx, wz] = toWorld(frame, lx, lz)
        return [wx, frame.y + h, wz]
      }
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
        ...at(ox + nx, bottom, oz + nz), ...at(ex + nx, bottom, ez + nz), ...at(ex + nx, top, ez + nz),
        ...at(ox + nx, bottom, oz + nz), ...at(ex + nx, top, ez + nz), ...at(ox + nx, top, oz + nz),
      )
    }

    const geometry = this.hoverMesh.geometry
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
    geometry.computeBoundingSphere()
    this.hoverMesh.visible = points.length > 0 && !this.playing
  }

  private updateSketch(): void {
    const sketch = this.options.sketch
    const visible = sketch !== null && sketch.points.length > 0 && !this.playing
    this.sketchLine.visible = visible && sketch.points.length > 1
    this.sketchPoints.visible = visible
    this.sketchSelected.visible = visible && sketch.selected !== null && sketch.points[sketch.selected] !== undefined
    if (!visible) return
    const flat = (list: ReadonlyArray<readonly [number, number, number]>) => new THREE.Float32BufferAttribute(list.flatMap((p) => [p[0], p[1], p[2]]), 3)
    const outline = sketch.closed && sketch.points.length > 2 ? [...sketch.points, sketch.points[0]] : sketch.points
    this.sketchLine.geometry.setAttribute('position', flat(outline))
    this.sketchLine.geometry.computeBoundingSphere()
    this.sketchPoints.geometry.setAttribute('position', flat(sketch.points))
    this.sketchPoints.geometry.computeBoundingSphere()
    if (sketch.selected !== null && sketch.points[sketch.selected]) {
      this.sketchSelected.geometry.setAttribute('position', flat([sketch.points[sketch.selected]]))
      this.sketchSelected.geometry.computeBoundingSphere()
    }
  }

  private updateSelection(): void {
    const target = this.options.selection
    const box = target && !this.playing ? this.scene.boundsOf(target) : null
    if (!box) {
      this.selectionBox.visible = false
      return
    }
    this.selectionBox.box.copy(box)
    this.selectionBox.visible = true
    this.selectionBox.updateMatrixWorld(true)
  }

  private viewContext(): ObjectViewContext {
    return {
      rig: this.reader.doc.camera,
      nearest: this.reader.doc.filtering === 'nearest',
      facingOverride: null,
    }
  }

  private togglePlay(session: PlaySession | null): void {
    if (session && !this.character) {
      const start = new THREE.Vector3(session.start[0], session.start[1], session.start[2])
      this.character = new Character(this.scene.sprites.hero, this.viewContext(), start)
      this.scene.scene.add(this.character.view.group)
      this.orbit.distance = Math.min(this.orbit.distance, 14)
    } else if (!session && this.character) {
      this.scene.scene.remove(this.character.view.group)
      this.character.dispose()
      this.character = null
    }
    this.overlay.visible = session === null
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
    }
  }

  private pickAt(event: PointerEvent, lookPast?: ReadonlySet<string>): EditorPick {
    const [x, y] = this.ndc(event)
    // Carrying something, the pick looks past it and through objects: what matters is where it would land.
    const through = event.ctrlKey || event.metaKey || (lookPast !== undefined && lookPast.size > 0)
    return { ...this.picker.pick(this.scene, this.camera, x, y, through, lookPast), handle: this.handleAt(event) }
  }

  /** Within this many CSS pixels of a drawn point, the pointer is on it. */
  private static readonly HANDLE_PX = 10

  private handleAt(event: PointerEvent): SketchHandle | null {
    const sketch = this.options.sketch
    if (!sketch || this.playing) return null
    const rect = this.canvas.getBoundingClientRect()
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top
    let best: SketchHandle | null = null
    let bestDistance = Viewport.HANDLE_PX
    sketch.points.forEach(([x, y, z], index) => {
      const projected = new THREE.Vector3(x, y, z).project(this.camera)
      if (projected.z > 1) return
      const sx = ((projected.x + 1) / 2) * rect.width
      const sy = ((1 - projected.y) / 2) * rect.height
      const distance = Math.hypot(sx - px, sy - py)
      if (distance < bestDistance) {
        bestDistance = distance
        best = { structure: sketch.structure, index }
      }
    })
    return best
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.canvas.setPointerCapture(event.pointerId)
    this.lastPointer = { x: event.clientX, y: event.clientY }

    // Which gesture this is, is not decided here any more. A left press is
    // picked unconditionally — including an alt press, which may yet turn out
    // to be an eyedropper click rather than an orbit — because the pick has to
    // be taken at the press to be the press's, and one raycast per click is
    // not worth arbitrating over.
    const pick = event.button === 0 ? this.pickAt(event) : null
    const handleY = pick?.handle ? this.options.sketch?.points[pick.handle.index]?.[1] : undefined
    this.strokePlaneY = handleY ?? pick?.point?.y ?? null
    this.handlers.onPointerDown({
      x: event.clientX,
      y: event.clientY,
      button: event.button,
      modifiers: this.modifiers(event),
      pick,
    })
  }

  private onPointerMove = (event: PointerEvent): void => {
    const dx = event.clientX - this.lastPointer.x
    const dy = event.clientY - this.lastPointer.y
    this.lastPointer = { x: event.clientX, y: event.clientY }

    const gesture = this.handlers.onPointerMove({ x: event.clientX, y: event.clientY, modifiers: this.modifiers(event) })
    // An alt press that crossed the threshold on THIS event answers 'orbit',
    // so its first frame of travel turns the camera rather than being eaten.
    if (gesture === 'orbit') {
      this.orbit.yaw = wrapDegrees(this.orbit.yaw - dx * 0.4)
      this.orbit.pitch = Math.min(89, Math.max(-5, this.orbit.pitch + dy * 0.3))
      return
    }
    if (gesture === 'pan') {
      const yaw = this.orbit.yaw * (Math.PI / 180)
      const scale = this.orbit.distance * 0.0016
      this.orbit.target.x -= (Math.cos(yaw) * dx - Math.sin(yaw) * dy) * scale
      this.orbit.target.z += (Math.sin(yaw) * dx + Math.cos(yaw) * dy) * scale
      return
    }
    // Still undeclared: no hover either, exactly as before — an alt press
    // jittering under the threshold must not repaint the highlight.
    if (gesture === 'pending') return
    if (this.playing) return

    const pick = this.pickAt(event, gesture === 'stroke' ? this.handlers.carrying() : undefined)
    this.handlers.onHover(pick)
    if (gesture === 'stroke') {
      const [ndcX, ndcY] = this.ndc(event)
      const onPlane = this.strokePlaneY === null ? null : this.picker.pickPlane(this.camera, ndcX, ndcY, this.strokePlaneY)
      this.handlers.onStrokeMove({ ...pick, plane: onPlane ? { x: onPlane.x, z: onPlane.z } : null }, this.modifiers(event))
    }
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId)
    }
    this.handlers.onPointerUp({ x: event.clientX, y: event.clientY })
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const factor = Math.exp(event.deltaY * 0.0012)
    this.orbit.distance = Math.min(200, Math.max(3, this.orbit.distance * factor))
  }

  private onContextMenu = (event: Event): void => event.preventDefault()

  private attachEvents(): void {
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('resize', this.resize)
  }

  private detachEvents(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    window.removeEventListener('resize', this.resize)
  }

  resize = (): void => {
    const width = this.canvas.clientWidth || 1
    const height = this.canvas.clientHeight || 1
    this.renderer.setSize(width, height, false)
    this.composer.setSize(width, height)
    this.bloom.setSize(width, height)
    updateCameraProjection(this.camera, this.reader.doc.camera, width / height, this.orbit.distance)
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

    const doc = this.reader.doc
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

    if (this.options.gameCamera || this.playing) {
      const clamped = clampToBounds(rig, this.orbit)
      this.orbit.yaw = clamped.yaw
      this.orbit.pitch = clamped.pitch
      this.orbit.distance = clamped.distance
    }

    const insideEnvelope = withinBounds(rig, this.orbit)

    // --- play mode ---------------------------------------------------------
    if (this.playing && this.character) {
      const keys = this.handlers.heldKeys()
      const input = {
        forward: (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0),
        strafe: (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0),
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

    if (this.gridLines) this.gridLines.visible = this.options.showGrid && !this.playing
    this.updateBrushPreview()
    this.updateHover()
    this.updateSelection()
    this.updateSketch()

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
    const voxel = structureOf(this.reader.doc, address.structure, 'voxel')
    if (!voxel || !inBounds(voxel.size, address.x, address.y)) return null
    return voxel.terrain.height[cellIndex(voxel.size, address.x, address.y)]
  }
}
