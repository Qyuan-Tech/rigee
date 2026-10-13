import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import {
  activateTab as activateTabInRow,
  allTabs,
  canDuplicate,
  duplicateTab,
  groupById,
  closeTabs as closeTabsInRow,
  focusGroup as focusGroupInRow,
  groupOfTab,
  moveTab as moveTabInRow,
  moveTabToNewGroup,
  openInGroup,
  setBoundary,
  singleGroupRow,
  splitGroup as splitGroupInRow,
  type GroupId,
  type GroupRow
} from './groups'
import { newLeaf } from './paneTree'
import { isDuplicableViewType, resolveViewType, viewTypeForLegacyKind } from './plugins/registry'
import {
  DEFAULT_KEYBINDINGS,
  DEFAULT_PANEL_LAYOUT,
  type AppSettings,
  type PanelLayout,
  type Tab,
  type TabGroup,
  type TabId,
  type TerminalTab,
  type KeyBindings,
  type PaneNode,
  type PtyPaneId,
  type Workspace,
  type WorkspaceActivity,
  type WorkspaceId
} from '@shared/types'
import type { PluginId } from '@rigee/plugin-api/manifest'

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

  /**
   * The centre pane of each workspace: a row of editor groups, left to right.
   *
   * One object per workspace rather than three parallel maps, because the invariant that makes the
   * row renderable — one fraction per group, summing to one, and an `activeGroupId` that names a
   * group that exists — spans all three. Every operation in `groups.ts` takes a whole row and
   * returns a whole row, so there is no moment where a render can see the groups updated and the
   * sizes not.
   */
  rowsByWorkspace: Record<WorkspaceId, GroupRow>
  layout: PanelLayout

  /**
   * Whatever each plugin wants to remember about each workspace. The shell never looks inside.
   *
   * In the store rather than in the plugin's own components because it has to outlive them:
   * switching workspaces unmounts a panel entirely, and local state went with it — so coming back
   * showed the tree re-expanded from defaults instead of as you left it. Persisted as
   * `WorkspaceUiState.pluginState`; this replaced a hard-coded `expandedDirs` map.
   */
  pluginStateByWorkspace: Record<WorkspaceId, Record<PluginId, Record<string, unknown>>>

  /**
   * How each workspace has been used lately, minute by minute and day by day — what the side bar's
   * heat is worked out from (heat.ts). Written by activity.ts, at most once a minute per workspace,
   * and persisted as `WorkspaceUiState.activity`.
   */
  activityByWorkspace: Record<WorkspaceId, WorkspaceActivity>

  /**
   * Terminal panes at work — printing like an agent or a build (paneWork.ts) — by pty pane id, each
   * with the name of the program in front of its shell, or '' where main could not say.
   */
  workingPanes: Record<PtyPaneId, string>
  /**
   * Terminal panes that have finished since the user last looked at them, the same way. Cleared
   * when the keyboard goes into the pane, or it starts work again.
   *
   * Both here, though they come from terminal output, because they change only when a pane starts,
   * stops or is looked at — a handful of writes a minute, not one per frame — and the side bar, the
   * tab strip and the pane all draw them. paneWatch.ts is the only writer.
   */
  unseenPanes: Record<PtyPaneId, string>

  keybindings: KeyBindings
  /** Preferences other than key bindings: the settings dialog's General page. */
  settings: AppSettings
  /**
   * Whether the settings dialog is open. Here rather than in App's local state because Cmd+, opens
   * it from a key handler that is nowhere near the component tree.
   */
  settingsOpen: boolean
  /**
   * Files with unsaved changes, by path — what the tab strip marks with a dot. Reported by the
   * editor; the shell only reads it, and asks before closing over it (editing.ts).
   */
  dirtyFiles: Record<string, true>
  /**
   * What last went wrong with a workspace — a workspace file that would not open, would not save, or
   * would not take a folder just added — shown under the workspace list until dismissed. Here rather
   * than in the list's own state because a folder dropped on the explorer is added the same way.
   */
  workspaceError: string | null

  // --- actions ---
  setReady: (ready: boolean) => void
  setWorkspaces: (workspaces: Workspace[]) => void
  setActiveWorkspace: (id: WorkspaceId | null) => void
  addWorkspace: (workspace: Workspace) => void
  removeWorkspace: (id: WorkspaceId) => void

  /** Open into `groupId`, or into the active group when it is left out. */
  openTab: (workspaceId: WorkspaceId, tab: Tab, groupId?: GroupId) => void
  closeTab: (workspaceId: WorkspaceId, tabId: TabId) => void
  closeTabs: (workspaceId: WorkspaceId, tabIds: readonly TabId[]) => void
  setActiveTab: (workspaceId: WorkspaceId, tabId: TabId | null) => void
  updateTab: (workspaceId: WorkspaceId, tabId: TabId, patch: Partial<Tab>) => void

  // --- editor groups ---
  setRow: (workspaceId: WorkspaceId, row: GroupRow) => void
  focusGroup: (workspaceId: WorkspaceId, groupId: GroupId) => void
  /** Put `tab` in a new group to the right of `groupId`. The caller decides copy versus move. */
  splitGroup: (workspaceId: WorkspaceId, groupId: GroupId, tab: Tab) => void
  /**
   * Split a group's active tab into a new group to its right — the button, and Cmd+\.
   *
   * Copies what can be copied and moves what cannot, so both callers get the same answer. Defaults
   * to the active group.
   */
  splitTab: (workspaceId: WorkspaceId, groupId?: GroupId) => void
  moveTab: (workspaceId: WorkspaceId, tabId: TabId, toGroupId: GroupId, toIndex: number) => void
  moveTabToNewGroup: (workspaceId: WorkspaceId, tabId: TabId) => void
  /** Absolute, not incremental: Splitter reports the cumulative offset since pointer-down. */
  setGroupBoundary: (workspaceId: WorkspaceId, index: number, leftFraction: number) => void

  setLayout: (patch: Partial<PanelLayout>) => void
  /** Merge into one plugin's state for one workspace. */
  setPluginState: (
    workspaceId: WorkspaceId,
    pluginId: PluginId,
    patch: Record<string, unknown>
  ) => void
  setActivity: (workspaceId: WorkspaceId, activity: WorkspaceActivity) => void
  /** At work running `program`, or not at work (null). */
  setPaneWorking: (paneId: PtyPaneId, program: string | null) => void
  /** Finished unseen, having run `program`, or seen (null). */
  setPaneUnseen: (paneId: PtyPaneId, program: string | null) => void
  /** Its shell has gone. */
  forgetPane: (paneId: PtyPaneId) => void
  setKeybindings: (keybindings: KeyBindings) => void
  setSettings: (settings: AppSettings) => void
  setSettingsOpen: (open: boolean) => void
  setWorkspaceError: (message: string | null) => void
}

export const useApp = create<AppState>()(
  subscribeWithSelector((set, get) => ({
    ready: false,
    workspaces: [],
    activeWorkspaceId: null,
    rowsByWorkspace: {},
    layout: { ...DEFAULT_PANEL_LAYOUT },
    pluginStateByWorkspace: {},
    activityByWorkspace: {},
    workingPanes: {},
    unseenPanes: {},
    keybindings: { ...DEFAULT_KEYBINDINGS },
    settings: {},
    settingsOpen: false,
    dirtyFiles: {},
    workspaceError: null,

    setReady: (ready) => set({ ready }),
    setWorkspaces: (workspaces) => set({ workspaces }),
    setActiveWorkspace: (activeWorkspaceId) => set({ activeWorkspaceId }),

    addWorkspace: (workspace) =>
      set((s) => ({
        workspaces: [...s.workspaces, workspace],
        activeWorkspaceId: workspace.id,
        rowsByWorkspace: { ...s.rowsByWorkspace, [workspace.id]: singleGroupRow(nextGroupId()) }
      })),

    removeWorkspace: (id) =>
      set((s) => {
        const workspaces = s.workspaces.filter((w) => w.id !== id)
        const rowsByWorkspace = { ...s.rowsByWorkspace }
        delete rowsByWorkspace[id]
        const activityByWorkspace = { ...s.activityByWorkspace }
        delete activityByWorkspace[id]
        return {
          workspaces,
          rowsByWorkspace,
          activityByWorkspace,
          activeWorkspaceId: s.activeWorkspaceId === id ? (workspaces[0]?.id ?? null) : s.activeWorkspaceId
        }
      }),

    openTab: (workspaceId, tab, groupId) =>
      set((s) => {
        const row = rowOf(s, workspaceId)
        // De-duplication is PER GROUP: the same file open in two groups side by side is the whole
        // point of splitting, so re-activating a tab from the other column would defeat it.
        return {
          rowsByWorkspace: {
            ...s.rowsByWorkspace,
            [workspaceId]: openInGroup(row, groupId ?? row.activeGroupId, tab, sameTarget)
          }
        }
      }),

    closeTab: (workspaceId, tabId) => get().closeTabs(workspaceId, [tabId]),

    /**
     * Close a set of tabs in one update, rather than looping over `closeTab`. One write, so the
     * persistence subscriber and the resource reapers each run once, and the selection rule is
     * applied once over the whole set instead of hopping through tabs that are also about to go.
     *
     * A group left empty goes with them — except the last one, which stays to hold the "Nothing
     * open" state and to give the next file somewhere to land.
     */
    closeTabs: (workspaceId, tabIds) =>
      set((s) => {
        const row = rowOf(s, workspaceId)
        const next = closeTabsInRow(row, tabIds)
        return next === row ? {} : { rowsByWorkspace: { ...s.rowsByWorkspace, [workspaceId]: next } }
      }),

    // Showing a tab also focuses its group: clicking a tab is how you say which column you are
    // working in, and the next file you open from the explorer goes there.
    setActiveTab: (workspaceId, tabId) =>
      set((s) => {
        if (tabId === null) return {}
        const row = rowOf(s, workspaceId)
        return { rowsByWorkspace: { ...s.rowsByWorkspace, [workspaceId]: activateTabInRow(row, tabId) } }
      }),

    updateTab: (workspaceId, tabId, patch) =>
      set((s) => {
        const row = rowOf(s, workspaceId)
        const group = groupOfTab(row, tabId)
        if (!group) return {}
        return {
          rowsByWorkspace: {
            ...s.rowsByWorkspace,
            [workspaceId]: {
              ...row,
              groups: row.groups.map((g) =>
                g.id !== group.id
                  ? g
                  : { ...g, tabs: g.tabs.map((t) => (t.id === tabId ? ({ ...t, ...patch } as Tab) : t)) }
              )
            }
          }
        }
      }),

    setRow: (workspaceId, row) =>
      set((s) => ({ rowsByWorkspace: { ...s.rowsByWorkspace, [workspaceId]: row } })),

    focusGroup: (workspaceId, groupId) =>
      set((s) => ({
        rowsByWorkspace: {
          ...s.rowsByWorkspace,
          [workspaceId]: focusGroupInRow(rowOf(s, workspaceId), groupId)
        }
      })),

    splitGroup: (workspaceId, groupId, tab) =>
      set((s) => ({
        rowsByWorkspace: {
          ...s.rowsByWorkspace,
          [workspaceId]: splitGroupInRow(rowOf(s, workspaceId), groupId, nextGroupId(), tab)
        }
      })),

    splitTab: (workspaceId, groupId) => {
      const row = rowOf(get(), workspaceId)
      const group = groupById(row, groupId ?? row.activeGroupId)
      const tab = group?.tabs.find((t) => t.id === group.activeTabId)
      if (!group || !tab) return

      /*
       * A copy for anything that can be in two places — a file, a diff — so the gesture reads as
       * VS Code's "Split Right": the same document, twice, side by side. A MOVE for anything whose
       * renderer-side resources are keyed by tab id: a terminal's ptys, a browser tab's native
       * view. Two panes sharing either would be two xterms on one shell, or one native view
       * snapping between two rectangles.
       */
      if (!canDuplicate(tab, isDuplicableViewType)) {
        // Moving the only tab out of a group closes that group and opens an identical one beside
        // it — a lot of motion for no change.
        if (group.tabs.length > 1) get().moveTabToNewGroup(workspaceId, tab.id)
        return
      }

      const copy = duplicateTab(tab, nextTabId(), (state) => structuredClone(state))
      if (!copy) return
      // The copy inherits where the reader was: a viewer with per-tab state — the PDF's page and
      // zoom — asks for its origin on first mount, so splitting on page 143 does not reopen at 1.
      rememberDuplicate(copy.id, tab.id)
      get().splitGroup(workspaceId, group.id, copy)
    },

    moveTab: (workspaceId, tabId, toGroupId, toIndex) =>
      set((s) => ({
        rowsByWorkspace: {
          ...s.rowsByWorkspace,
          [workspaceId]: moveTabInRow(rowOf(s, workspaceId), tabId, toGroupId, toIndex)
        }
      })),

    moveTabToNewGroup: (workspaceId, tabId) =>
      set((s) => ({
        rowsByWorkspace: {
          ...s.rowsByWorkspace,
          [workspaceId]: moveTabToNewGroup(rowOf(s, workspaceId), tabId, nextGroupId())
        }
      })),

    setGroupBoundary: (workspaceId, index, leftFraction) =>
      set((s) => ({
        rowsByWorkspace: {
          ...s.rowsByWorkspace,
          [workspaceId]: setBoundary(rowOf(s, workspaceId), index, leftFraction)
        }
      })),

    setLayout: (patch) => set((s) => ({ layout: { ...s.layout, ...patch } })),

    setPluginState: (workspaceId, pluginId, patch) =>
      set((s) => {
        const forWorkspace = s.pluginStateByWorkspace[workspaceId] ?? {}
        return {
          pluginStateByWorkspace: {
            ...s.pluginStateByWorkspace,
            [workspaceId]: {
              ...forWorkspace,
              [pluginId]: { ...forWorkspace[pluginId], ...patch }
            }
          }
        }
      }),

    setActivity: (workspaceId, activity) =>
      set((s) => ({ activityByWorkspace: { ...s.activityByWorkspace, [workspaceId]: activity } })),

    setPaneWorking: (paneId, program) => set((s) => ({ workingPanes: withEntry(s.workingPanes, paneId, program) })),
    setPaneUnseen: (paneId, program) => set((s) => ({ unseenPanes: withEntry(s.unseenPanes, paneId, program) })),
    forgetPane: (paneId) =>
      set((s) => ({
        workingPanes: withEntry(s.workingPanes, paneId, null),
        unseenPanes: withEntry(s.unseenPanes, paneId, null)
      })),

    setKeybindings: (keybindings) => set({ keybindings }),
    setSettings: (settings) => set({ settings }),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    setWorkspaceError: (workspaceError) => set({ workspaceError })
  }))
)

/** `map` with `key` set to `value`, or without it for null — the same object when nothing changes. */
function withEntry(map: Record<string, string>, key: string, value: string | null): Record<string, string> {
  if (value === null) {
    if (!(key in map)) return map
    const next = { ...map }
    delete next[key]
    return next
  }
  return map[key] === value ? map : { ...map, [key]: value }
}

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

/**
 * One workspace's row of groups, materialising the default rather than returning undefined.
 *
 * `noUncheckedIndexedAccess` is off in every tsconfig here, so `rowsByWorkspace[id]` types as a
 * GroupRow even when the key is absent and the first `.groups.map` would throw at runtime. Every
 * read goes through this, which is the only place the "a workspace always has at least one group"
 * invariant can actually be enforced.
 */
export function rowOf(state: Pick<AppState, 'rowsByWorkspace'>, workspaceId: WorkspaceId): GroupRow {
  return state.rowsByWorkspace[workspaceId] ?? EMPTY_ROW
}

export const useRow = (): GroupRow =>
  useApp((s) => (s.activeWorkspaceId ? rowOf(s, s.activeWorkspaceId) : EMPTY_ROW))

/** Every tab of the active workspace, across every group. For anything that counts or sweeps. */
export const useTabs = (): Tab[] => allTabs(useRow())

/**
 * The tab the user is looking at: the active group's active tab.
 *
 * Still singular, and still meaningful with several groups on screen — it is what a shortcut like
 * Cmd+W acts on and what the shell reports as "the current tab". Each group renders its OWN active
 * tab; this is only the shell-wide answer.
 */
export const useActiveTab = (): Tab | null =>
  useApp((s) => {
    if (!s.activeWorkspaceId) return null
    const row = rowOf(s, s.activeWorkspaceId)
    const group = row.groups.find((g) => g.id === row.activeGroupId) ?? row.groups[0]
    return group?.tabs.find((t) => t.id === group.activeTabId) ?? null
  })

/**
 * Stable identity so the selectors above cannot cause an infinite render loop.
 *
 * Frozen because it is shared by every workspace that has no row yet: a caller that mutated it
 * would corrupt the default for all of them, and that is a bug worth making impossible rather than
 * finding later.
 */
const EMPTY_ROW: GroupRow = Object.freeze(singleGroupRow('g-empty')) as GroupRow

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
            : ([...ids][0] ?? ''),
        ...(typeof tab.cwd === 'string' && tab.cwd ? { cwd: tab.cwd } : {})
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

/**
 * Repair a whole row of groups coming back from disk.
 *
 * `sanitizeTabs` handles what a tab is; this handles what a row is. Both live here rather than in
 * main's `migrate()` because repairing a tab needs the plugin manifests — `resolveViewType` and
 * `viewTypeForLegacyKind` — and main has none. The division is: main owns the SHAPE of the
 * document, the renderer owns its MEANING.
 *
 * Tolerant of a v2-shaped record even though main should never hand one over. The case is not
 * hypothetical: `pnpm dev` runs against the developer's real userData, so swapping branches puts
 * an older document in front of a newer build and the other way round.
 */
export function sanitizeGroups(raw: unknown, fallbackGroupId: () => GroupId): GroupRow {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const persisted = Array.isArray(record.groups) ? (record.groups as TabGroup[]) : null

  // A v2 record, or no record at all: one group holding whatever was there.
  if (!persisted) {
    const row = singleGroupRow(fallbackGroupId(), sanitizeTabs(record.tabs))
    const activeTabId = typeof record.activeTabId === 'string' ? record.activeTabId : null
    return activeTabId ? activateTabInRow(row, activeTabId) : row
  }

  const seen = new Set<GroupId>()
  const groups: TabGroup[] = []
  for (const group of persisted) {
    const tabs = sanitizeTabs((group as { tabs?: unknown })?.tabs)
    if (tabs.length === 0) continue
    // Duplicate ids would make two groups indistinguishable to every lookup in groups.ts, and the
    // one that lost would be unreachable — no way to focus it, no way to close it.
    const id = typeof group?.id === 'string' && !seen.has(group.id) ? group.id : fallbackGroupId()
    seen.add(id)
    const wanted = group?.activeTabId
    groups.push({
      id,
      tabs,
      activeTabId: tabs.some((t) => t.id === wanted) ? wanted! : (tabs[0]?.id ?? null)
    })
  }

  // The row is never empty: an empty one has nowhere to put the next file the user opens.
  if (groups.length === 0) return singleGroupRow(fallbackGroupId())

  const sizes = Array.isArray(record.groupSizes) ? (record.groupSizes as number[]) : []
  const activeGroupId = typeof record.activeGroupId === 'string' ? record.activeGroupId : ''
  return {
    groups,
    // A wrong-length or missing size array is repaired rather than trusted: groups and sizes are
    // parallel arrays on disk, and nothing stops a hand-edited document from disagreeing.
    sizes: sizes.length === groups.length ? sizes : groups.map(() => 1 / groups.length),
    activeGroupId: groups.some((g) => g.id === activeGroupId) ? activeGroupId : groups[0]!.id
  }
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
export function newTerminalTab(): TerminalTab {
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

/**
 * A fresh group id.
 *
 * The `grp_` prefix can never collide with `g0`, which is what main's v2 -> v3 migration names the
 * single group it wraps an old tab list in — a collision there would make a migrated group
 * indistinguishable from one created in this session.
 */
let groupSeq = 0
export const nextGroupId = (): GroupId => `grp_${++groupSeq}_${Date.now().toString(36)}`

/**
 * Which tab a split copy came from, remembered just long enough for the new pane to ask.
 *
 * A module Map and not a field on `Tab`: a field would be written to workspaces.json and would
 * name a dead tab after a restart. A viewer that keeps per-tab state — the PDF reader's scroll
 * position and zoom, keyed by tab id — reads this on first mount so that splitting while on page
 * 143 gives you page 143 in the new column, not page 1 of the same document.
 *
 * Entries are consumed once. Nothing is ever the copy of a copy of a copy, and an entry that is
 * never claimed is one string per split for the life of the window.
 */
const duplicateOrigin = new Map<TabId, TabId>()

export function rememberDuplicate(copyId: TabId, originId: TabId): void {
  duplicateOrigin.set(copyId, originId)
}

/** The tab this one was split from, if it was, and only the first time anybody asks. */
export function takeDuplicateOrigin(tabId: TabId): TabId | null {
  const origin = duplicateOrigin.get(tabId) ?? null
  duplicateOrigin.delete(tabId)
  return origin
}
export const nextWorkspaceId = (): WorkspaceId => `ws_${Date.now().toString(36)}`
