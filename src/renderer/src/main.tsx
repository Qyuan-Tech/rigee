import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { useApp, newTerminalTab } from './store'
import { getTerminal, paneKey } from './terminals'
import { applyFonts } from './fonts'
import './theme.css'

/**
 * Handle for the headless end-to-end checks driven from main (`pnpm smoke:terminal`).
 * The shell document is our own trusted page — this crosses no privilege boundary, and it is the
 * only way to exercise the real keystroke path without a human at the keyboard.
 */
declare global {
  interface Window {
    __onestop: {
      store: typeof useApp
      getTerminal: typeof getTerminal
      paneKey: typeof paneKey
      newTerminalTab: typeof newTerminalTab
    }
  }
}
window.__onestop = { store: useApp, getTerminal, paneKey, newTerminalTab }

// Before render: Monaco and xterm read these at construction time.
applyFonts()

const root = document.getElementById('root')
if (!root) throw new Error('#root missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
