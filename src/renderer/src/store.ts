import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import {
  DEFAULT_PANEL_LAYOUT,
  type PanelLayout,
  type RepoStatus,
  type Tab,
  type TabId,
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

  /** Keyed by repo root. */
  scm: Record<string, RepoStatus>

  // --- actions ---
  setReady: (ready: boolean) => void
  setWorkspaces: (workspaces: Workspace[]) => void
  setActiveWorkspace: (id: WorkspaceId | null) => void
  addWorkspace: (workspace: Workspace) => void
  removeWorkspace: (id: WorkspaceId) => void

  openTab: (workspaceId: WorkspaceId, tab: Tab) => void
  closeTab: (workspaceId: WorkspaceId, tabId: TabId) => void
  setActiveTab: (workspaceId: WorkspaceId, tabId: TabId | null) => void
  updateTab: (workspaceId: WorkspaceId, tabId: TabId, patch: Partial<Tab>) => void
  reorderTabs: (workspaceId: WorkspaceId, from: number, to: number) => void

  setLayout: (patch: Partial<PanelLayout>) => void
  setRepoStatus: (status: RepoStatus) => void
}

export const useApp = create<AppState>()(
  subscribeWithSelector((set) => ({
    ready: false,
    workspaces: [],
    activeWorkspaceId: null,
    tabsByWorkspace: {},
    activeTabByWorkspace: {},
    layout: { ...DEFAULT_PANEL_LAYOUT },
    scm: {},

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

    closeTab: (workspaceId, tabId) =>
      set((s) => {
        const tabs = s.tabsByWorkspace[workspaceId] ?? []
        const idx = tabs.findIndex((t) => t.id === tabId)
        if (idx < 0) return {}
        const next = tabs.filter((t) => t.id !== tabId)
        let active = s.activeTabByWorkspace[workspaceId] ?? null
        if (active === tabId) {
          // Activate the neighbour to the right, falling back to the left. Matches VSCode.
          active = next[idx]?.id ?? next[idx - 1]?.id ?? null
        }
        return {
          tabsByWorkspace: { ...s.tabsByWorkspace, [workspaceId]: next },
          activeTabByWorkspace: { ...s.activeTabByWorkspace, [workspaceId]: active }
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
    setRepoStatus: (status) => set((s) => ({ scm: { ...s.scm, [status.root]: status } }))
  }))
)

function sameTarget(a: Tab, b: Tab): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'editor' && b.kind === 'editor') return a.filePath === b.filePath
  if (a.kind === 'diff' && b.kind === 'diff') {
    return a.filePath === b.filePath && a.repoId === b.repoId && a.against.kind === b.against.kind
  }
  return false // terminals and browser tabs are always distinct
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

let tabSeq = 0
export const nextTabId = (): TabId => `tab_${++tabSeq}_${Date.now().toString(36)}`
export const nextWorkspaceId = (): WorkspaceId => `ws_${Date.now().toString(36)}`
