// @vitest-environment jsdom
/**
 * The React glue, under a real renderer (#10, #66 step 7's gap 8).
 *
 * What is worth testing here is not that a hook returns a value — it is the
 * claim the glue is built on and that nothing else in the repo checks: a
 * dispatch re-renders EXACTLY the component that selected what changed.
 * `useActor` is deliberately not offered because it re-renders on any snapshot
 * change; if `useToolsSelector` or `useDocument` quietly behaved that way, the
 * editor would still look right and every panel would re-render on every brush
 * tick. So each component below counts its own renders, and the assertions are
 * on those counts.
 *
 * jsdom rather than a fake renderer, and `act` rather than a timer: this is the
 * one file in the repo that needs a DOM, and it needs one because the thing
 * under test is `useSyncExternalStore`'s and `useSelector`'s subscription
 * behaviour, which a hand-rolled renderer would emulate rather than exercise.
 *
 * It lives in the app rather than beside the glue for the reason `keys.test.ts`
 * next door does: `editor-host` compiles without `DOM` and without a renderer,
 * deliberately — its tsconfig says so — and a test that needs both belongs
 * where both already are. It reaches the glue through the package barrel, the
 * way the app does.
 */

import {
  createDocument,
  createMap,
  raise,
  topHeight,
  type MapDoc,
  type ReadonlyMapDoc,
  type VoxelStructure,
} from '@papercut/document'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { features } from '../features'

import { HostProvider, createHost, useDocument, useDocumentSelector, useHost, useToolsSelector, useViewportSelector, type Host } from '@papercut/editor-host'

/** The root voxel volume a fresh level has, mutable for setup: `createMap` names it `ground`. */
const ground = (doc: ReadonlyMapDoc | MapDoc): VoxelStructure => doc.structures.ground as VoxelStructure


// React's own flag for "these renders are inside `act`" — without it every
// `act` call warns that the environment is not configured for one, and the
// warning is the only thing that says a render was not flushed.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const started: Array<{ host: Host; root: Root; container: HTMLElement }> = []

afterEach(() => {
  for (const { host, root, container } of started.splice(0)) {
    act(() => root.unmount())
    container.remove()
    host.stop()
  }
})

/**
 * Module scope, and each one written out rather than made by a factory: a
 * factory returns a NEW arrow per render, `useDocument` lists `selector` in its
 * dependencies, and the memo would then recompute every render no matter what
 * the revision did — which would make the memoisation these assert untestable.
 */
const heightAtOrigin = (doc: ReadonlyMapDoc): number => topHeight(ground(doc), 0, 0)
const heightAtOne = (doc: ReadonlyMapDoc): number => topHeight(ground(doc), 1, 0)
const brushSize = (snapshot: { context: { features: Readonly<Record<string, unknown>> } }): number => (snapshot.context.features.terrain as { brush: { size: number } }).brush.size

function mount(ui: (host: Host) => ReactNode): Host {
  const host = createHost({ document: createDocument(createMap(8, 8)), features })
  const container = window.document.createElement('div')
  window.document.body.append(container)
  const root = createRoot(container)
  started.push({ host, root, container })
  act(() => root.render(<HostProvider host={host}>{ui(host)}</HostProvider>))
  return host
}

describe('the React glue', () => {
  it('re-renders the document subscriber on a write and the tools subscriber on a tools.set, and neither on the other', () => {
    const renders = { doc: 0, tools: 0 }

    function Height() {
      renders.doc += 1
      return <span data-testid="height">{useDocument(heightAtOrigin)}</span>
    }

    function Brush() {
      renders.tools += 1
      return <span data-testid="brush">{useToolsSelector(brushSize)}</span>
    }

    // Siblings, not nested: a parent that re-rendered would re-render its
    // child for free and the counts would prove nothing.
    const host = mount(() => (
      <>
        <Height />
        <Brush />
      </>
    ))
    const before = { ...renders }
    // A fresh map's ground is one cube high, not zero, so the delta is what is asserted.
    const wasHigh = heightAtOrigin(host.reader.doc)

    act(() => {
      host.children.document.send({ type: 'patch', label: 'Raise', patches: raise(host.reader.doc, ground(host.reader.doc), [[0, 0]], 3) })
    })
    expect(window.document.querySelector('[data-testid="height"]')?.textContent).toBe(String(wasHigh + 3))
    expect(renders.doc).toBe(before.doc + 1)
    expect(renders.tools).toBe(before.tools)

    act(() => void host.dispatch('terrain.params', { brush: { size: 5, shape: 'square' } }))
    expect(window.document.querySelector('[data-testid="brush"]')?.textContent).toBe('5')
    expect(renders.tools).toBe(before.tools + 1)
    expect(renders.doc).toBe(before.doc + 1)
  })

  it('does not re-render a selector whose selected value did not change', () => {
    let renders = 0

    function Brush() {
      renders += 1
      return <span>{useToolsSelector(brushSize)}</span>
    }

    const host = mount(() => <Brush />)
    const before = renders

    // A real transition on the tools actor, changing a parameter this
    // component does not select. `useSelector` compares what the selector
    // returned, which is the whole reason `useActor` is not offered.
    act(() => void host.dispatch('terrain.params', { tile: 7 }))
    expect((host.children.tools.getSnapshot().context.features.terrain as { tile: number }).tile).toBe(7)
    expect(renders).toBe(before)
  })

  it('reads the live document through useDocument, not a copy taken at mount', () => {
    // The hazard this hook exists to close: the document is mutated in place,
    // so a component that memoised on `doc` would never recompute.
    function Height() {
      return <span data-testid="live">{useDocument(heightAtOne)}</span>
    }

    const host = mount(() => <Height />)
    const before = heightAtOne(host.reader.doc)

    act(() => {
      host.children.document.send({ type: 'patch', label: 'Raise', patches: raise(host.reader.doc, ground(host.reader.doc), [[1, 0]], 2) })
    })
    expect(window.document.querySelector('[data-testid="live"]')?.textContent).toBe(String(before + 2))

    act(() => void host.dispatch('undo'))
    expect(window.document.querySelector('[data-testid="live"]')?.textContent).toBe(String(before))
  })

  it('useDocumentSelector with an equality re-renders only when what it selected changed, not on every revision', () => {
    let renders = 0

    function Height() {
      renders += 1
      return <span data-testid="selected">{useDocumentSelector(heightAtOrigin, { equal: Object.is })}</span>
    }

    const host = mount(() => <Height />)
    const before = renders
    const wasHigh = heightAtOrigin(host.reader.doc)

    // A revision that leaves the selected cell alone: no render.
    act(() => {
      host.children.document.send({ type: 'patch', label: 'Raise', patches: raise(host.reader.doc, ground(host.reader.doc), [[3, 3]], 1) })
    })
    expect(renders).toBe(before)

    act(() => {
      host.children.document.send({ type: 'patch', label: 'Raise', patches: raise(host.reader.doc, ground(host.reader.doc), [[0, 0]], 2) })
    })
    expect(renders).toBe(before + 1)
    expect(window.document.querySelector('[data-testid="selected"]')?.textContent).toBe(String(wasHigh + 2))
  })

  it('a settled read holds while a stroke is open and catches up when it closes', () => {
    let renders = 0

    function Height() {
      renders += 1
      return <span data-testid="settled">{useDocument(heightAtOrigin, { settled: true })}</span>
    }

    const host = mount(() => <Height />)
    const wasHigh = heightAtOrigin(host.reader.doc)
    const modifiers = { shift: false, alt: false, ctrl: false }
    const top = { structure: 'ground', kind: 0 as const, x: 5, y: 5, dir: -1, level: 0 }

    // A terrain stroke open at the far corner; an edit to the cell this component reads lands mid-stroke.
    act(() => void host.dispatch('tools.set', { tool: 'terrain' }))
    act(() => void host.input.pointerDown({ x: 50, y: 50, button: 0, modifiers, pick: { surface: top, point: { x: 5.5, z: 5.5 }, objectId: null } }))
    expect(host.input.gesture()).toBe('stroke')
    const during = renders
    act(() => {
      host.children.document.send({ type: 'patch', label: 'Raise', patches: raise(host.reader.doc, ground(host.reader.doc), [[0, 0]], 3) })
    })
    expect(renders).toBe(during)
    expect(window.document.querySelector('[data-testid="settled"]')?.textContent).toBe(String(wasHigh))

    act(() => host.input.pointerUp({ x: 50, y: 50 }))
    expect(window.document.querySelector('[data-testid="settled"]')?.textContent).toBe(String(wasHigh + 3))
  })

  it('a viewport readout re-renders only the component that selected the field that moved', () => {
    const renders = { hover: 0, camera: 0 }

    function Hover() {
      renders.hover += 1
      return <span>{useViewportSelector((snapshot) => snapshot.context.hover?.x ?? -1)}</span>
    }

    function Camera() {
      renders.camera += 1
      return <span>{useViewportSelector((snapshot) => Math.round(snapshot.context.camera.yaw))}</span>
    }

    const host = mount(() => (
      <>
        <Hover />
        <Camera />
      </>
    ))
    const before = { ...renders }
    const at = (x: number) => ({ structure: 'ground', kind: 0 as const, x, y: 1, dir: -1, level: 0 })

    act(() => host.children.viewport.send({ type: 'hover', surface: at(2), cells: [] }))
    expect(renders).toEqual({ hover: before.hover + 1, camera: before.camera })
    // The same cell again: the actor keeps its snapshot, so nothing re-renders.
    act(() => host.children.viewport.send({ type: 'hover', surface: at(2), cells: [] }))
    expect(renders.hover).toBe(before.hover + 1)
    act(() => host.children.viewport.send({ type: 'camera', camera: { yaw: 90, pitch: 35, distance: 26, inBounds: true } }))
    expect(renders).toEqual({ hover: before.hover + 1, camera: before.camera + 1 })
  })

  it('throws outside a provider rather than returning nothing', () => {
    // A wiring mistake that reached first click would be much harder to see
    // than one that fails at mount.
    function Orphan() {
      useHost()
      return null
    }
    const container = window.document.createElement('div')
    const root = createRoot(container)
    expect(() => act(() => root.render(<Orphan />))).toThrow(/no <HostProvider>/)
    act(() => root.unmount())
  })
})
