/**
 * The editor: the startup screen until a project is open, then the frame
 * and its regions.
 *
 * A composition root and nothing else. Each region — top bar, rail, context
 * bar, stage, inspector, status bar — selects exactly what it shows from the
 * host's actors and the document, and dispatches its own commands, so a
 * change re-renders the regions that read it and no others. This component
 * re-renders only when a project opens or closes.
 *
 * It used to hold all of it: the hovered surface, the brush cells, the
 * camera, the frame stats, the document, and every callback, passed down as
 * props. Every pointer move and every tick of a drag re-rendered the whole
 * editor, which `pnpm perf` measured at 400 ms of script a second just for
 * moving the mouse (#131).
 */

import { useEffect, useMemo } from 'react'

import { useHost, useProjectSelector } from '@papercut/editor-host'
import { Frame } from '@papercut/ui'

import { ContextBar } from './bars'
import { InspectorRegion } from './inspector'
import { detectPlatform, installKeyDispatcher } from './keys'
import { Rail } from './rail'
import { saveNow, type Session } from './session'
import { ProjectSettings } from './settings'
import { Stage } from './stage'
import { Startup } from './startup'
import { StatusBar } from './status'
import { TopBar } from './top'

/** How long the document has to sit still before it is written to its file. */
const AUTOSAVE_DELAY_MS = 1200

export default function App({ session }: { session: Session }) {
  // Built at the composition root (`main.tsx`), never here: the viewport is
  // handed `host.input` before React has rendered anything, and a host built
  // by a hook is rebuilt when React remounts.
  const host = useHost()
  const platform = useMemo(detectPlatform, [])
  const folder = useProjectSelector((snapshot) => snapshot.context.folder)

  // One listener for the whole editor, holding no key names: what is bound is
  // declared in `editor-host`'s keymap and resolved through the registry (#14).
  useEffect(() => installKeyDispatcher(host, { platform }), [host, platform])

  // Autosave, subscribed rather than rendered: a document change schedules a
  // write of the map file, it does not re-render anything. The project file
  // is written with it; a project edit alone is written on its own.
  //
  // A save still waiting out the delay is flushed on `pagehide` rather than
  // dropped: closing the window, or the desktop shell reloading into an
  // updated bundle, would otherwise lose the last edit made inside the delay.
  useEffect(() => {
    if (folder === null) return
    let pending: ReturnType<typeof setTimeout> | undefined
    const save = (): void => {
      pending = undefined
      if (host.children.project.getSnapshot().context.folder === null) return
      saveNow(host, session).catch((error: unknown) => console.warn(`[editor] autosave failed: ${String(error)}`))
    }
    const schedule = (): void => {
      clearTimeout(pending)
      pending = setTimeout(save, AUTOSAVE_DELAY_MS)
    }
    const unsubscribe = host.reader.subscribe(schedule)
    const project = host.children.project.subscribe(schedule)
    const flush = (): void => {
      if (pending === undefined) return
      clearTimeout(pending)
      save()
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      clearTimeout(pending)
      unsubscribe()
      project.unsubscribe()
    }
  }, [host, session, folder])

  if (folder === null) return <Startup session={session} />

  return (
    <>
      <ProjectSettings session={session} />
      <Frame
        top={<TopBar platform={platform} session={session} />}
        rail={<Rail platform={platform} />}
        bar={<ContextBar platform={platform} />}
        stage={<Stage platform={platform} />}
        inspector={<InspectorRegion platform={platform} />}
        status={<StatusBar />}
      />
    </>
  )
}
