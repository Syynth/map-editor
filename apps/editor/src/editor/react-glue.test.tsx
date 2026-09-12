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

import { createDocument, createMap, raise } from '@map-editor/document'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { HostProvider, createHost, useDocument, useHost, useToolsSelector, type Host } from '@map-editor/editor-host'

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
const heightAtOrigin = (doc: { terrain: { height: readonly number[] } }): number => doc.terrain.height[0]
const heightAtOne = (doc: { terrain: { height: readonly number[] } }): number => doc.terrain.height[1]
const brushSize = (snapshot: { context: { brush: { size: number } } }): number => snapshot.context.brush.size

function mount(ui: (host: Host) => ReactNode): Host {
  const host = createHost({ document: createDocument(createMap(8, 8)) })
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
    // A fresh map's ground is not at zero, so the delta is what is asserted.
    const wasHigh = host.reader.doc.terrain.height[0]

    act(() => {
      host.children.document.send({ type: 'patch', label: 'Raise', patches: raise(host.reader.doc, [[0, 0]], 3) })
    })
    expect(window.document.querySelector('[data-testid="height"]')?.textContent).toBe(String(wasHigh + 3))
    expect(renders.doc).toBe(before.doc + 1)
    expect(renders.tools).toBe(before.tools)

    act(() => void host.dispatch('tools.set', { brush: { size: 5, shape: 'square' } }))
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
    act(() => void host.dispatch('tools.set', { tile: 7 }))
    expect(host.children.tools.getSnapshot().context.tile).toBe(7)
    expect(renders).toBe(before)
  })

  it('reads the live document through useDocument, not a copy taken at mount', () => {
    // The hazard this hook exists to close: the document is mutated in place,
    // so a component that memoised on `doc` would never recompute.
    function Height() {
      return <span data-testid="live">{useDocument(heightAtOne)}</span>
    }

    const host = mount(() => <Height />)
    const before = host.reader.doc.terrain.height[1]

    act(() => {
      host.children.document.send({ type: 'patch', label: 'Raise', patches: raise(host.reader.doc, [[1, 0]], 2) })
    })
    expect(window.document.querySelector('[data-testid="live"]')?.textContent).toBe(String(before + 2))

    act(() => void host.dispatch('undo'))
    expect(window.document.querySelector('[data-testid="live"]')?.textContent).toBe(String(before))
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
