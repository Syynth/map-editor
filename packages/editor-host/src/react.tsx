/**
 * The React glue (#4, #13): a host in context, refs out, selectors in.
 *
 * Adopting actors does not by itself fix the re-render problem the map cares
 * about. `useActor` re-renders on ANY snapshot change, including context the
 * component never reads — so it is deliberately not offered here. What is
 * offered is the shape #4 measured to work: hold a ref, subscribe to a
 * selected slice through `useSelector`, and let the equality function decide
 * whether anything re-renders.
 *
 * The host is built OUTSIDE React, by `createHost` at the composition root,
 * and handed in as a prop rather than created by `useActorRef` inside the
 * provider. Two reasons. The document has one read path with two front
 * doors (#13): the hook below for React, and `reader` directly for the
 * imperative layer — `viewport.ts` and `scene.ts` — which also needs
 * `dispatch`, and so needs the host to exist before and outside any render.
 * And `useActorRef` re-creates its actor when React remounts the component
 * (StrictMode does this on purpose), which would orphan every closure bound
 * to the first one; a host that outlives React has no such seam.
 */

import type { ReadonlyMapDoc } from '@papercut/document'
import { useSelector } from '@xstate/react'
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { SnapshotFrom } from 'xstate'

import type { Host, HostActor, HostChildren } from './host'

const HostContext = createContext<Host | null>(null)

export function HostProvider({ host, children }: { host: Host; children?: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>
}

/** The host itself — for `dispatch`, or to hand a child ref to `useSelector`. Throws outside a provider, since silently returning nothing would hide a wiring mistake until first click. */
export function useHost(): Host {
  const host = useContext(HostContext)
  if (!host) throw new Error('useHost: no <HostProvider> above this component')
  return host
}

/** The root actor's ref. A ref never re-renders; select from it with `useHostSelector`. */
export function useHostRef(): HostActor {
  return useHost().actor
}

type Compare<T> = (a: T, b: T) => boolean

/** A slice of the root snapshot — `mode`, say. Re-renders only when the selected value changes by `compare` (default `===`). */
export function useHostSelector<T>(selector: (snapshot: SnapshotFrom<HostActor>) => T, compare?: Compare<T>): T {
  return useSelector(useHost().actor, selector, compare)
}

/** A slice of the tools actor's snapshot — the brush, the active verb. */
export function useToolsSelector<T>(selector: (snapshot: SnapshotFrom<HostChildren['tools']>) => T, compare?: Compare<T>): T {
  return useSelector(useHost().children.tools, selector, compare)
}

/** A slice of the view actor's snapshot — the grid toggle, the open inspector, the selection. */
export function useViewSelector<T>(selector: (snapshot: SnapshotFrom<HostChildren['view']>) => T, compare?: Compare<T>): T {
  return useSelector(useHost().children.view, selector, compare)
}

/**
 * The React front door to the document (#13). Subscribes to the revision
 * counter — the one thing about the document that changes identity, since
 * the store mutates it in place — and re-selects when it moves. This closes
 * both read hazards at once: memoising on `doc` never recomputes (it never
 * changes identity), and reading without subscribing silently fails to
 * re-render. The selected value is recomputed per revision, not compared,
 * because a revision means something in the document changed and the
 * selector is the cheap part; a component that wants finer control keys a
 * `useMemo` of its own on what this returns.
 */
export function useDocument<T>(selector: (doc: ReadonlyMapDoc) => T): T {
  const { reader } = useHost()
  const revision = useSyncExternalStore(reader.subscribe, reader.getSnapshot)
  return useMemo(() => {
    // Named in the body as well as in the array, and that is the point rather
    // than a trick: `exhaustive-deps` (#37, on since #66 step 7) sees a value
    // the callback never reads and calls it unnecessary, because it cannot
    // know that `reader.doc` is mutated in place and that this counter is the
    // only thing about the document that ever moves. Drop it and this
    // memoises the first render's answer forever.
    void revision
    // `selector` is listed too, so an inline arrow recomputes rather than
    // pinning the first render's — which is why a caller that cares about the
    // cost hoists its selector to module scope.
    return selector(reader.doc)
  }, [reader, revision, selector])
}
