import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { EditorStore } from '@map-editor/document'
import { HostProvider, createHost } from '@map-editor/editor-host'

import App from './editor/App'
import { loadAutosave } from './editor/autosave'
import './editor/styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('No #root element')

// The composition root, and the reason it is here rather than in `App`: the
// host must exist BEFORE and OUTSIDE any render (`editor-host`'s react glue
// says why — a host built by a hook is rebuilt when React remounts, orphaning
// every closure bound to the first one), and the viewport it drives is
// imperative. `App` still takes the store as well, because it writes through
// it directly until #66 step 7 gives those writes commands of their own.
const store = new EditorStore(loadAutosave())
const host = createHost({ store })

const app = (
  <HostProvider host={host}>
    <App store={store} />
  </HostProvider>
)

// Not StrictMode-doubled: the viewport owns a WebGL context and a render loop,
// and mounting it twice in development costs a context without proving
// anything. The React tree below it is still strict.
const wrapped: ReactNode = import.meta.env.DEV ? app : <StrictMode>{app}</StrictMode>

createRoot(root).render(wrapped)
