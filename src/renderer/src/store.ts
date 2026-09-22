import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { newLeaf } from './paneTree'
import { resolveViewType, viewTypeForLegacyKind } from './plugins/registry'
import { nextActiveTab } from './tabs'
import {
  DEFAULT_KEYBINDINGS,
  DEFAULT_PANEL_LAYOUT,
  type PanelLayout,
  type Tab,
  type TabId,
  type KeyBindings,
  type PaneNode,
  type Workspace,
  type WorkspaceId
} from '@shared/types'

/**
 * Renderer state.
 *
 * HARD RULE, do not relax it: this store holds descriptors only. Terminal byte streams, xterm
 * Terminal instances and Monaco models never enter it. Those are mutable, high-churn objects;
 * putting them here would turn every keystroke into a React render of the whole tree. They live
 * in module-level Maps keyed by tab id (see terminals.ts / editors.ts) and are reached by ref.
 *
 * subscribeWithSelector is enabled so non-React code (bounds sync for the native browser views)
 * can watch a single slice imperatively without re-rendering anything.
 */

interface AppState {
  ready: boolean
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null

  /** Per-workspace, so switching workspaces keeps each one's tabs. */
  tabsByWorkspace: Record<WorkspaceId, Tab[]>
  activeTabByWorkspace: Record<WorkspaceId, TabId | null>
  layout: PanelLayout

  /**
   * Which explorer directories are expanded, per workspace, by absolute path.
   *
   * In the store rather than in each DirNode because it has to outlive the components: switching
   * workspaces unmounts the whole tree, and local state went with it — so coming back to a
   * workspace re-expanded everything from defaults instead of showing it as you left it.
   * Persisted as `WorkspaceUiState.expandedDirs`.
   */
  expandedDirs: Record<WorkspaceId, string[]>

  keybindings: KeyBindings

  // --- actions ---
  setReady: (ready: boolean) => void
  setWorkspaces: (workspaces: Workspace[]) => void
  setActiveWorkspace: (id: WorkspaceId | null) => void
  addWorkspace: (workspace: Workspace) => void
  removeWorkspace: (id: WorkspaceId) => void

  openTab: (workspaceId: WorkspaceId, tab: Tab) => void
  closeTab: (workspaceId: WorkspaceId, tabId: TabId) => void
  closeTabs: (workspaceId: WorkspaceId, tabIds: readonly TabId[]) => void
  setActiveTab: (workspaceId: WorkspaceId, tabId: TabId | null) => void
  updateTab: (workspaceId: WorkspaceId, tabId: TabId, patch: Partial<Tab>) => void
  reorderTabs: (workspaceId: WorkspaceId, from: number, to: number) => void

  setLayout: (patch: Partial<PanelLayout>) => void
  toggleDir: (workspaceId: WorkspaceId, path: string) => void
  setExpandedDirs: (workspaceId: WorkspaceId, paths: string[]) => void
  setKeybindings: (keybindings: KeyBindings) => void
}

export const useApp = create<AppState>()(
  subscribeWithSelector((set, get) => ({
    ready: false,
    workspaces: [],
    activeWorkspaceId: null,
    tabsByWorkspace: {},
    activeTabByWorkspace: {},
    layout: { ...DEFAULT_PANEL_LAYOUT },
    expandedDirs: {},
    keybindings: { ...DEFAULT_KEYBINDINGS },

    setReady: (ready) => set({ ready }),
    setWorkspaces: (workspaces) => set({ workspaces }),
    setActiveWorkspace: (activeWorkspaceId) => set({ activeWorkspaceId }),

    addWorkspace: (workspace) =>
      set((s) => ({
        workspaces: [...s.workspaces, workspace],
        activeWorkspaceId: workspace.id,
        tabsByWorkspace: { ...s.tabsByWorkspace, [workspace.id]: [] },
        activeTabByWorkspace: { ...s.activeTabByWorkspace, [workspace.id]: null }
      })),

    removeWorkspace: (id) =>
      set((s) => {
        const workspaces = s.workspaces.filter((w) => w.id !== id)
        const tabsByWorkspace = { ...s.tabsByWorkspace }
        const activeTabByWorkspace = { ...s.activeTabByWorkspace }
        delete tabsByWorkspace[id]
        delete activeTabByWorkspace[id]
        return {
          workspaces,
          tabsByWorkspace,
          activeTabByWorkspace,
          activeWorkspaceId: s.activeWorkspaceId === id ? (workspaces[0]?.id ?? null) : s.activeWorkspaceId
        }
      }),

    openTab: (workspaceId, tab) =>
      set((s) => {
        const existing = s.tabsByWorkspace[workspaceId] ?? []
        // Re-activate rather than duplicate when the same file/url is already open.
        const dupe = existing.find((t) => sameTarget(t, tab))
        if (dupe) {
          return { activeTabByWorkspace: { ...s.activeTabByWorkspace, [workspaceId]: dupe.id } }
        }
        return {
          tabsByWorkspace: { ...s.tabsByWorkspace, [workspaceId]: [...existing, tab] },
          activeTabByWorkspace: { ...s.activeTabByWorkspace, [workspaceId]: tab.id }
        }
      }),

    closeTab: (workspaceId, tabId) => get().closeTabs(workspaceId, [tabId]),

    /**
     * Close a set of tabs in one update, rather than looping over `closeTab`. One write, so the
     * persistence subscriber and the browser-view reaper each run once, and the selection rule is
     * applied once over the whole set instead of hopping through tabs that are also about to go.
     */
    closeTabs: (workspaceId, tabIds) =>
      set((s) => {
        const tabs = s.tabsByWorkspace[workspaceId] ?? []
        const doomed = new Set(tabIds)
        const next = tabs.filter((t) => !doomed.has(t.id))
        if (next.length === tabs.length) return {}
        return {
          tabsByWorkspace: { ...s.tabsByWorkspace, [workspaceId]: next },
          activeTabByWorkspace: {
            ...s.activeTabByWorkspace,
            [workspaceId]: nextActiveTab(tabs, s.activeTabByWorkspace[workspaceId] ?? null, doomed)
          }
        }
      }),

    setActiveTab: (workspaceId, tabId) =>
      set((s) => ({ activeTabByWorkspace: { ...s.activeTabByWorkspace, [workspaceId]: tabId } })),

    updateTab: (workspaceId, tabId, patch) =>
      set((s) => {
        const tabs = s.tabsByWorkspace[workspaceId]
        if (!tabs) return {}
        let changed = false
        const next = tabs.map((t) => {
          if (t.id !== tabId) return t
          changed = true
          return { ...t, ...patch } as Tab
        })
        return changed ? { tabsByWorkspace: { ...s.tabsByWorkspace, [workspaceId]: next } } : {}
      }),

    reorderTabs: (workspaceId, from, to) =>
      set((s) => {
        const tabs = s.tabsByWorkspace[workspaceId]
        if (!tabs || from === to) return {}
        const next = [...tabs]
        const [moved] = next.splice(from, 1)
        if (!moved) return {}
        next.splice(to, 0, moved)
        return { tabsByWorkspace: { ...s.tabsByWorkspace, [workspaceId]: next } }
      }),

    setLayout: (patch) => set((s) => ({ layout: { ...s.layout, ...patch } })),

    toggleDir: (workspaceId, path) =>
      set((s) => {
        const open = new Set(s.expandedDirs[workspaceId] ?? [])
        if (!open.delete(path)) open.add(path)
        return { expandedDirs: { ...s.expandedDirs, [workspaceId]: [...open] } }
      }),

    setExpandedDirs: (workspaceId, paths) =>
      set((s) => ({ expandedDirs: { ...s.expandedDirs, [workspaceId]: [...new Set(paths)] } })),
    setKeybindings: (keybindings) => set({ keybindings })
  }))
)

function sameTarget(a: Tab, b: Tab): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'editor' && b.kind === 'editor') {
    // viewType as well as path: "Open as text" on an open PDF must produce a text tab, not
    // silently re-activate the PDF and look like the menu item did nothing.
    return a.filePath === b.filePath && a.viewType === b.viewType
  }
  if (a.kind === 'custom' && b.kind === 'custom') {
    // The plugin decides. No key means "always distinct", which is what two browser tabs on the
    // same URL should be, and what a diff of the same file against the same revision should not.
    return a.key !== undefined && a.key === b.key && a.viewType === b.viewType
  }
  return false // terminals are always distinct
}

// --- selectors: keep components subscribed to the narrowest slice possible ---

export const useActiveWorkspace = (): Workspace | null =>
  useApp((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null)

export const useTabs = (): Tab[] =>
  useApp((s) => (s.activeWorkspaceId ? (s.tabsByWorkspace[s.activeWorkspaceId] ?? EMPTY_TABS) : EMPTY_TABS))

export const useActiveTab = (): Tab | null =>
  useApp((s) => {
    if (!s.activeWorkspaceId) return null
    const id = s.activeTabByWorkspace[s.activeWorkspaceId]
    if (!id) return null
    return s.tabsByWorkspace[s.activeWorkspaceId]?.find((t) => t.id === id) ?? null
  })

/** Stable identity so the selector above cannot cause an infinite render loop. */
const EMPTY_TABS: Tab[] = []

/**
 * Repair tabs coming back from disk.
 *
 * Persisted UI state outlives the shape of the code that wrote it — a terminal tab saved before
 * splits existed has no `root`, and rendering it throws on the first property access. Anything
 * that cannot be repaired is dropped: losing a restored tab is a nuisance, a shell that will not
 * render is a broken window.
 *
 * Pane ids are always cleared. The processes they referred to died with the previous run.
 *
 * This is also where state written before the plugin system is brought forward. The shell used to
 * own `diff` and `browser` tab kinds; it does not now, and rather than keep a list of features it
 * once had, it asks the manifests which plugin claimed each old kind (`legacyKind`). A tab whose
 * old kind nobody claims is dropped, which is the same answer as for any other unrenderable tab.
 */
export function sanitizeTabs(tabs: unknown): Tab[] {
  if (!Array.isArray(tabs)) return []
  const out: Tab[] = []
  for (const raw of tabs) {
    const tab = raw as Partial<Tab> & Record<string, unknown>
    if (!tab || typeof tab.id !== 'string' || typeof tab.kind !== 'string') continue

    if (tab.kind === 'terminal') {
      const root = isPaneNode(tab.root) ? clearPaneIds(tab.root) : newLeaf()
      const ids = new Set(leafIds(root))
      out.push({
        id: tab.id,
        kind: 'terminal',
        title: typeof tab.title === 'string' ? tab.title : 'terminal',
        pinned: tab.pinned === true,
        root,
        activeLeafId:
          typeof tab.activeLeafId === 'string' && ids.has(tab.activeLeafId)
            ? tab.activeLeafId
            : ([...ids][0] ?? '')
      })
      continue
    }

    if (tab.kind === 'editor' && typeof tab.filePath === 'string') {
      // A tab written before editors were plugins has no viewType, and the explorer now puts one
      // on every tab it opens. Leaving it absent makes the two look like different targets, so
      // clicking a file that is already open from an older session opens a SECOND tab for it.
      // Resolving here is free — the same manifest scan the explorer does — and it also means the
      // tab strip can show the right icon for a restored .pdf.
      const viewType =
        typeof tab.viewType === 'string' ? tab.viewType : (resolveViewType(tab.filePath) ?? undefined)
      out.push({ ...(tab as Extract<Tab, { kind: 'editor' }>), viewType })
      continue
    }

    if (tab.kind === 'custom' && typeof tab.viewType === 'string') {
      out.push({
        id: tab.id,
        kind: 'custom',
        title: typeof tab.title === 'string' ? tab.title : tab.viewType,
        pinned: tab.pinned === true,
        viewType: tab.viewType,
        // The plugin validates its own state on restore; the shell cannot, and a tab whose state
        // is nonsense is the plugin's problem to report rather than ours to guess at.
        state: isRecord(tab.state) ? tab.state : {},
        key: typeof tab.key === 'string' ? tab.key : undefined
      })
      continue
    }

    const migrated = migrateLegacyTab(tab)
    if (migrated) out.push(migrated)
  }
  return out
}

/** A tab persisted under a kind the shell no longer has, rewritten to its plugin's view type. */
function migrateLegacyTab(tab: Partial<Tab> & Record<string, unknown>): Tab | null {
  const viewType = viewTypeForLegacyKind(tab.kind as string)
  if (!viewType || typeof tab.id !== 'string') return null

  // Everything except the shell's own fields becomes the plugin's state. A `diff` tab's filePath,
  // repoId and against; a `browser` tab's url and navigation flags. The plugin knows what to do
  // with them — and what to ignore, like the viewId of a native view that died with the process.
  const { id, kind, title, pinned, ...state } = tab
  void kind
  return {
    id,
    kind: 'custom',
    title: typeof title === 'string' ? title : viewType,
    pinned: pinned === true,
    viewType,
    state
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isPaneNode(v: unknown): v is PaneNode {
  if (!v || typeof v !== 'object') return false
  const n = v as PaneNode
  if (n.kind === 'leaf') return typeof n.id === 'string'
  if (n.kind === 'split') return Array.isArray(n.children) && n.children.every(isPaneNode)
  return false
}

function clearPaneIds(node: PaneNode): PaneNode {
  if (node.kind === 'leaf') return { ...node, paneId: null }
  return { ...node, children: node.children.map(clearPaneIds) }
}

function leafIds(node: PaneNode): string[] {
  return node.kind === 'leaf' ? [node.id] : node.children.flatMap(leafIds)
}

/** A fresh terminal tab: one pane, not yet bound to a pty. */
export function newTerminalTab(): Tab {
  const leaf = newLeaf()
  return {
    id: nextTabId(),
    kind: 'terminal',
    title: 'terminal',
    pinned: false,
    root: leaf,
    activeLeafId: leaf.id
  }
}

let tabSeq = 0
export const nextTabId = (): TabId => `tab_${++tabSeq}_${Date.now().toString(36)}`
export const nextWorkspaceId = (): WorkspaceId => `ws_${Date.now().toString(36)}`
