import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { createDocument } from '@map-editor/document'
import { HostProvider, createHost } from '@map-editor/editor-host'
import { UiProvider } from '@map-editor/ui'

import App from './editor/App'
import { loadAutosave } from './editor/autosave'
import { features } from './features'
// The vocabulary's stylesheet — Mantine's base plus the frame — then the
// app's own remainder, which only paints what the vocabulary does not.
import '@map-editor/ui/styles.css'
import './editor/styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('No #root element')

// The composition root, and the reason it is here rather than in `App`: the
// host must exist BEFORE and OUTSIDE any render (`editor-host`'s react glue
// says why — a host built by a hook is rebuilt when React remounts, orphaning
// every closure bound to the first one), and the viewport it drives is
// imperative.
//
// `createDocument` hands back a reader and the actor's logic, and that is all
// an app ever holds (#13): there is no store here to write through, so the
// second write path #66 kept open until step 7 is closed by the type graph.
// Named `source` rather than `document` because this file uses the DOM's.
const source = createDocument(loadAutosave())
// The features are installed here and nowhere else (#35): only an app composes
// a feature into a host. Their commands are dispatchable from this point on,
// and the panels they declare are what the left-hand column renders.
const host = createHost({ document: source, features })

// `UiProvider` sits outside the host: it is the one place Mantine is mounted
// and the tokens become CSS variables, and it needs nothing from the host.
const app = (
  <UiProvider>
    <HostProvider host={host}>
      <App />
    </HostProvider>
  </UiProvider>
)

// Not StrictMode-doubled: the viewport owns a WebGL context and a render loop,
// and mounting it twice in development costs a context without proving
// anything. The React tree below it is still strict.
const wrapped: ReactNode = import.meta.env.DEV ? app : <StrictMode>{app}</StrictMode>

createRoot(root).render(wrapped)
