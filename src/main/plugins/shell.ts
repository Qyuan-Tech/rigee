import { Service, type Context } from 'cordis'
import type { BrowserWindow, WebContents } from 'electron'
import type { PluginEventEnvelope } from '@rigee/plugin-api/manifest'
import type { AskOptions, PluginShellService } from '@rigee/plugin-api/context'
import { currentLocale } from '@shared/l10n'
import { serveMedia } from '../media'

// `ctx.shell` is declared on Context by @rigee/plugin-api (context.ts), as the interface this class
// implements, and so is the question `ask` takes.
export type { AskOptions }

/**
 * What a main-side plugin is given of the shell: the window, a way to push to the renderer, and a
 * way to ask the user something.
 *
 * Nothing else. A plugin half in main is ordinary Node code in our own process — it can `import`
 * anything Electron exposes and does not need a facade for it. What it CANNOT get at without help
 * is the window this particular app created and the renderer's WebContents, because those are
 * created after `app.whenReady()` and owned by src/main/index.ts. The question is the one facade,
 * and it exists for the smoke modes: see `ask`.
 *
 * EVERY METHOD HERE MUST BE A PROTOTYPE METHOD, never an arrow-function field. cordis makes
 * `this.ctx` mean "the calling plugin's context" by swapping `thisArg` when the method is called
 * through the service proxy; an arrow function closes over `this` at construction and ignores the
 * swap, so `this.ctx.pluginId` would silently be the root's (undefined) and `emit` would throw for
 * every caller.
 *
 * PERFORMANCE, and the exact shape matters. Measured on cordis 4.0.0-rc.10, per call:
 *
 *   ctx.shell.emit(…)                   17,700 ns   rebuilds a shadow context on every read
 *   const s = ctx.shell; s.emit(…)       4,460 ns   still proxied on every call
 *   const emit = ctx.shell.emit           THROWS    "Cannot read properties of undefined (ctx)"
 *   const emit = s.emit.bind(s)             219 ns  <- do this
 *
 * The bare capture is the trap: cordis only substitutes the shadow when the receiver IS the proxy,
 * so a detached function reference has no `this` at all. Bind at activation for anything on a hot
 * path — `emit` fires on every filesystem change in every watched repo.
 */
export class ShellService extends Service implements PluginShellService {
  constructor(
    ctx: Context,
    private readonly deps: {
      window: () => BrowserWindow | null
      webContents: () => WebContents | null
      send: (payload: PluginEventEnvelope) => void
      ask: (options: AskOptions) => Promise<number>
      focusClaims: Set<() => boolean>
    }
  ) {
    super(ctx, 'shell')
  }

  /** Every URL served, and how to stop serving it early. Across plugins: the URLs are unique. */
  private readonly served = new Map<string, () => Promise<void>>()

  /** The app window, or null before it exists / after it is gone. */
  window(): BrowserWindow | null {
    return this.deps.window()
  }

  /** The shell's own WebContents — the React renderer, not a browser tab. */
  webContents(): WebContents | null {
    return this.deps.webContents()
  }

  /**
   * Push an event to this plugin's renderer half.
   *
   * The event name is plugin-local (`status`, not `scm:status`); the envelope carries the id, so
   * one plugin's events never reach another's listeners.
   */
  emit(event: string, payload: unknown): void {
    const pluginId = this.ctx.pluginId
    if (!pluginId) throw new Error(`shell.emit(${event}): called from a Context with no pluginId`)
    this.deps.send({ pluginId, event, payload })
  }

  /**
   * A URL the renderer can stream this file from — what a <video> or <audio> needs, and the image
   * viewer's whole-file read cannot give: Range requests, so playback starts at once and seeking
   * reads only what it plays. See src/main/media.ts.
   *
   * The URL names a token rather than the path, and works until `releaseFile` is called with it, or
   * the calling plugin is disposed — so a viewer that forgets still does not leave files exposed.
   */
  serveFile(path: string, mime: string): string {
    const { url, revoke } = serveMedia(path, mime)
    this.served.set(url, this.ctx.effect(() => revoke, 'served file'))
    return url
  }

  /**
   * Ask the user something in a native dialog over the window: the index of the button pressed.
   *
   * Through the shell rather than Electron's `dialog`, so that a smoke mode can answer it. A
   * question put on screen straight through `dialog` is one no script can dismiss, and the run sits
   * waiting for somebody to come and press a button.
   */
  ask(options: AskOptions): Promise<number> {
    return this.deps.ask(options)
  }

  /** The language the shell is in now, for what a main half says itself. */
  locale(): string {
    return currentLocale()
  }

  /** Stop serving a URL `serveFile` returned. Unknown or already released is not an error. */
  releaseFile(url: string): void {
    const release = this.served.get(url)
    this.served.delete(url)
    void release?.()
  }

  /**
   * Offer to take keyboard focus instead of the shell. Return true if you took it.
   *
   * For plugins that composite a native view over the window: a BrowserWindow gives focus to its
   * own webContents, never to a child WebContentsView, so a page the user is looking at receives
   * nothing they type unless someone says so. The shell asks after load, on window focus, and
   * whenever a view is shown or hidden.
   */
  claimFocus(handler: () => boolean): void {
    this.ctx.effect(() => {
      this.deps.focusClaims.add(handler)
      return () => { this.deps.focusClaims.delete(handler) }
    }, 'focus claim')
  }
}
