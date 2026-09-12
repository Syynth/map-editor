import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './editor/App'
import './editor/styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('No #root element')

// Not StrictMode-doubled: the viewport owns a WebGL context and a render loop,
// and mounting it twice in development costs a context without proving
// anything. The React tree below it is still strict.
createRoot(root).render(
  import.meta.env.DEV ? (
    <App />
  ) : (
    <StrictMode>
      <App />
    </StrictMode>
  ),
)
