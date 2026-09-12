// PROTOTYPE — throwaway. See Lab.tsx for the question this answers.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { UiProvider, colors } from '@map-editor/ui'
import '@map-editor/ui/styles.css'

import { Lab } from './Lab'

const css = `
  html, body, #root { height: 100%; margin: 0; }
  body { background: ${colors.bg}; color: ${colors.ink}; overflow: hidden; }
  .lab { display: grid; grid-template-columns: 1fr 320px; height: 100%; }
  .lab-canvas { width: 100%; height: 100%; display: block; touch-action: none; }
  .lab-side { overflow-y: auto; border-left: 1px solid ${colors.line}; background: ${colors.bg2}; display: flex; flex-direction: column; }
  .lab-mono { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: ${colors.ink3}; }
  .lab-state { font: 11px/1.4 ui-monospace, Menlo, monospace; color: ${colors.ink2}; margin: 0; white-space: pre-wrap; }
  .lab-bar { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); display: flex; gap: 4px; align-items: center;
    background: ${colors.panel}; border: 1px solid ${colors.line2}; border-radius: 8px; padding: 6px 8px; box-shadow: 0 6px 20px rgba(0,0,0,.4); }
  .lab-bar-label { font: 600 10px/1 ui-monospace, Menlo, monospace; letter-spacing: .08em; color: ${colors.accent}; margin-right: 6px; }
  .lab-bar-hint { font-size: 11px; color: ${colors.ink3}; margin-left: 8px; }
  .lab-bar button { font: inherit; color: ${colors.ink2}; background: none; border: 1px solid transparent; border-radius: 5px; padding: 4px 10px; cursor: pointer; }
  .lab-bar button:hover { color: ${colors.ink}; }
  .lab-bar button.on { background: ${colors.panel2}; color: ${colors.accent}; border-color: ${colors.line2}; }
`

const root = document.getElementById('root')
if (!root) throw new Error('no #root')
createRoot(root).render(
  <StrictMode>
    <UiProvider>
      <style>{css}</style>
      <Lab />
    </UiProvider>
  </StrictMode>,
)
