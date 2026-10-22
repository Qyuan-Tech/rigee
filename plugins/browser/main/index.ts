import { app } from 'electron'
import { registerBrowserCommands } from '../protocol'
import { translatorFor } from './l10n'
import { BrowserTabs } from './tabs'
import type { Context, Plugin } from 'cordis'
import type { EmitBrowserEvent } from '../protocol'

/**
 * The browser's main half: sixteen commands, one app-level listener, and the native views.
 *
 * All of it used to be inline in src/main/index.ts. The only structural change is where the
 * WebContentsViews hang: the shell built a `BrowserTabs` inside `createWindow`, so the manager was
 * born and died with the window; a plugin fiber outlives it (closing the window on macOS leaves
 * the app running). Hence the lazy build below, keyed on the window identity.
 */

/**
 * Outstanding HTTP auth challenges, keyed by the id handed to the renderer. The callback must be
 * invoked exactly once: calling it with no arguments cancels the request, and never calling it
 * leaves the page loading forever.
 */
type AuthCallback = (username?: string, password?: string) => void

/** A dialog nobody answers must not pin the request open indefinitely. */
const AUTH_TIMEOUT_MS = 2 * 60 * 1000

const plugin: Plugin = {
  name: 'browser',
  // Mandatory, and not a formality: reading `ctx.commands` undeclared throws, and a half whose
  // injection cannot be satisfied sits in PENDING forever with apply() never running.
  inject: ['commands', 'shell'],
  apply(ctx: Context) {
    // Captured once, at activation, and BOUND — the bind is not decoration. cordis substitutes
    // the shadow context (the thing that makes `this.ctx` mean *this* plugin) in the apply trap
    // only `if (thisArg === outer)`, i.e. only when the method is called with the service proxy as
    // its receiver. A bare `const emit = ctx.shell.emit` therefore arrives with `this === undefined`
    // and throws `Cannot read properties of undefined (reading 'ctx')` at the first navigation
    // event. Measured per call: 17.7 us through ctx, 4.5 us through a held service, 0.22 us bound
    // — and `emit` fires on every navigation of every tab, `setBounds` on every ResizeObserver
    // tick and every splitter drag.
    const commands = ctx.commands
    const shell = ctx.shell
    const register = commands.register.bind(commands)
    const emit: EmitBrowserEvent = shell.emit.bind(shell)
    const shellWindow = shell.window.bind(shell)
    const shellWc = shell.webContents.bind(shell)
    // Asked each time something is said: the user can switch language while a page is open.
    const locale = shell.locale.bind(shell)

    let tabs: BrowserTabs | null = null
    const pendingAuth = new Map<string, AuthCallback>()
    let authSeq = 0

    /** The live manager, or null when no view has ever been created against this window. */
    const peek = (): BrowserTabs | null => {
      // A window that has gone away (macOS close, then reopen) took its child views with it. The
      // stale manager would happily hand out ids for views that no longer composite anywhere.
      if (tabs && tabs.ownerWindow().isDestroyed()) tabs = null
      return tabs
    }

    /** The manager, building it on first use. Throws exactly where the old handler threw. */
    const live = (): BrowserTabs => {
      const existing = peek()
      const window = shellWindow()
      if (!window) throw new Error('window not ready')
      if (existing && existing.ownerWindow() === window) return existing
      existing?.destroyAll()
      tabs = new BrowserTabs(window, emit, locale)
      return tabs
    }

    registerBrowserCommands(register, {
      'browser:create': ({ url, bounds }) => ({ viewId: live().create(url, bounds) }),
      'browser:destroy': ({ viewId }) => { peek()?.destroy(viewId) },
      'browser:show': ({ viewId, bounds }) => { peek()?.show(viewId, bounds) },
      'browser:hide': ({ viewId }) => { peek()?.hide(viewId) },
      'browser:focus': ({ viewId }) => { peek()?.focus(viewId) },
      'browser:releaseFocus': ({ viewId }) => {
        // The shell is the only other surface that can hold the keyboard, and nothing else would
        // take it — but only when this view really was holding it. A pane leaving the active group
        // and another arriving is one React commit, so an unconditional hand-back would sometimes
        // run after the new page's claim and leave the user typing into the tab strip.
        if (peek()?.releaseFocus(viewId)) shellWc()?.focus()
      },
      'browser:syncVisible': ({ viewIds }) => { peek()?.syncVisible(viewIds) },
      'browser:setBounds': ({ viewId, bounds }) => { peek()?.setBounds(viewId, bounds) },
      'browser:navigate': ({ viewId, url }) => { peek()?.navigate(viewId, url) },
      'browser:goBack': ({ viewId }) => { peek()?.goBack(viewId) },
      'browser:goForward': ({ viewId }) => { peek()?.goForward(viewId) },
      'browser:reload': ({ viewId }) => { peek()?.reload(viewId) },
      'browser:stop': ({ viewId }) => { peek()?.stop(viewId) },
      'browser:openDevTools': ({ viewId }) => { peek()?.openDevTools(viewId) },
      'browser:visibleIds': () => peek()?.visibleIds() ?? [],
      'browser:authResponse': ({ requestId, username, password }) => {
        const cb = pendingAuth.get(requestId)
        if (!cb) return // already timed out, or answered twice
        pendingAuth.delete(requestId)
        if (username === null) cb()
        else cb(username, password)
      }
    })

    /**
     * HTTP 401/407. Registered once on `app`, not per WebContents: Session has no 'login' event,
     * and the app-level signature is the only one that tells us which WebContents asked, so we can
     * attribute the prompt to the right tab.
     *
     * Signature is 5 args here. (WebContents' own 'login' takes 4 — dropping
     * authenticationResponseDetails there is a silent footgun that binds `callback` to authInfo.)
     *
     * Through `ctx.effect`, because an app-level listener that outlives the plugin that installed
     * it is a leak with teeth: it would keep answering with a closure over a dead BrowserTabs.
     */
    ctx.effect(() => {
      const onLogin = (
        event: Electron.Event,
        webContents: Electron.WebContents | null,
        details: Electron.AuthenticationResponseDetails,
        authInfo: Electron.AuthInfo,
        callback: AuthCallback
      ): void => {
        const viewId = webContents ? peek()?.idFor(webContents) ?? null : null
        if (!viewId) return // not one of our browser tabs; let Electron's default (cancel) apply
        event.preventDefault()

        const requestId = `auth${++authSeq}`
        pendingAuth.set(requestId, callback)
        const { t } = translatorFor(locale())
        emit('authRequested', {
          viewId,
          requestId,
          host: authInfo.host || authInfo.realm || t('the server'),
          realm: authInfo.realm,
          isProxy: authInfo.isProxy,
          url: details.url
        })

        setTimeout(() => {
          const cb = pendingAuth.get(requestId)
          if (!cb) return
          pendingAuth.delete(requestId)
          cb()
        }, AUTH_TIMEOUT_MS).unref()
      }

      app.on('login', onLogin)
      return () => { app.off('login', onLogin) }
    }, 'app login handler')

    /**
     * A BrowserWindow gives focus to its own webContents, never to a child WebContentsView, so a
     * page the user is looking at receives nothing they type unless we say so. The shell asks
     * after load and on window focus; without this claim the window looks completely normal while
     * swallowing every keystroke.
     *
     * The claim is for the NOMINATED view, not for any visible one. With a row of editor groups
     * several pages are on screen at once, and "the first visible" means the one created earliest —
     * so returning to the app would drop the cursor into whichever page happened to be oldest.
     */
    ctx.shell.claimFocus(() => peek()?.focusNominated() ?? false)

    /**
     * Teardown. `before-quit` disposes the host, which disposes this fiber, which gets here.
     *
     * Every guard inside destroy() still matters: by now Electron may have destroyed the window
     * and its child views, and reaching through a destroyed wrapper throws "Object has been
     * destroyed" out of before-quit as an uncaught exception dialog.
     */
    ctx.effect(() => {
      return () => { tabs?.destroyAll() }
    }, 'native browser views')
  }
}

export default plugin
