/**
 * The editor: the frame and its regions.
 *
 * A composition root and nothing else. Each region — top bar, rail, context
 * bar, stage, inspector, status bar — selects exactly what it shows from the
 * host's actors and the document, and dispatches its own commands, so a
 * change re-renders the regions that read it and no others. This component
 * holds no state and re-renders only if the host does.
 *
 * It used to hold all of it: the hovered surface, the brush cells, the
 * camera, the frame stats, the document, and every callback, passed down as
 * props. Every pointer move and every tick of a drag re-rendered the whole
 * editor, which `pnpm perf` measured at 400 ms of script a second just for
 * moving the mouse (#131).
 */

import { useEffect, useMemo } from 'react'

import { useHost } from '@papercut/editor-host'
import { Frame } from '@papercut/ui'

import { saveAutosave } from './autosave'
import { ContextBar } from './bars'
import { InspectorRegion } from './inspector'
import { detectPlatform, installKeyDispatcher } from './keys'
import { Rail } from './rail'
import { Stage } from './stage'
import { StatusBar } from './status'
import { TopBar } from './top'

/** How long the document has to sit still before it is autosaved. */
const AUTOSAVE_DELAY_MS = 1200

export default function App() {
  // Built at the composition root (`main.tsx`), never here: the viewport is
  // handed `host.input` before React has rendered anything, and a host built
  // by a hook is rebuilt when React remounts.
  const host = useHost()
  const platform = useMemo(detectPlatform, [])

  // One listener for the whole editor, holding no key names: what is bound is
  // declared in `editor-host`'s keymap and resolved through the registry (#14).
  useEffect(() => installKeyDispatcher(host, { platform }), [host, platform])

  // Autosave, subscribed rather than rendered: a document change schedules a
  // save, it does not re-render anything.
  //
  // A save still waiting out the delay is flushed on `pagehide` rather than
  // dropped: closing the tab, or the desktop shell reloading into an updated
  // bundle, would otherwise lose the last edit made inside the delay.
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = host.reader.subscribe(() => {
      clearTimeout(pending)
      pending = setTimeout(() => {
        pending = undefined
        saveAutosave(host.reader.doc)
      }, AUTOSAVE_DELAY_MS)
    })
    const flush = () => {
      if (pending === undefined) return
      clearTimeout(pending)
      pending = undefined
      saveAutosave(host.reader.doc)
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      clearTimeout(pending)
      unsubscribe()
    }
  }, [host])

  return (
    <Frame
      top={<TopBar platform={platform} />}
      rail={<Rail platform={platform} />}
      bar={<ContextBar platform={platform} />}
      stage={<Stage platform={platform} />}
      inspector={<InspectorRegion platform={platform} />}
      status={<StatusBar />}
    />
  )
}
