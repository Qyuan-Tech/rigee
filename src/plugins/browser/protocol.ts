import type { ViewBounds } from '@shared/types'

/**
 * What the browser plugin's two halves say to each other.
 *
 * Realm-free on purpose: no electron, no DOM, no React, so it compiles into both tsconfigs. That
 * is the only reason a payload shape can be wrong in exactly one half and still be a compile
 * error rather than an `undefined` that surfaces three navigations later.
 *
 * The command payloads are the ones the eleven `browser:*` IPC channels carried before the shell
 * handed them over, unchanged. The events are the same three pushes with the `browser:` prefix
 * dropped — `plugin:event` envelopes carry the plugin id already.
 */

/** Minted by the main half. Opaque to the renderer, which stores and echoes it, never parses it. */
export type ViewId = string

// ---------------------------------------------------------------------------
// Commands (renderer → main)
// ---------------------------------------------------------------------------

export interface CreateArgs {
  /**
   * The tab the view will belong to.
   *
   * Main does not use it — the renderer owns the tab→view map — but it stays on the wire
   * because it is the only thing that makes a stray `browser:create` legible in a log.
   */
  tabId: string
  url: string
  bounds: ViewBounds
}

export interface CreateResult {
  viewId: ViewId
}

export interface ViewArgs {
  viewId: ViewId
}

/** Only one browser view is visible at a time; the rest stay alive but hidden. */
export interface SetVisibleArgs extends ViewArgs {
  visible: boolean
}

export interface SetBoundsArgs extends ViewArgs {
  bounds: ViewBounds
}

export interface NavigateArgs extends ViewArgs {
  url: string
}

/**
 * Answer an HTTP 401/407. `username: null` cancels the request, which is what closing the dialog
 * must do — leaving it unanswered would hang the page forever.
 */
export interface AuthResponseArgs {
  requestId: string
  username: string | null
  password: string
}

/**
 * Every command the main half answers, name to payload and result.
 *
 * The one thing the twenty-two typed IPC channels had that a single `plugin:invoke` does not is a
 * compiler that knows what each command takes and returns. This map hands it back, plugin-locally:
 * a renamed command or a payload that gained a field fails the build in both halves instead of
 * rejecting at click time. Source control's protocol has the same shape, deliberately — two
 * plugins should not invent two idioms for the same problem.
 */
export interface BrowserCommands {
  'browser:create': (args: CreateArgs) => CreateResult
  'browser:destroy': (args: ViewArgs) => void
  'browser:setVisible': (args: SetVisibleArgs) => void
  'browser:setBounds': (args: SetBoundsArgs) => void
  'browser:navigate': (args: NavigateArgs) => void
  'browser:goBack': (args: ViewArgs) => void
  'browser:goForward': (args: ViewArgs) => void
  'browser:reload': (args: ViewArgs) => void
  'browser:stop': (args: ViewArgs) => void
  'browser:openDevTools': (args: ViewArgs) => void
  'browser:authResponse': (args: AuthResponseArgs) => void
  /**
   * Which views are actually composited over the window.
   *
   * A command rather than a diagnostic method because only main can see it, and the scratch smoke
   * test — "switching workspaces must not leave another workspace's page on screen" — needs the
   * answer from outside the plugin.
   */
  'browser:visibleIds': (args: Record<string, never>) => ViewId[]
}

export type BrowserCommand = keyof BrowserCommands
export type BrowserArgs<K extends BrowserCommand> = Parameters<BrowserCommands[K]>[0]
export type BrowserResult<K extends BrowserCommand> = Awaited<ReturnType<BrowserCommands[K]>>

/** One typed call. What both halves use instead of `invoke('browser:create', …)`. */
export type BrowserCall = <K extends BrowserCommand>(
  command: K,
  args: BrowserArgs<K>
) => Promise<BrowserResult<K>>

/** Wrap the host's untyped `invoke` in the command map. */
export function browserClient(
  invoke: (command: string, args: unknown) => Promise<unknown>
): BrowserCall {
  return (command, args) => invoke(command, args) as never
}

/**
 * Every handler the main half must provide, derived from the command map.
 *
 * A mapped type rather than a hand-written list, so adding a command fails the build in main until
 * it is answered — the alternative failure mode is a command the renderer can name and nothing
 * implements, which surfaces only as a rejected promise in a click handler.
 */
export type BrowserHandlers = {
  [K in BrowserCommand]: (args: BrowserArgs<K>) => BrowserResult<K> | Promise<BrowserResult<K>>
}

/** Register every handler with the host's command service, iterating the object, not a list. */
export function registerBrowserCommands(
  register: (name: string, handler: (payload: unknown) => unknown) => void,
  handlers: BrowserHandlers
): void {
  for (const [name, handler] of Object.entries(handlers)) {
    register(name, (payload) => (handler as (args: unknown) => unknown)(payload))
  }
}

// ---------------------------------------------------------------------------
// Events (main → renderer)
// ---------------------------------------------------------------------------

export interface StateEvent {
  viewId: ViewId
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  faviconDataUrl: string | null
}

/** A page called window.open and we adopted the guest; the renderer must register a new tab. */
export interface TabRequestedEvent {
  viewId: ViewId
  url: string
  openerViewId: ViewId
}

/** HTTP 401/407. The renderer shows a prompt and answers with `browser:authResponse`. */
export interface AuthRequestedEvent {
  viewId: ViewId
  requestId: string
  host: string
  realm: string
  isProxy: boolean
  url: string
}

/**
 * A main-frame load that failed.
 *
 * This used to be the shell's `app:error`, which nothing in the renderer has ever listened to —
 * so the message was constructed, sent and dropped. It is a plugin event now and the pane that
 * owns the view renders it, which is both a shorter path and the only one that can say *which*
 * tab failed.
 */
export interface LoadErrorEvent {
  viewId: ViewId
  message: string
}

export interface BrowserEvents {
  state: StateEvent
  tabRequested: TabRequestedEvent
  authRequested: AuthRequestedEvent
  error: LoadErrorEvent
}

/**
 * The shape of the main half's captured `ctx.shell.emit`.
 *
 * Narrower than the service's own signature, so an event name or payload that does not exist in
 * `BrowserEvents` fails to compile instead of arriving at a listener nobody wrote.
 */
export type EmitBrowserEvent = <K extends keyof BrowserEvents>(
  event: K,
  payload: BrowserEvents[K]
) => void
