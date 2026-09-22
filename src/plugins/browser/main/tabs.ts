import { WebContentsView, type BaseWindow, type WebContents } from 'electron'
import type { EmitBrowserEvent } from '../protocol'
import type { ViewBounds } from '@shared/types'

/**
 * Manager for the in-app Chromium browser tabs.
 *
 * Each tab is a WebContentsView layered over the React shell. The view is a native overlay and
 * does NOT participate in DOM layout, so the renderer positions an empty placeholder div and
 * pushes its measured rect down here via 'browser:setBounds'.
 *
 * All browser views share one persistent session partition so logins survive restarts.
 *
 * Unchanged by the move into a plugin except for where events go: `emit` is the plugin's BOUND
 * `ctx.shell.emit`, handed in at activation rather than read off the context per event. Every
 * navigation of every tab pushes one, and measured per call that is 17.7 us through the context
 * against 0.22 us bound — and an unbound capture does not merely cost more, it throws.
 */

const PARTITION = 'persist:onestop-browser'

interface Entry {
  id: string
  view: WebContentsView
  bounds: ViewBounds
  visible: boolean
}

/**
 * `createWindow` hands us the guest WebContents on an undeclared `webContents` field of the
 * options object. BrowserWindowConstructorOptions does not declare it, hence the cast.
 */
type CreateWindowOptions = Electron.BrowserWindowConstructorOptions & {
  webContents?: WebContents
}

export class BrowserTabs {
  private readonly views = new Map<string, Entry>()
  private seq = 0

  constructor(
    private readonly window: BaseWindow,
    /** Where 'state', 'tabRequested' and 'error' go: the plugin's renderer half. */
    private readonly emit: EmitBrowserEvent
  ) {}

  create(url: string, bounds: ViewBounds): string {
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        // Hidden tabs must keep loading and running timers, otherwise switching back shows a
        // frozen page that only catches up seconds later.
        backgroundThrottling: false
      }
    })
    return this.register(view, bounds, url)
  }

  private register(view: WebContentsView, bounds: ViewBounds, url: string | null): string {
    const id = `view${++this.seq}`
    this.window.contentView.addChildView(view)
    view.setBounds(bounds)
    view.setVisible(false)

    const entry: Entry = { id, view, bounds, visible: false }
    this.views.set(id, entry)

    this.wire(entry)
    if (url !== null) void view.webContents.loadURL(url).catch(() => { /* surfaced by did-fail-load */ })
    return id
  }

  private wire(entry: Entry): void {
    const wc = entry.view.webContents
    const push = (): void => {
      this.emit('state', {
        viewId: entry.id,
        url: wc.getURL(),
        title: wc.getTitle(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        loading: wc.isLoading(),
        faviconDataUrl: null
      })
    }

    wc.on('page-title-updated', push)
    wc.on('did-start-loading', push)
    wc.on('did-stop-loading', push)
    wc.on('did-navigate', push)
    wc.on('did-navigate-in-page', push)
    wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
      if (!isMainFrame) return
      // This was `app:error` on the shell's channel, where nothing has ever listened to it. As a
      // plugin event it reaches the pane that owns the view, which is the only surface that can
      // say which tab failed — and the plugin no longer has to reach into the shell's IPC.
      this.emit('error', {
        viewId: entry.id,
        message: `${desc} (${code}) while loading ${failedUrl}`
      })
      push()
    })

    /**
     * window.open / target=_blank.
     *
     * Verified on Electron 44.4.1: we MUST adopt the guest WebContents that Electron already
     * created and passes on `options.webContents`. Constructing a fresh WebContentsView here and
     * returning its webContents throws
     *   "Invalid webContents. Created window should be connected to webContents passed with
     *    options object."
     * regardless of which webPreferences are supplied (verified across 8 combinations, including
     * no options at all). Adoption is also what preserves window.opener, which popup-based OAuth
     * flows depend on.
     */
    wc.setWindowOpenHandler((details) => ({
      action: 'allow',
      outlivesOpener: true,
      createWindow: (options: CreateWindowOptions) => {
        const guest = options.webContents
        if (!guest) {
          // Should not happen on Electron 44; fall back to a plain new tab on the same URL.
          const id = this.create(details.url, entry.bounds)
          const created = this.views.get(id)
          this.emit('tabRequested', {
            viewId: id,
            url: details.url,
            openerViewId: entry.id
          })
          return created!.view.webContents
        }
        // Do NOT pass webPreferences alongside webContents: the guest already carries the
        // preferences Electron derived from its opener.
        const view = new WebContentsView({ webContents: guest })
        const id = this.register(view, entry.bounds, null)
        this.emit('tabRequested', {
          viewId: id,
          url: details.url,
          openerViewId: entry.id
        })
        return guest
      }
    }))
  }

  setBounds(id: string, bounds: ViewBounds): void {
    const entry = this.views.get(id)
    if (!entry) return
    entry.bounds = bounds
    entry.view.setBounds(bounds)
  }

  setVisible(id: string, visible: boolean): void {
    const entry = this.views.get(id)
    if (!entry) return
    entry.visible = visible
    entry.view.setVisible(visible)
    if (visible) {
      // Raise above its siblings; addChildView on an existing child re-appends it.
      this.window.contentView.addChildView(entry.view)
      // And take keyboard focus, or typing in the page would go to the shell behind it.
      entry.view.webContents.focus()
    }
  }

  /** Focus the visible browser view, if any. Returns whether one took focus. */
  focusVisible(): boolean {
    for (const entry of this.views.values()) {
      if (entry.visible && !entry.view.webContents.isDestroyed()) {
        entry.view.webContents.focus()
        return true
      }
    }
    return false
  }

  /** Hide every view except `keepId`. Used on tab switch and when a non-browser tab activates. */
  showOnly(keepId: string | null): void {
    for (const [id, entry] of this.views) {
      const visible = id === keepId
      if (entry.visible !== visible) this.setVisible(id, visible)
    }
  }

  navigate(id: string, url: string): void {
    void this.views.get(id)?.view.webContents.loadURL(url).catch(() => { /* did-fail-load */ })
  }

  goBack(id: string): void { this.views.get(id)?.view.webContents.navigationHistory.goBack() }
  goForward(id: string): void { this.views.get(id)?.view.webContents.navigationHistory.goForward() }
  reload(id: string): void { this.views.get(id)?.view.webContents.reload() }
  stop(id: string): void { this.views.get(id)?.view.webContents.stop() }
  openDevTools(id: string): void {
    this.views.get(id)?.view.webContents.openDevTools({ mode: 'detach' })
  }

  /**
   * Tear one view down.
   *
   * Every step is guarded, because this also runs on the way out and by then Electron may have
   * destroyed the window and, with it, every child view. Reaching through a destroyed wrapper
   * throws *"Object has been destroyed"*, and thrown from `before-quit` that is an uncaught
   * exception dialog on an app that was quitting perfectly happily.
   *
   * The way in is ordinary: close the window on macOS, where the app stays running, then quit.
   * The views died with the window but this map still has entries for them.
   */
  destroy(id: string): void {
    const entry = this.views.get(id)
    if (!entry) return
    this.views.delete(id)
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(entry.view)
    const wc = entry.view.webContents
    if (!wc || wc.isDestroyed()) return
    wc.removeAllListeners()
    wc.close()
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) this.destroy(id)
  }

  /** Which views are currently composited over the shell. For diagnostics and the smoke tests. */
  visibleIds(): string[] {
    return [...this.views.values()].filter((e) => e.visible).map((e) => e.id)
  }

  /** Resolve a view id from a WebContents, for routing app-level events like 'login'. */
  idFor(wc: WebContents): string | null {
    for (const [id, entry] of this.views) {
      if (entry.view.webContents === wc) return id
    }
    return null
  }

  /** The window these views hang off, so the host can tell a stale manager from a live one. */
  ownerWindow(): BaseWindow {
    return this.window
  }
}
