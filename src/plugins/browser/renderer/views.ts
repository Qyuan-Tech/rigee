import { liveTabIds } from '@renderer/plugins/api'
import { invoke } from './rpc'
import type { ViewId } from '../protocol'
import type { TabId, ViewBounds } from '@shared/types'

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
 * awaiting `browser:create`, got null, and called `showOnly(tabId)` against an empty Map — so
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
}

export function destroyView(tabId: TabId): void {
  const viewId = viewByTab.get(tabId)
  if (!viewId) return
  viewByTab.delete(tabId)
  void invoke('browser:destroy', { viewId })
}

/** Hide every browser view except the one belonging to `tabId` (pass null to hide all). */
export function showOnly(tabId: TabId | null): void {
  const keep = tabId ? viewByTab.get(tabId) : undefined
  if (keep) {
    void invoke('browser:setVisible', { viewId: keep, visible: true })
  } else {
    // Hiding every browser view also hands keyboard focus back to the shell, which main does as
    // part of browser:setVisible(false).
    for (const viewId of viewByTab.values()) {
      void invoke('browser:setVisible', { viewId, visible: false })
    }
  }
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
