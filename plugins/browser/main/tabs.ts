import { WebContentsView, type BaseWindow, type WebContents } from 'electron'
import { translatorFor } from './l10n'
import type { EmitBrowserEvent } from '../protocol'
import type { ViewBounds } from '@rigee/plugin-api/data'
import type { Locale } from '@rigee/plugin-api/l10n'

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

const PARTITION = 'persist:rigee-browser'

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

  /**
   * The view the renderer last nominated to hold the keyboard — the active group's active tab.
   *
   * Tracked because the window-focus claim has to answer "which page should be typing into?" with
   * no renderer on the call stack. Before groups, "the visible one" was that answer; with two
   * pages on screen it is a coin flip, and the loser silently eats every keystroke.
   */
  private nominated: string | null = null

  constructor(
    private readonly window: BaseWindow,
    /** Where 'state', 'tabRequested' and 'error' go: the plugin's renderer half. */
    private readonly emit: EmitBrowserEvent,
    /**
     * The language the shell is in: the plugin's bound `ctx.shell.locale`. Asked each time a
     * failure is put into words, not once here — the user can switch while the tab is open.
     */
    private readonly locale: () => Locale
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

    // A click into the page gives it the keyboard without the shell's DOM seeing anything, so the
    // shell would go on believing the user is in whichever column they last clicked in the DOM —
    // and Cmd+W, forwarded from this page, would close something in THAT column.
    wc.on('focus', () => this.emit('focused', { viewId: entry.id }))
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
      // Chromium's description and the URL go in as they come; only the sentence around them is
      // ours, and said in the language the shell is in now.
      const { t } = translatorFor(this.locale())
      this.emit('error', {
        viewId: entry.id,
        message: t('{desc} ({code}) while loading {url}', { desc, code, url: failedUrl })
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

  /**
   * Composite one view over the shell, at the rectangle its pane just measured.
   *
   * Bounds first, then visible, then raise: setting them in the other order shows the view for one
   * composite at wherever it was last, which for a tab dragged into the group next door is the
   * column it came from.
   *
   * Deliberately no focus here. Two panes can mount in one React commit and the later `show` would
   * take the keyboard off the earlier one — which is the group the user is actually in exactly half
   * the time. Focus is `focus()`, said out loud by the one pane entitled to ask.
   */
  show(id: string, bounds: ViewBounds): void {
    const entry = this.views.get(id)
    if (!entry) return
    entry.bounds = bounds
    entry.view.setBounds(bounds)
    entry.visible = true
    entry.view.setVisible(true)
    // Raise above its siblings; addChildView on an existing child re-appends it.
    this.window.contentView.addChildView(entry.view)
  }

  /**
   * Stop compositing one view. It stays alive, loaded and running.
   *
   * No focus side effect, and that is the whole point of splitting the old boolean: hiding the page
   * in one group used to hand the keyboard to the shell, which with two groups means closing a tab
   * on the left yanks the cursor out of the page you are reading on the right.
   */
  hide(id: string): void {
    const entry = this.views.get(id)
    if (!entry) return
    entry.visible = false
    entry.view.setVisible(false)
  }

  /**
   * Give one view the keyboard and remember it as the one that has it.
   *
   * Refused while the view is hidden. A pane asks as soon as its group becomes active, which can
   * land before its own `show` when the view is still being created — and a hidden page with focus
   * swallows everything typed with nothing on screen to explain where it went.
   */
  focus(id: string): void {
    const entry = this.views.get(id)
    if (!entry || !entry.visible || entry.view.webContents.isDestroyed()) return
    this.nominated = id
    entry.view.webContents.focus()
  }

  /**
   * Let go of the keyboard, if this view is the one holding it. Answers whether it was.
   *
   * The caller hands focus back to the shell on a true; on a false another group's page has already
   * claimed it and must be left alone.
   */
  releaseFocus(id: string): boolean {
    if (this.nominated !== id) return false
    this.nominated = null
    return true
  }

  /**
   * Focus whichever view the renderer nominated. Returns whether one took focus.
   *
   * This is the shell's `claimFocus`, i.e. what happens when the window itself is focused. It used
   * to focus the first VISIBLE view, which with a row of groups means the oldest one — the page in
   * a column the user may not have looked at since. A nomination that has since been hidden is no
   * answer either, so the claim declines and the shell keeps the keyboard.
   */
  focusNominated(): boolean {
    const entry = this.nominated === null ? undefined : this.views.get(this.nominated)
    if (!entry || !entry.visible || entry.view.webContents.isDestroyed()) return false
    entry.view.webContents.focus()
    return true
  }

  /**
   * Make the composited set exactly `ids`, showing and hiding to get there.
   *
   * The reconciler that `showOnly` used to be by accident. Only the renderer knows which panes are
   * mounted, and only this can repair a view that is composited with no pane behind it — a
   * `window.open` guest adopted before its tab existed, or a mount whose cleanup ran before its own
   * creation resolved. A view it has to show goes back at its last known bounds, which is where its
   * pane last was.
   */
  syncVisible(ids: readonly string[]): void {
    const wanted = new Set(ids)
    for (const [id, entry] of this.views) {
      const visible = wanted.has(id)
      if (entry.visible === visible) continue
      if (visible) this.show(id, entry.bounds)
      else this.hide(id)
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
    // A nomination naming a view that no longer exists would make the window-focus claim reach
    // through a destroyed WebContents, which throws rather than declining.
    if (this.nominated === id) this.nominated = null
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(entry.view)
    const wc = entry.view.webContents
    if (!wc || wc.isDestroyed()) return
    wc.removeAllListeners()
    wc.close()
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) this.destroy(id)
  }

  /**
   * Which views are currently composited over the shell. For diagnostics and the smoke tests.
   *
   * Plural since editor groups: one per group whose active tab is a browser tab. Creation order,
   * not z-order — it answers what is on screen, not what is on top.
   */
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
