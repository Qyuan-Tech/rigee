import { rpc } from './ipc'
import { useApp } from './store'
import type { ViewBounds } from '@shared/types'

/**
 * Lifecycle for the native WebContentsView backing each browser tab.
 *
 * Views are deliberately NOT stored in the zustand store — they are native handles, created
 * lazily on first activation and destroyed only when their tab closes. Keeping them in a plain
 * module Map means switching tabs does not churn React state.
 */

const viewByTab = new Map<string, string>()
const creating = new Set<string>()

export function viewIdFor(tabId: string): string | undefined {
  return viewByTab.get(tabId)
}

export async function ensureView(tabId: string, url: string, bounds: ViewBounds): Promise<string | null> {
  const existing = viewByTab.get(tabId)
  if (existing) return existing
  if (creating.has(tabId)) return null // a concurrent call is already in flight
  creating.add(tabId)
  try {
    const { viewId } = await rpc['browser:create']({ tabId, url, bounds })
    // The tab may have been closed while we awaited; do not leak the view.
    if (!tabStillOpen(tabId)) {
      void rpc['browser:destroy']({ viewId })
      return null
    }
    viewByTab.set(tabId, viewId)
    useApp.getState().updateTab(currentWorkspaceId()!, tabId, { viewId })
    return viewId
  } finally {
    creating.delete(tabId)
  }
}

export function destroyView(tabId: string): void {
  const viewId = viewByTab.get(tabId)
  if (!viewId) return
  viewByTab.delete(tabId)
  void rpc['browser:destroy']({ viewId })
}

/** Hide every browser view except the one belonging to `tabId` (pass null to hide all). */
export function showOnly(tabId: string | null): void {
  const keep = tabId ? viewByTab.get(tabId) : undefined
  if (keep) {
    void rpc['browser:setVisible']({ viewId: keep, visible: true })
  } else {
    for (const viewId of viewByTab.values()) {
      void rpc['browser:setVisible']({ viewId, visible: false })
    }
  }
}

function currentWorkspaceId(): string | null {
  return useApp.getState().activeWorkspaceId
}

function tabStillOpen(tabId: string): boolean {
  const s = useApp.getState()
  if (!s.activeWorkspaceId) return false
  return (s.tabsByWorkspace[s.activeWorkspaceId] ?? []).some((t) => t.id === tabId)
}

/**
 * Reap views whose tabs are gone. Subscribing outside React keeps this off the render path.
 */
useApp.subscribe(
  (s) => s.tabsByWorkspace,
  (tabsByWorkspace) => {
    const live = new Set<string>()
    for (const tabs of Object.values(tabsByWorkspace)) {
      for (const t of tabs) live.add(t.id)
    }
    for (const tabId of [...viewByTab.keys()]) {
      if (!live.has(tabId)) destroyView(tabId)
    }
  }
)
