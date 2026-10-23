/**
 * The services a plugin's halves are given on `ctx`, as a plugin sees them.
 *
 * The shell implements each one as a cordis Service, and used to declare them on `Context` from its
 * own source — which only a plugin compiled INSIDE this repository could see. A plugin from another
 * repository wrote `ctx.contributions.editor(…)` against a Context that, as far as its compiler
 * knew, had no such property. So the shapes live here, with the augmentation, and the shell's
 * classes implement them: one declaration, and a plugin anywhere types against it.
 *
 * Types only — this module emits nothing. It is reached through the root entry, which a renderer
 * half imports anyway, and on its own as `@rigee/plugin-api/context`: a plugin with only a main
 * half gets the typings with `import type {} from '@rigee/plugin-api/context'`, which costs
 * nothing at runtime and keeps React out of a process that cannot render.
 *
 * Each service has to be named in a half's `inject` before it can be read — `inject: ['commands']`
 * — or cordis throws, and a half whose injection cannot be met never runs at all.
 *
 * BIND A METHOD BEFORE PASSING IT AROUND: `const shell = ctx.shell; const emit = shell.emit.bind(shell)`.
 * cordis tells the shell WHICH plugin is calling by swapping `this` when a method is called on the
 * service itself, so a bare `const emit = ctx.shell.emit` arrives with no `this` and throws. Bound,
 * it is also some eighty times cheaper per call than going through `ctx` each time.
 */

import type { Context } from 'cordis'
import type { BrowserWindow, WebContents } from 'electron'
import type { Locale } from './l10n'
import type { PluginId, ViewType } from './manifest'
import type {
  PluginEditorComponent,
  PluginOverlayComponent,
  PluginStatusItemComponent,
  PluginTabComponent,
  PluginTabFactory,
  PluginViewComponent
} from './ui'

// ---------------------------------------------------------------------------
// The renderer half
// ---------------------------------------------------------------------------

/**
 * `ctx.contributions`: the components a manifest promised.
 *
 * Every id must be one the manifest declares, under the plugin's own prefix — `pdf.preview` for
 * the plugin `pdf` — or the bind throws. Each bind is revoked with the plugin, so a tab showing a
 * component of a plugin that was switched off falls back to the shell's notice.
 */
export interface PluginContributionsService {
  /** A viewer for the files an `editors` contribution claims. */
  editor(viewType: ViewType, component: PluginEditorComponent): void
  /** A tab type the plugin owns outright. */
  tab(viewType: ViewType, component: PluginTabComponent): void
  /** What a fresh tab of a `creatable` tab type starts as. */
  tabFactory(viewType: ViewType, factory: PluginTabFactory): void
  /** A side-bar panel. */
  view(id: ViewType, component: PluginViewComponent): void
  statusItem(id: ViewType, component: PluginStatusItemComponent): void
  /** Mounted at the shell's root while the plugin is active. */
  overlay(id: ViewType, component: PluginOverlayComponent): void
}

/**
 * `ctx.rpc`: the renderer half's line to its own main half, and nobody else's. A command or event
 * name without the plugin's own prefix — `pdf:read` for `pdf` — throws locally.
 */
export interface PluginRpcService {
  /** Call one of this plugin's main-half commands. Rejects with whatever the handler threw. */
  invoke<T = unknown>(command: string, payload?: unknown): Promise<T>
  /** Listen for one of this plugin's own events — `status`, not `scm:status`. Revoked with the plugin. */
  on<T = unknown>(event: string, listener: (payload: T) => void): void
}

// ---------------------------------------------------------------------------
// The main half
// ---------------------------------------------------------------------------

/** `ctx.commands`: what the renderer half can call. */
export interface PluginCommandsService {
  /**
   * Answer `name`, which must carry the plugin's own prefix: `pdf:read`. What the handler returns
   * — or the promise it returns resolves to — is what the renderer's `invoke` resolves to, so it
   * must survive structured cloning: no functions, no class instances. Revoked with the plugin.
   */
  register(name: string, handler: (payload: unknown) => unknown): void
}

/** A question for `ctx.shell.ask`: Electron's message box, cut down to what a question needs. */
export interface AskOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  message: string
  detail?: string
  buttons?: string[]
  /** The button Return presses. */
  defaultId?: number
  /** The button Escape presses, and the answer when the dialog is dismissed. */
  cancelId?: number
}

/** `ctx.shell`: what a main half is given of the shell — the window, the renderer, and the user. */
export interface PluginShellService {
  /** The app window, or null before it exists and after it is gone. */
  window(): BrowserWindow | null
  /** The shell's own WebContents: the React renderer, not a browser tab. */
  webContents(): WebContents | null
  /** Push an event to this plugin's renderer half. Plugin-local name: `status`, not `scm:status`. */
  emit(event: string, payload: unknown): void
  /**
   * A URL the renderer can stream this file from, Range requests and all — what a <video> needs.
   * It names a token, not the path, and works until `releaseFile` or until the plugin is disposed.
   */
  serveFile(path: string, mime: string): string
  /** Stop serving a URL `serveFile` returned. Unknown or already released is not an error. */
  releaseFile(url: string): void
  /**
   * Ask the user something in a native dialog over the window: the index of the button pressed.
   * Through the shell rather than Electron's `dialog`, so that Rigee's own tests can answer it.
   */
  ask(options: AskOptions): Promise<number>
  /**
   * The language the shell is in — `en`, `zh-CN` — for what a main half says itself: a question,
   * an error. It can change while the plugin runs, so ask each time rather than once. Since Rigee
   * 1.1.1.
   */
  locale(): Locale
  /**
   * Offer to take keyboard focus instead of the shell — return true if you took it. For a plugin
   * that composites a native view over the window, which the window never focuses by itself.
   */
  claimFocus(handler: () => boolean): void
}

/**
 * The Context both halves receive, with the services above declared on it.
 *
 * Also what keeps `cordis` imported in the published declarations: the augmentation below merges
 * into cordis's own `Context` only when this file imports the module, and a type import that
 * nothing used would be dropped from the emitted .d.ts — leaving a declaration that shadows cordis's
 * Context instead of extending it.
 */
export type PluginContext = Context

declare module 'cordis' {
  interface Context {
    /** Renderer half. */
    contributions: PluginContributionsService
    /** Renderer half. */
    rpc: PluginRpcService
    /** Main half. */
    commands: PluginCommandsService
    /** Main half. */
    shell: PluginShellService
    /**
     * Which plugin this Context belongs to, set by the host on each plugin's own Context.
     *
     * The `?` is a TypeScript fiction over a Proxy that THROWS on an unknown property read; both
     * hosts install an accessor answering undefined on the root, so reading it is always safe.
     */
    pluginId?: PluginId
  }
}
