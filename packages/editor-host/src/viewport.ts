/**
 * The viewport actor: what the viewport reports back to the editor.
 *
 * The surface under the pointer and the cells a brush there would touch, the
 * camera as the status bar reads it, and the frame stats. These change at
 * pointer and frame rate, which is exactly why they are an actor rather than
 * React state: a component selects the one field it shows and re-renders
 * when that field changes, and nothing else does. When they lived in `App`'s
 * state, every pointer move re-rendered the whole editor.
 *
 * Every event compares before it writes. A pointer that moves within a cell,
 * or a camera that moved less than the readout shows, leaves the snapshot as
 * it was, so subscribers are not even asked.
 *
 * Not the view actor (`view.ts`): that one holds what the artist SET — the
 * grid, the selection, the layer range. This one holds what the viewport
 * OBSERVED, plus the one input the viewport has that is neither document nor
 * setting: a template sheet the artist loaded from a file, which overrides the
 * generated one until the document's materials change.
 *
 * Two commands ask the viewport to move its camera — frame the level, sweep
 * the game camera's bounds. The actor answers each with an EMITTED event
 * (`frame`, `sweep`) that whoever holds the viewport listens for, so a button
 * in the top bar and a keybinding reach the camera the same way, and nothing
 * outside the stage holds the `Viewport` object.
 */

import type { RgbaImage, SurfaceAddress } from '@papercut/document'
import { commands, reserveOwner } from '@papercut/registry'
import { setup, types } from 'xstate'

export const VIEWPORT_OWNER = reserveOwner('editor-host.viewport')

commands.declare(VIEWPORT_OWNER, { id: 'viewport.frame', title: 'Frame the Level', category: 'View' })
commands.declare(VIEWPORT_OWNER, { id: 'viewport.sweep', title: "Sweep the Game Camera's Bounds", category: 'View' })

export interface CameraReadout {
  readonly yaw: number
  readonly pitch: number
  readonly distance: number
  /** Whether the editor camera is inside what the game's rig allows. */
  readonly inBounds: boolean
}

export interface FrameStats {
  readonly fps: number
  readonly triangles: number
  readonly meshMs: number
}

export type BrushCells = ReadonlyArray<readonly [number, number]>

export interface ViewportState {
  /** The surface under the pointer, or `null` over nothing. */
  readonly hover: SurfaceAddress | null
  /** The cells a terrain stroke at the hovered surface would touch; empty under any other tool. */
  readonly brushCells: BrushCells
  readonly camera: CameraReadout
  readonly stats: FrameStats
  /** The viewport fell back to a software rasterizer and dropped post-processing. */
  readonly softwareRenderer: boolean
  /** A template sheet loaded from a file, drawn instead of the generated one; `null` draws the generated sheet. */
  readonly loadedSheet: RgbaImage | null
  /** What loading a sheet had to say: a size mismatch, or why it failed. */
  readonly sheetWarning: string | null
}

const INITIAL: ViewportState = {
  hover: null,
  brushCells: [],
  camera: { yaw: 45, pitch: 35, distance: 26, inBounds: true },
  stats: { fps: 0, triangles: 0, meshMs: 0 },
  softwareRenderer: false,
  loadedSheet: null,
  sheetWarning: null,
}

export function sameSurface(a: SurfaceAddress | null, b: SurfaceAddress | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.structure === b.structure && a.kind === b.kind && a.x === b.x && a.y === b.y && a.dir === b.dir && a.level === b.level
}

function sameCells(a: BrushCells, b: BrushCells): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false
  return true
}

/** Within what the status bar shows: a tenth of a unit, under a degree. */
function sameCamera(a: CameraReadout, b: CameraReadout): boolean {
  return Math.abs(a.yaw - b.yaw) < 0.5 && Math.abs(a.pitch - b.pitch) < 0.5 && Math.abs(a.distance - b.distance) < 0.05 && a.inBounds === b.inBounds
}

export const viewportLogic = setup({
  schemas: {
    context: types<ViewportState>(),
    events: {
      hover: types<{ surface: SurfaceAddress | null; cells: BrushCells }>(),
      camera: types<{ camera: CameraReadout }>(),
      stats: types<{ stats: FrameStats }>(),
      renderer: types<{ software: boolean }>(),
      /** A sheet loaded from a file (or `null` to go back to the generated one), and what loading it said. */
      sheet: types<{ image: RgbaImage | null; warning: string | null }>(),
      command: types<{ id: string; args: unknown }>(),
    },
    emitted: {
      frame: types<{ type: 'frame' }>(),
      sweep: types<{ type: 'sweep' }>(),
    },
  },
}).createMachine({
  id: 'viewport',
  context: INITIAL,
  initial: 'ready',
  states: {
    ready: {
      on: {
        hover: ({ context, event }) => {
          const surface = sameSurface(context.hover, event.surface)
          const cells = sameCells(context.brushCells, event.cells)
          if (surface && cells) return undefined
          return { context: { hover: surface ? context.hover : event.surface, brushCells: cells ? context.brushCells : event.cells } }
        },
        camera: ({ context, event }) => (sameCamera(context.camera, event.camera) ? undefined : { context: { camera: event.camera } }),
        stats: ({ event }) => ({ context: { stats: event.stats } }),
        renderer: ({ context, event }) => (context.softwareRenderer === event.software ? undefined : { context: { softwareRenderer: event.software } }),
        sheet: ({ context, event }) =>
          context.loadedSheet === event.image && context.sheetWarning === event.warning ? undefined : { context: { loadedSheet: event.image, sheetWarning: event.warning } },
        command: ({ event }, enq) => {
          if (event.id === 'viewport.frame') enq.emit({ type: 'frame' })
          else if (event.id === 'viewport.sweep') enq.emit({ type: 'sweep' })
          else return undefined
          return {}
        },
      },
    },
  },
})

export type ViewportLogic = typeof viewportLogic
