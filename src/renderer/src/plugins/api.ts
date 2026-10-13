import { openInBackground, requestReveal } from '../editing'
import type { PluginId, ViewType } from '@rigee/plugin-api/manifest'
import type { CustomTab, EditorTab, TabId, WorkspaceId } from '@shared/types'
import type { OpenFileRequest, PluginTabRequest } from '@rigee/plugin-api'
import { allTabs, groupById, groupOfTab } from '../groups'
import { focusGroupContent } from '../shortcuts'
import { nextTabId, rowOf, takeDuplicateOrigin, useApp } from '../store'
import { openTerminalTab, splitTerminalAt } from '../terminals'
import { addFolders, openAsWorkspace } from '../workspaces'
import { editorTabTitle, ownerOf, viewTypeFor } from './registry'

/**
 * The shell side of `@rigee/plugin-api` — the behaviour behind the shim a plugin imports.
 *
 * NOTHING IN plugins/ MAY IMPORT THIS MODULE. It used to be the plugin-facing API, and that only
 * worked while every plugin shared the shell's bundle. A plugin from another repository never
 * will, so the SHAPE moved into the package and the implementation stayed here; `shellHost.tsx`
 * is what joins the two, once, at boot.
 *
 * Cordis-free by design. A plugin uses `ctx` for the things that must be revoked when it is
 * disposed — binding components, subscribing to its main half — and this for everything else. Two
 * reasons, both measured: a cordis service access costs ~15 us against 8 ns for a plain call,
 * which is unacceptable inside a React render; and these are ordinary store operations that gain
 * nothing from a lifecycle.
 */

/** The workspace a plugin's UI is currently looking at, or null before one is chosen. */
export function activeWorkspaceId(): WorkspaceId | null {
  return useApp.getState().activeWorkspaceId
}

/**
 * Add folders to the workspace, the way dropping them on the explorer does.
 *
 * The rules are the shell's, because the workspace model is — see `addFolders`: each path is
 * probed for a git work tree, duplicates are ignored, a saved workspace's file gains the folder
 * too, and dropping onto Scratch makes a NEW workspace out of the first folder rather than adding
 * to a workspace that is never persisted.
 */
export async function addWorkspaceFolders(paths: string[]): Promise<void> {
  const target = useApp.getState().activeWorkspaceId
  await (target ? addFolders(target, paths) : openAsWorkspace(paths))
}

/**
 * A terminal in the active workspace, starting in `cwd`: "Open in Terminal Tab" and "… Split" on
 * a folder in the explorer. Never stops to ask about saving the workspace — the user has just said
 * where the shell goes.
 */
export function openTerminal(request: { cwd: string; where?: 'tab' | 'split' }): TabId | null {
  const workspaceId = useApp.getState().activeWorkspaceId
  if (!workspaceId) return null
  return request.where === 'split'
    ? splitTerminalAt(workspaceId, request.cwd)
    : openTerminalTab(workspaceId, { cwd: request.cwd })
}

/**
 * Open (or re-activate) a tab this plugin owns, in the active workspace's ACTIVE GROUP.
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

  const before = rowOf(store, workspaceId)
  const near = request.nearTabId ? groupOfTab(before, request.nearTabId) : undefined
  const groupId = near?.id ?? before.activeGroupId

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
  store.openTab(workspaceId, tab, groupId)
  // openTab re-activates an existing tab with the same key instead of adding this one, so the tab
  // the TARGET GROUP ended up showing is the honest answer to "which tab is this?". Read from that
  // group rather than the row's active one: they are usually the same, but with `nearTabId` they
  // deliberately are not, and the caller would be handed a tab it never opened.
  const after = rowOf(useApp.getState(), workspaceId)
  return groupById(after, groupId)?.activeTabId ?? tab.id
}

/**
 * The tab this one was split from, or null.
 *
 * The split button gives the copy a FRESH tab id — ptys, native views and reading positions are
 * all keyed by tab id, and a shared id would alias two live panes — so a viewer that keeps
 * per-tab state has no other way to find out where the reader was.
 *
 * CONSUME-ONCE. Read it on first mount and keep what you got; the second caller, and every render
 * after the first, gets null. StrictMode's double-invoked effect counts as a second caller, so
 * this belongs in a `useState` initialiser or a ref, never in the effect body.
 */
export function duplicatedFrom(tabId: TabId): TabId | null {
  return takeDuplicateOrigin(tabId)
}

/** Change a tab's title, tooltip, dedup key and/or merge into its state. No-op if it is gone. */
export function patchPluginTab(
  tabId: TabId,
  patch: { title?: string; tooltip?: string; key?: string; state?: Record<string, unknown> }
): void {
  const store = useApp.getState()
  const workspaceId = workspaceOf(tabId)
  if (!workspaceId) return
  const tab = groupOfTab(rowOf(store, workspaceId), tabId)?.tabs.find((t) => t.id === tabId)
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
  // Every group of every workspace — see `liveTabIds` for why a tab missed here is not merely a
  // tab missed. A restored diff in the right-hand column that never gets its dedup key backfilled
  // opens a second copy of itself the next time it is clicked.
  for (const row of Object.values(useApp.getState().rowsByWorkspace)) {
    for (const tab of allTabs(row)) {
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
 * Make a tab the one its column shows, and that column the active one — for a tab whose content
 * took the keyboard where the shell cannot see it happen: a click into a browser page lands on a
 * native view, not in the DOM. Only in the workspace on screen; a no-op when nothing would change,
 * so a plugin can call it from a focus event without starting a loop.
 */
export function activateTab(tabId: TabId): void {
  const s = useApp.getState()
  const workspaceId = s.activeWorkspaceId
  if (!workspaceId || workspaceOf(tabId) !== workspaceId) return
  const row = rowOf(s, workspaceId)
  const group = groupOfTab(row, tabId)
  if (!group || (group.activeTabId === tabId && row.activeGroupId === group.id)) return
  s.setActiveTab(workspaceId, tabId)
}

/**
 * Every tab id that exists: every GROUP of every workspace.
 *
 * For plugins holding a resource per tab — a native browser view, a parsed document — that has to
 * be released when the tab goes. The callers treat anything absent from this set as closed, so the
 * flattening must span every dimension the tabs are spread across or it is a destroy order for
 * tabs that are still on screen: the browser plugin would tear down the native view of a page the
 * user is reading in the second column, and the PDF plugin would free the document and the reading
 * position out from under a pane mid-render. Both fail silently.
 *
 * Across all workspaces, not just the active one: switching workspaces must not look like every
 * tab was closed. Across all groups, not just the active one, for exactly the same reason — and
 * that half is new, because until groups existed a workspace's tabs were one flat list.
 */
export function liveTabIds(): Set<TabId> {
  const out = new Set<TabId>()
  for (const row of Object.values(useApp.getState().rowsByWorkspace)) {
    for (const group of row.groups) {
      for (const tab of group.tabs) out.add(tab.id)
    }
  }
  return out
}

/**
 * Watch for tabs disappearing. Subscribing outside React keeps this off the render path.
 *
 * Watches the whole row map, which also fires on a split, a drag between groups and a resize. That
 * is deliberate over-notification: the alternative is deriving the id set on every store write to
 * compare it, and the listeners here are all idempotent sweeps.
 *
 * Wrap the returned undo in `ctx.effect` so it dies with the plugin.
 */
export function subscribeTabs(listener: (live: Set<TabId>) => void): () => void {
  return useApp.subscribe(
    (s) => s.rowsByWorkspace,
    () => listener(liveTabIds())
  )
}

function workspaceOf(tabId: TabId): WorkspaceId | null {
  for (const [workspaceId, row] of Object.entries(useApp.getState().rowsByWorkspace)) {
    if (groupOfTab(row, tabId)) return workspaceId
  }
  return null
}

// ---------------------------------------------------------------------------
// What the plugins used to reach into the store for
// ---------------------------------------------------------------------------

/**
 * Open a file in whichever editor claims it, in the active group.
 *
 * The explorer used to do this itself: read `resolveViewType`, mint a tab id with `nextTabId` and
 * call `openTab` on the store — three shell internals in one click handler, and the reason a file
 * tree could not be written by anybody outside this repository. The resolution belongs here
 * anyway: it reads the manifests, so no plugin is loaded to answer "who opens a .pdf", and a
 * caller has no business knowing that editors have priorities.
 */
export function openFile(request: OpenFileRequest): TabId | null {
  const store = useApp.getState()
  const workspaceId = store.activeWorkspaceId
  if (!workspaceId) return null

  const before = rowOf(store, workspaceId)
  const near = request.nearTabId ? groupOfTab(before, request.nearTabId) : undefined
  const groupId = near?.id ?? before.activeGroupId
  const showing = groupById(before, groupId)?.activeTabId ?? null

  // Resolved once, here, from the manifests alone: an array scan over a handful of declarations,
  // and no plugin loaded. Doing it in the pane instead would either scan on every render or force
  // the viewer to load before the user has committed to the file.
  const viewType = viewTypeFor(request.path, request.viewType) ?? undefined
  const tab: EditorTab = {
    id: nextTabId(),
    kind: 'editor',
    title: request.title ?? editorTabTitle(request.path, viewType),
    pinned: false,
    filePath: request.path,
    repoId: null,
    readOnly: request.readOnly ?? false,
    viewType
  }
  store.openTab(workspaceId, tab, groupId)
  // openTab re-activates an existing tab for the same file rather than adding this one, so read
  // back what the TARGET group ended up showing — see `openPluginTab` for the same reasoning.
  const after = rowOf(useApp.getState(), workspaceId)
  const opened = groupById(after, groupId)?.activeTabId ?? tab.id
  if (request.selection) requestReveal(opened, request.selection)
  // The keyboard. A viewer takes it as it mounts, so a background open only has to say so when
  // something is about to mount; a file already on screen mounts nothing, and is handed it here —
  // unless a selection is on its way to it, whose reveal gives the editor the keyboard itself.
  if (request.preserveFocus) {
    if (opened !== showing) openInBackground(opened)
  } else {
    openInBackground(null)
    if (opened === showing && !request.selection) {
      const shown = groupById(after, groupId)?.tabs.find((t) => t.id === opened)
      requestAnimationFrame(() => focusGroupContent(groupId, shown))
    }
  }
  return opened
}

/**
 * The one tab with the keyboard: the active group's active tab, in the active workspace.
 *
 * THE focus rule, written once. The browser plugin had its own copy, reading `rowOf` out of the
 * store, because there was nowhere else to put it — and two copies of a rule this small is how two
 * visible pages end up disagreeing about which of them should be typing.
 */
export function focusedTabId(): TabId | null {
  return focusedIn(useApp.getState())
}

function focusedIn(state: ReturnType<typeof useApp.getState>): TabId | null {
  const workspaceId = state.activeWorkspaceId
  if (!workspaceId) return null
  const row = rowOf(state, workspaceId)
  return row.groups.find((g) => g.id === row.activeGroupId)?.activeTabId ?? null
}

/** The same rule as a hook, for a pane that must re-render when focus moves to another column. */
export function useFocusedTabId(): TabId | null {
  return useApp(focusedIn)
}

/**
 * The active tab of every group in the ACTIVE workspace, left to right — what is on screen.
 *
 * Only the active workspace, because only its row is rendered. The pages of a workspace you
 * switched away from are still alive, and treating them as visible is how a native view ends up
 * composited over the whole window and switching workspaces looks like nothing happened.
 */
export function mountedTabIds(): TabId[] {
  const state = useApp.getState()
  // A shell dialog is up. A browser page is a native view drawn OVER the document, so a page left
  // on screen would hide the dialog and take the clicks meant for it: nothing counts as on screen.
  if (!state.activeWorkspaceId || state.settingsOpen) return []
  return rowOf(state, state.activeWorkspaceId)
    .groups.map((g) => g.activeTabId)
    .filter((id): id is TabId => id !== null)
}

/**
 * Watch for a change in what is mounted — a split, a drag between groups, a workspace switch.
 *
 * The selector is that list flattened to a string, so a title change, a resize or a keystroke
 * costs one comparison and nothing more. Wrap the returned undo in `ctx.effect`.
 */
export function subscribeMountedTabs(listener: (tabIds: TabId[]) => void): () => void {
  return useApp.subscribe(
    (s) => (s.activeWorkspaceId && !s.settingsOpen ? mountedKey(s) : ''),
    () => listener(mountedTabIds())
  )
}

function mountedKey(state: ReturnType<typeof useApp.getState>): string {
  if (!state.activeWorkspaceId) return ''
  return rowOf(state, state.activeWorkspaceId)
    .groups.map((g) => g.activeTabId ?? '')
    .join(' ')
}

/**
 * A plugin's own persisted state for one workspace, or undefined if it has never written any.
 *
 * Undefined is a real answer, not an empty one — see the comment on `WorkspaceUiState.pluginState`.
 */
export function pluginState(
  pluginId: PluginId,
  workspaceId: WorkspaceId
): Record<string, unknown> | undefined {
  return useApp.getState().pluginStateByWorkspace[workspaceId]?.[pluginId]
}

/** The same, as a hook. A null workspace yields undefined rather than throwing. */
export function usePluginState(
  pluginId: PluginId,
  workspaceId: WorkspaceId | null
): Record<string, unknown> | undefined {
  return useApp((s) => (workspaceId ? s.pluginStateByWorkspace[workspaceId]?.[pluginId] : undefined))
}

export function setPluginState(
  pluginId: PluginId,
  workspaceId: WorkspaceId,
  patch: Record<string, unknown>
): void {
  useApp.getState().setPluginState(workspaceId, pluginId, patch)
}
