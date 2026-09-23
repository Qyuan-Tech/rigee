import { focusedTabId, liveTabIds, mountedTabIds, subscribeMountedTabs } from '@rigee/plugin-api'
import { invoke } from './rpc'
import type { ViewId } from '../protocol'
import type { TabId, ViewBounds } from '@rigee/plugin-api'

/**
 * Lifecycle for the native WebContentsView backing each browser tab.
 *
 * Views are deliberately NOT stored in the zustand store — they are native handles, created
 * lazily on first activation and destroyed only when their tab closes. Keeping them in a plain
 * module Map means switching tabs does not churn React state.
 *
 * The view id is deliberately NOT written into the tab's persisted state either, which is the one
 * thing that changed with the move. The old code wrote it back with `updateTab` and `sanitizeTabs`
 * then had to blank it on load, because a native view does not survive a restart: the id on disk
 * named a view in a process that no longer exists. This Map is the single source of truth, it is
 * rebuilt on first activation, and nothing outside this module ever needed the id.
 */

const viewByTab = new Map<TabId, ViewId>()

/**
 * Creations in flight, as PROMISES rather than a set of ids.
 *
 * A second caller has to be able to await the first one's result. It used to be a Set and the
 * second caller got `null`, which produced a blank pane every single time in development: React
 * StrictMode mounts, unmounts and remounts every effect, so run #2 asked while run #1 was still
 * awaiting `browser:create`, got null, and went on to show a tab with no view in the Map — so
 * nothing was ever made visible, while the page loaded invisibly behind the toolbar. Run #1 then
 * finished, stored the id, and returned to a cleanup that had already marked it cancelled.
 *
 * The old shell had the same hole and hid it by accident: its effect depended on `tab.url`, so the
 * first navigation re-ran it and showed the view a few hundred milliseconds late. This plugin
 * deliberately does not re-run on navigation (see BrowserPane), so the hole had to be closed
 * properly. It is the same in-flight-promise shape the plugin hosts use, for the same reason.
 */
const creating = new Map<TabId, Promise<ViewId | null>>()

export function viewIdFor(tabId: TabId): ViewId | undefined {
  return viewByTab.get(tabId)
}

/**
 * The tab a view belongs to. The reverse of `viewIdFor`, and a linear scan because the map is one
 * entry per open browser tab — a handful, walked only when a page opens a popup.
 *
 * Exists for `tabRequested`: a popup has to land in the group its OPENER is in, and main can only
 * name the opener by view id. Without this the tab is opened in the active group, so a `window.open`
 * from a page in the left column puts its popup in the right one, over whatever was there.
 */
export function tabIdFor(viewId: ViewId): TabId | undefined {
  for (const [tabId, id] of viewByTab) {
    if (id === viewId) return tabId
  }
  return undefined
}

export function ensureView(
  tabId: TabId,
  url: string,
  bounds: ViewBounds
): Promise<ViewId | null> {
  const existing = viewByTab.get(tabId)
  if (existing) return Promise.resolve(existing)
  const inFlight = creating.get(tabId)
  if (inFlight) return inFlight

  const pending = (async () => {
    const { viewId } = await invoke('browser:create', { tabId, url, bounds })
    // The tab may have been closed while we awaited; do not leak the view.
    if (!liveTabIds().has(tabId)) {
      void invoke('browser:destroy', { viewId })
      return null
    }
    viewByTab.set(tabId, viewId)
    // A view that has just come into existence is the one case the reconciler cannot see coming:
    // the store did not change, so nothing else will ask whether it belongs on screen.
    scheduleReconcile()
    return viewId
  })().finally(() => { creating.delete(tabId) })

  creating.set(tabId, pending)
  return pending
}

/**
 * Take ownership of a view main created on its own — a `window.open` guest it had to adopt.
 *
 * Electron hands the opener's `createWindow` callback a WebContents it has ALREADY made; refusing
 * it throws, so main registers the guest and tells us about it. Without this entry the tab that
 * gets opened for it would call `ensureView` and create a SECOND view, leaving the adopted one
 * composited over the window with nothing referencing it — invisible, unreachable, and alive until
 * the plugin is disposed.
 */
export function adoptView(tabId: TabId, viewId: ViewId): void {
  viewByTab.set(tabId, viewId)
  // The guest is the textbook orphan: main made it, and if its tab never gets a pane — the popup
  // opened into a group the user closed the same second, say — nothing else would ever hide it.
  scheduleReconcile()
}

export function destroyView(tabId: TabId): void {
  const viewId = viewByTab.get(tabId)
  if (!viewId) return
  viewByTab.delete(tabId)
  void invoke('browser:destroy', { viewId })
}

/**
 * Composite one tab's view over the rectangle its pane measured.
 *
 * One tab, never "this one and not the others". The predecessor here was `showOnly`, and with a row
 * of editor groups it is the bug: two panes mount, the second one's show hides the first, and the
 * first group is left with a white rectangle and nothing in any log.
 */
export function showView(tabId: TabId, bounds: ViewBounds): void {
  const viewId = viewByTab.get(tabId)
  if (viewId) void invoke('browser:show', { viewId, bounds })
}

/** Uncomposite one tab's view. The view outlives it; only the pane is going away. */
export function hideView(tabId: TabId): void {
  const viewId = viewByTab.get(tabId)
  if (viewId) void invoke('browser:hide', { viewId })
}

/** Ask for the keyboard. Only the active group's active tab may, and main refuses if hidden. */
export function focusView(tabId: TabId): void {
  const viewId = viewByTab.get(tabId)
  if (viewId) void invoke('browser:focus', { viewId })
}

/** Give the keyboard back to the shell, if this tab's page is the one that has it. */
export function releaseFocus(tabId: TabId): void {
  const viewId = viewByTab.get(tabId)
  if (viewId) void invoke('browser:releaseFocus', { viewId })
}

/**
 * Whether this tab is the one with the keyboard, asked from outside a render — after an await,
 * where a flag captured before it is stale.
 *
 * THE rule itself is the shell's (`focusedTabId`): the active group's active tab, and nothing
 * else. It used to be reimplemented here against the store, which meant two copies of it — and
 * two copies of a rule this small is how two visible pages end up disagreeing about which of them
 * should be typing.
 */
export function isFocusTargetNow(tabId: TabId): boolean {
  return focusedTabId() === tabId
}

/**
 * Reap views whose tabs are gone.
 *
 * Driven by `subscribeTabs`, which is outside React and so off the render path. `live` spans every
 * workspace, not just the active one — switching workspaces must not read as "every tab closed"
 * and destroy the pages the user left in the other one.
 */
export function reap(live: Set<TabId>): void {
  for (const tabId of [...viewByTab.keys()]) {
    if (!live.has(tabId)) destroyView(tabId)
  }
}

// ---------------------------------------------------------------------------
// The reconciler
// ---------------------------------------------------------------------------

/**
 * Long enough to lose, on purpose.
 *
 * A store write is synchronous, so this fires before React has even rendered the row it describes.
 * Running it immediately would let it show a moved view at its previous group's rectangle for the
 * frame before the pane's own `show` corrects it — the flash that `browser:show` carries bounds to
 * avoid. It is a safety net, not a participant: it must arrive after the panes have had their say.
 */
const RECONCILE_DELAY_MS = 50

let reconcileTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Which views main should be compositing: of the tabs currently mounted, the ones that are ours.
 *
 * `mountedTabIds` is the shell's answer to "what is on screen" — the active tab of every group of
 * the ACTIVE workspace. Only the active workspace, because only its row is rendered: the pages of
 * the workspace you switched away from are still alive, and leaving them composited is the failure
 * the scratch smoke test watches for, where a native view over the whole window makes switching
 * workspaces look like nothing happened at all.
 */
function compositedViewIds(): ViewId[] {
  const out: ViewId[] = []
  for (const tabId of mountedTabIds()) {
    const viewId = viewByTab.get(tabId)
    if (viewId) out.push(viewId)
  }
  return out
}

/**
 * Tell main the whole truth, coalescing a burst of store writes into one message.
 *
 * Deliberately NOT gated on "did the set change since last time": the states worth repairing are
 * the ones where main drifted while the renderer's answer stayed exactly the same, and a gate would
 * skip precisely those.
 */
function scheduleReconcile(): void {
  if (reconcileTimer !== null) return
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null
    void invoke('browser:syncVisible', { viewIds: compositedViewIds() })
  }, RECONCILE_DELAY_MS)
}

/**
 * Watch for changes that move a page on or off screen.
 *
 * `subscribeMountedTabs` fires only when the mounted set actually differs, so a title change, a
 * resize or a keystroke costs one comparison and nothing more. Wrap the returned undo in
 * `ctx.effect` so it dies with the plugin, like `reap` does.
 */
export function subscribeVisibleViews(): () => void {
  const unsubscribe = subscribeMountedTabs(scheduleReconcile)
  return () => {
    if (reconcileTimer !== null) clearTimeout(reconcileTimer)
    reconcileTimer = null
    unsubscribe()
  }
}
