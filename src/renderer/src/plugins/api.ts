import { SCRATCH_WORKSPACE_ID } from '@shared/types'
import type { PluginId, ViewType } from '@shared/plugin'
import type { CustomTab, TabId, Workspace, WorkspaceFolder, WorkspaceId } from '@shared/types'
import { rpc } from '../ipc'
import { nextTabId, nextWorkspaceId, useApp } from '../store'
import { ownerOf } from './registry'

/**
 * The shell, as a plugin's renderer half sees it.
 *
 * Cordis-free by design. A plugin uses `ctx` for the things that must be revoked when it is
 * disposed — binding components, subscribing to its main half — and this module for everything
 * else. Two reasons, both measured: a cordis service access costs ~15 us against 8 ns for a plain
 * call, which is unacceptable inside a React render; and these are ordinary store operations that
 * gain nothing from a lifecycle.
 *
 * Plugins may also import `@renderer/components/Notice`, `@renderer/icons` and `@renderer/ipc`
 * directly. They are in-repo code sharing the shell's bundle, not sandboxed third-party add-ons;
 * pretending otherwise would mean re-exporting the whole shell through a facade nobody benefits
 * from.
 */

export { Notice } from '../components/Notice'
export { useActiveWorkspace } from '../store'

export interface PluginTabRequest {
  viewType: ViewType
  title: string
  /** Hover text for the tab strip — the path, the URL, whatever identifies it to a reader. */
  tooltip?: string
  state: Record<string, unknown>
  /**
   * Identity for de-duplication. Opening the same key twice re-activates the existing tab rather
   * than adding a second one; leave it out when duplicates are legitimate.
   */
  key?: string
}

/** The workspace a plugin's UI is currently looking at, or null before one is chosen. */
export function activeWorkspaceId(): WorkspaceId | null {
  return useApp.getState().activeWorkspaceId
}

/**
 * Add folders to the workspace, the way dropping them on the explorer does.
 *
 * The rules are the shell's, because the workspace model is: each path is probed for a git work
 * tree, duplicates are ignored, and dropping onto Scratch — which has no folders by definition and
 * is never persisted — makes a NEW workspace out of the first folder rather than adding to it. A
 * folder added to Scratch used to appear in the tree, never appear as a workspace, and be silently
 * gone on the next launch, taking the only record of it with it.
 */
export async function addWorkspaceFolders(paths: string[]): Promise<void> {
  const before = useApp.getState()
  const target = before.workspaces.find((w) => w.id === before.activeWorkspaceId)
  const ontoScratch = !target || target.id === SCRATCH_WORKSPACE_ID

  const probed = await Promise.all(
    paths.map(async (path) => {
      const probe = await rpc['workspace:probeFolder'](path)
      return {
        path,
        name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
        isGitRepo: probe.isGitRepo,
        repoRoot: probe.repoRoot
      } satisfies WorkspaceFolder
    })
  )

  const store = useApp.getState()
  if (ontoScratch) {
    const [first, ...rest] = probed
    if (!first) return
    store.addWorkspace({
      id: nextWorkspaceId(),
      name: first.name,
      folders: [first, ...rest],
      createdAt: Date.now(),
      lastOpenedAt: Date.now()
    } satisfies Workspace)
  } else {
    const known = new Set(target.folders.map((f) => f.path))
    const added = probed.filter((f) => !known.has(f.path))
    if (added.length === 0) return
    store.setWorkspaces(
      store.workspaces.map((w) =>
        w.id === target.id ? { ...w, folders: [...w.folders, ...added] } : w
      )
    )
  }

  const after = useApp.getState()
  void rpc['state:saveWorkspaces']({
    // Scratch is rebuilt at boot; persisting it would let a stale copy outlive the code.
    workspaces: after.workspaces.filter((w) => w.id !== SCRATCH_WORKSPACE_ID),
    activeWorkspaceId: after.activeWorkspaceId
  })
}

/**
 * Open (or re-activate) a tab this plugin owns.
 *
 * Returns the tab's id, or null when there is no workspace to put it in. The view type must be
 * one this plugin declared — the same rule as `contributions`, enforced here too because this is
 * the other way a tab can come into existence.
 */
export function openPluginTab(pluginId: PluginId, request: PluginTabRequest): TabId | null {
  const owner = ownerOf(request.viewType)
  if (owner !== pluginId) {
    throw new Error(`plugin "${pluginId}" cannot open "${request.viewType}", owned by "${owner}"`)
  }
  const store = useApp.getState()
  const workspaceId = store.activeWorkspaceId
  if (!workspaceId) return null

  const tab: CustomTab = {
    id: nextTabId(),
    kind: 'custom',
    title: request.title,
    tooltip: request.tooltip,
    pinned: false,
    viewType: request.viewType,
    state: request.state,
    key: request.key
  }
  store.openTab(workspaceId, tab)
  // openTab re-activates an existing tab with the same key instead of adding this one, so the id
  // that ended up active is the honest answer to "which tab is this?".
  const after = useApp.getState()
  return after.activeTabByWorkspace[workspaceId] ?? tab.id
}

/** Change a tab's title, tooltip, dedup key and/or merge into its state. No-op if it is gone. */
export function patchPluginTab(
  tabId: TabId,
  patch: { title?: string; tooltip?: string; key?: string; state?: Record<string, unknown> }
): void {
  const store = useApp.getState()
  const workspaceId = workspaceOf(tabId)
  if (!workspaceId) return
  const tab = (store.tabsByWorkspace[workspaceId] ?? []).find((t) => t.id === tabId)
  if (!tab || tab.kind !== 'custom') return

  store.updateTab(workspaceId, tabId, {
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.tooltip === undefined ? {} : { tooltip: patch.tooltip }),
    ...(patch.key === undefined ? {} : { key: patch.key }),
    ...(patch.state === undefined ? {} : { state: { ...tab.state, ...patch.state } })
  })
}

/**
 * Every open tab of one of this plugin's own view types, across every workspace.
 *
 * Exists for one job: repairing tabs restored from a persisted state older than the plugin. The
 * shell migrates an old `diff` or `browser` tab by moving its fields into `state`, but it cannot
 * invent a dedup key — only the plugin knows what identifies one of its tabs. So the plugin
 * backfills at activation, and until it does, a restored diff would open a duplicate instead of
 * being re-activated.
 */
export function pluginTabs(
  viewType: ViewType
): { tabId: TabId; state: Record<string, unknown>; key?: string }[] {
  const out: { tabId: TabId; state: Record<string, unknown>; key?: string }[] = []
  for (const tabs of Object.values(useApp.getState().tabsByWorkspace)) {
    for (const tab of tabs) {
      if (tab.kind === 'custom' && tab.viewType === viewType) {
        out.push({ tabId: tab.id, state: tab.state, key: tab.key })
      }
    }
  }
  return out
}

export function closePluginTab(tabId: TabId): void {
  const workspaceId = workspaceOf(tabId)
  if (workspaceId) useApp.getState().closeTab(workspaceId, tabId)
}

/**
 * Every tab id that exists, in every workspace.
 *
 * For plugins holding a resource per tab — a native browser view, a parsed document — that has to
 * be released when the tab goes. Across all workspaces, not just the active one: switching
 * workspaces must not look like every tab was closed.
 */
export function liveTabIds(): Set<TabId> {
  const out = new Set<TabId>()
  for (const tabs of Object.values(useApp.getState().tabsByWorkspace)) {
    for (const tab of tabs) out.add(tab.id)
  }
  return out
}

/**
 * Watch for tabs disappearing. Subscribing outside React keeps this off the render path.
 *
 * Wrap the returned undo in `ctx.effect` so it dies with the plugin.
 */
export function subscribeTabs(listener: (live: Set<TabId>) => void): () => void {
  return useApp.subscribe(
    (s) => s.tabsByWorkspace,
    () => listener(liveTabIds())
  )
}

function workspaceOf(tabId: TabId): WorkspaceId | null {
  const { tabsByWorkspace } = useApp.getState()
  for (const [workspaceId, tabs] of Object.entries(tabsByWorkspace)) {
    if (tabs.some((t) => t.id === tabId)) return workspaceId
  }
  return null
}
