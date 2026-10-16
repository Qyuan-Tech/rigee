import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// FIRST, and for its side effect: it installs the implementation behind `@rigee/plugin-api`.
// A plugin's first line may call into that package, and an uninstalled host throws — the right
// failure, but only worth having if it cannot happen. Nothing below may move above it.
import './plugins/shellHost'
import { App } from './App'
import { LazyPluginsView } from './components/LazyPluginsView'
import { menuProbe } from './contextMenu'
import { activatedPlugins } from './plugins/activate'
import { bind } from './plugins/bindings'
import { editorsOnRequest, resolveViewType } from './plugins/registry'
import { useApp, newTerminalTab } from './store'
import { getTerminal, paneKey } from './terminals'
import { applyFonts } from './fonts'
import { loadKeyboardLayout } from './shortcuts'
import './theme.css'

/**
 * Handle for the headless end-to-end checks driven from main (`pnpm smoke:terminal`).
 * The shell document is our own trusted page — this crosses no privilege boundary, and it is the
 * only way to exercise the real keystroke path without a human at the keyboard.
 *
 * `plugins` is here for `pnpm smoke:plugins`, which has to assert a negative the DOM cannot show:
 * that opening a text file did NOT load the PDF plugin — and for `pnpm smoke:markdown`, that a
 * Markdown file still opens as text and offers its preview instead. All are cordis-free lookups, so
 * reaching for them from the smoke script cannot itself change what is loaded.
 *
 * `menus` is for `pnpm smoke:tabs`: the tab strip's menu is native, so the check answers it here
 * rather than clicking it.
 */
declare global {
  interface Window {
    __rigee: {
      store: typeof useApp
      getTerminal: typeof getTerminal
      paneKey: typeof paneKey
      newTerminalTab: typeof newTerminalTab
      plugins: {
        activated: typeof activatedPlugins
        resolveViewType: typeof resolveViewType
        editorsOnRequest: typeof editorsOnRequest
      }
      menus: typeof menuProbe
    }
  }
}
window.__rigee = {
  store: useApp,
  getTerminal,
  paneKey,
  newTerminalTab,
  plugins: { activated: activatedPlugins, resolveViewType, editorsOnRequest },
  menus: menuProbe
}

/*
 * The shell's own view, bound the same way a plugin binds one.
 *
 * Only the plugins manager is here, and only because it has to survive every plugin being turned
 * off — including itself, if it were one. Binding it through the ordinary table rather than
 * special-casing it in the view host means the activity bar, the panel and the namespace rules
 * treat it exactly as they treat anything a plugin contributes.
 */
bind('view', 'shell.plugins', LazyPluginsView)

// Before render: xterm reads these at construction time.
applyFonts()
// Asynchronous, and the US layout stands in until it lands, so it holds nothing up.
loadKeyboardLayout()

const root = document.getElementById('root')
if (!root) throw new Error('#root missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
