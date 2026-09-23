import type { ViewBounds } from '@shared/types'

/**
 * What the browser plugin's two halves say to each other.
 *
 * Realm-free on purpose: no electron, no DOM, no React, so it compiles into both tsconfigs. That
 * is the only reason a payload shape can be wrong in exactly one half and still be a compile
 * error rather than an `undefined` that surfaces three navigations later.
 *
 * The command payloads are the ones the eleven `browser:*` IPC channels carried before the shell
 * handed them over, except for the one the centre pane's editor groups broke: `setVisible` has
 * become `show`/`hide`/`focus`/`releaseFocus`/`syncVisible`, for the reasons on each. The events
 * are the same three pushes with the `browser:` prefix dropped — `plugin:event` envelopes carry
 * the plugin id already.
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

/**
 * Show one view, at the rectangle it is to occupy.
 *
 * The bounds ride along rather than arriving in a separate `browser:setBounds` because a view
 * re-mounted into another group would otherwise be composited at its OLD group's rectangle for the
 * frame between the two messages — a page flashing across the column next door.
 */
export interface ShowArgs extends ViewArgs {
  bounds: ViewBounds
}

/**
 * The views that must be composited, as a whole.
 *
 * Everything not named here is hidden, which is what makes this a reconciler rather than a bulk
 * show: see `browser:syncVisible` for the invariant it repairs.
 */
export interface SyncVisibleArgs {
  viewIds: ViewId[]
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
  /**
   * Composite THIS view, and only this one. Nothing else moves.
   *
   * Replaces `browser:setVisible`, whose boolean fused three separate questions — what is on
   * screen, what is on top, and what has the keyboard — and answered all three with "this one, and
   * nobody else". With a row of editor groups two browser tabs are legitimately on screen at once,
   * so the old `true` branch (`showOnly`) made the second pane to mount blank the first: a white
   * rectangle and no error anywhere. Renaming rather than redefining is deliberate; a boolean that
   * quietly stopped meaning what it used to is how the same regression ships twice.
   */
  'browser:show': (args: ShowArgs) => void
  /** Uncomposite THIS view. No focus side effect: hiding one group must not disturb another. */
  'browser:hide': (args: ViewArgs) => void
  /**
   * Give this view the keyboard, and remember it as the one that has it.
   *
   * Separate from `browser:show` because the two have different owners: every mounted pane is
   * visible, but only the active group's active tab may take the keyboard. Fused, two panes
   * mounting in one React commit would settle it by whichever IPC arrived last.
   */
  'browser:focus': (args: ViewArgs) => void
  /**
   * Hand the keyboard back to the shell, but ONLY if this view is the one holding it.
   *
   * Conditional on purpose. Leaving a group and entering another happens in a single commit, and
   * the two panes' effects run in DOM order, not in the order the user's attention moved — so an
   * unconditional release would, half the time, run after the new group's claim and leave the
   * keyboard on the shell instead of on the page the user just clicked into.
   */
  'browser:releaseFocus': (args: ViewArgs) => void
  /**
   * Make the composited set exactly `viewIds`. The generalisation of the old `showOnly`.
   *
   * Not redundant with per-view show/hide: `showOnly` was silently maintaining an invariant the
   * per-view calls cannot — "exactly the views whose panes are mounted are composited" — and a view
   * can end up visible with no pane behind it. An adopted `window.open` guest whose tab never got
   * a pane, or a StrictMode double-mount whose cleanup lost the race against its own creation, both
   * leave a page nailed over the shell that nothing will ever hide.
   */
  'browser:syncVisible': (args: SyncVisibleArgs) => void
  'browser:setBounds': (args: SetBoundsArgs) => void
  'browser:navigate': (args: NavigateArgs) => void
  'browser:goBack': (args: ViewArgs) => void
  'browser:goForward': (args: ViewArgs) => void
  'browser:reload': (args: ViewArgs) => void
  'browser:stop': (args: ViewArgs) => void
  'browser:openDevTools': (args: ViewArgs) => void
  'browser:authResponse': (args: AuthResponseArgs) => void
  /**
   * Which views are actually composited over the window, in creation order.
   *
   * A command rather than a diagnostic method because only main can see it, and the scratch smoke
   * test — "switching workspaces must not leave another workspace's page on screen" — needs the
   * answer from outside the plugin.
   *
   * SEVERAL may be composited now, one per editor group, so this is a set and not "the visible
   * one". It says what is on screen, not what is on top of what: raising reorders main's child
   * views, not this list. The assertions worth making on it are about membership — an id that is
   * still here after its workspace was left, or the empty list the scratch smoke test wants.
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
