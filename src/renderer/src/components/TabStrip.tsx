import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { canDuplicate, groupById } from '../groups'
import { CloseIcon, FileIcon, ICONS, SplitIcon, TerminalIcon } from '../icons'
import { ensurePlugin } from '../plugins/activate'
import { tabFactory } from '../plugins/bindings'
import {
  creatableTabs,
  displayNameOf,
  iconFor,
  isDocumentViewType,
  isDuplicableViewType,
  ownerOf
} from '../plugins/registry'
import { closeTabsSafely } from '../editing'
import { newTerminalTab, nextTabId, useActiveWorkspace, useApp, useRow } from '../store'
import { isFileTab, tabsToClose } from '../tabs'
import type { GroupId, Tab, TabId } from '@shared/types'

/**
 * A tab's icon, asked for by name in the owning plugin's manifest.
 *
 * Manifest data only — looking this up must never activate anything, or the strip would load
 * every plugin whose tab is merely restored from disk.
 */
/** Stable identity, so a group that has not been created yet cannot cause a render loop. */
const EMPTY_TABS: Tab[] = []

function TabIcon({ tab }: { tab: Tab }): React.ReactElement {
  if (tab.kind === 'terminal') return <TerminalIcon size={13} />
  const name = iconFor(tab.kind === 'editor' ? tab.viewType : tab.viewType)
  const Icon = name ? ICONS[name] : FileIcon
  return <Icon size={13} />
}

/**
 * The strip belonging to ONE editor group.
 *
 * Everything it does is scoped to that group: which tabs it shows, which one is active, where a new
 * terminal goes, and what "Close Other Files" reaches. That scoping is the whole difference from
 * the single strip this replaced — with two groups on screen, a bulk close that swept both would be
 * astonishing, and VS Code scopes it the same way.
 */
export function TabStrip({ groupId }: { groupId: GroupId }): React.ReactElement {
  const workspace = useActiveWorkspace()
  const row = useRow()
  const group = groupById(row, groupId)
  const tabs = group?.tabs ?? EMPTY_TABS
  const activeId = group?.activeTabId ?? null
  const isActiveGroup = row.activeGroupId === groupId

  const setActiveTab = useApp((s) => s.setActiveTab)
  // Every close from the strip goes through the check for unsaved changes.
  const closeTab = (workspaceId: string, tabId: TabId): void => { void closeTabsSafely(workspaceId, [tabId]) }
  const closeTabs = (workspaceId: string, tabIds: TabId[]): void => { void closeTabsSafely(workspaceId, tabIds) }
  const dirtyFiles = useApp((s) => s.dirtyFiles)
  const openTab = useApp((s) => s.openTab)
  const moveTab = useApp((s) => s.moveTab)
  const splitTab = useApp((s) => s.splitTab)

  const activeTab = tabs.find((t) => t.id === activeId) ?? null
  const dragFrom = useRef<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: TabId } | null>(null)

  useEffect(() => {
    if (!menu) return
    const dismiss = (): void => setMenu(null)
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [menu])

  // A tab can vanish while its menu is open — a shell exiting closes its terminal tab, and the
  // SCM panel drops a diff tab when the file stops differing.
  useEffect(() => {
    if (menu && !tabs.some((t) => t.id === menu.tabId)) setMenu(null)
  }, [menu, tabs])

  const addTerminal = useCallback(() => {
    if (!workspace) return
    openTab(workspace.id, newTerminalTab(), groupId)
  }, [groupId, openTab, workspace])

  const split = useCallback(() => {
    if (workspace) splitTab(workspace.id, groupId)
  }, [groupId, splitTab, workspace])

  /**
   * Open a fresh tab of a plugin-owned type.
   *
   * The button comes from the manifest, so it exists before the plugin does; pressing it is the
   * first thing that loads the plugin, and only then can it say what an empty one of these looks
   * like. Hence activate-then-ask rather than a description in the manifest: "a new browser tab
   * starts at Google" is the plugin's business, not the shell's.
   */
  const addPluginTab = useCallback(
    async (viewType: string) => {
      const owner = ownerOf(viewType)
      if (!owner) return
      await ensurePlugin(owner)
      const create = tabFactory(viewType)
      if (!create) return
      // Re-read the workspace AFTER the await. The first press of this button fetches cordis, the
      // plugin host and the plugin's chunk, which takes long enough to switch workspaces in — and
      // the closed-over id would then put the tab in the workspace the user just left, where it
      // silently becomes the active tab. Worse, if that workspace was closed, `openTab` would
      // recreate its entries in a store that had just deleted them.
      // Re-read the GROUP as well, and not just the workspace: a group can be closed while a
      // plugin chunk loads, and opening into one that is gone is a button that does nothing.
      const state0 = useApp.getState()
      const workspaceId = state0.activeWorkspaceId
      if (!workspaceId) return
      const stillThere = groupById(state0.rowsByWorkspace[workspaceId] ?? row, groupId)
      const { title, state, key } = create()
      openTab(
        workspaceId,
        { id: nextTabId(), kind: 'custom', title, pinned: false, viewType, state, key },
        stillThere ? groupId : undefined
      )
    },
    [groupId, openTab, row]
  )

  if (!workspace) return <div className="tabstrip" />

  return (
    <div
      className={`tabstrip${isActiveGroup ? '' : ' tabstrip--inactive'}`}
      // A tab dropped on the strip's empty space joins this group at the end. Without it, the only
      // drop target is another tab, so an empty group could never receive anything.
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const tabId = e.dataTransfer.getData('text/rigee-tab')
        if (tabId) moveTab(workspace.id, tabId, groupId, tabs.length)
        dragFrom.current = null
      }}
    >
      {tabs.map((tab, i) => (
        <div
          key={tab.id}
          draggable
          className={`tab${tab.id === activeId ? ' tab--active' : ''}`}
          // The tab id travels on the drag, not just the index: a drop may land in ANOTHER group,
          // where an index from this strip would mean something entirely different.
          onDragStart={(e) => {
            dragFrom.current = i
            e.dataTransfer.setData('text/rigee-tab', tab.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.stopPropagation()
            const dragged = e.dataTransfer.getData('text/rigee-tab')
            if (dragged) moveTab(workspace.id, dragged, groupId, i)
            dragFrom.current = null
          }}
          onMouseDown={(e) => {
            if (e.button === 1) { e.preventDefault(); closeTab(workspace.id, tab.id) }
            else setActiveTab(workspace.id, tab.id)
          }}
          onContextMenu={(e) => {
            // There is no useful default menu on the strip, so swallow it either way.
            e.preventDefault()
            if (!isFileTab(tab, isDocumentViewType)) return
            // Select as well as target. Partly because acting on a tab you cannot see is
            // disorienting, but mostly because a visible browser tab is a native WebContentsView
            // composited ON TOP of this whole page: the menu would be drawn underneath it and
            // simply not appear. Selecting a file tab hides every browser view (see CenterPane).
            setActiveTab(workspace.id, tab.id)
            setMenu({ x: e.clientX, y: e.clientY, tabId: tab.id })
          }}
          title={tabTooltip(tab)}
        >
          <span className="tab__icon"><TabIcon tab={tab} /></span>
          <span className="tab__label">{tab.title}</span>
          <button
            className={`tab__close${tab.kind === 'editor' && dirtyFiles[tab.filePath] ? ' tab__close--dirty' : ''}`}
            onClick={(e) => { e.stopPropagation(); closeTab(workspace.id, tab.id) }}
            title={tab.kind === 'editor' && dirtyFiles[tab.filePath] ? 'Unsaved changes — close tab' : 'Close tab'}
          >
            <CloseIcon size={11} />
            <span className="tab__dirty" aria-hidden="true" />
          </button>
        </div>
      ))}

      <div className="tabstrip__actions">
        <button className="icon-button" onClick={addTerminal} title="New terminal">
          <TerminalIcon size={14} />
        </button>
        {creatableTabs().map((c) => {
          const Icon = c.icon ? ICONS[c.icon] : FileIcon
          return (
            <button
              key={c.viewType}
              className="icon-button"
              // A failed activation must say so. `void` on its own leaves an unhandled rejection
              // and a button that reads as dead.
              onClick={() =>
                addPluginTab(c.viewType).catch((e: unknown) =>
                  console.error(`[tabs] could not open ${c.viewType}`, e)
                )
              }
              title={c.creatable?.label ?? c.displayName}
            >
              <Icon size={14} />
            </button>
          )
        })}
        <button
          className="icon-button"
          onClick={split}
          disabled={!activeTab}
          // The truth per kind, because the two behaviours look different on screen and a button
          // that says "split" while moving your terminal away is a small betrayal.
          title={
            activeTab && !canDuplicate(activeTab, isDuplicableViewType)
              ? 'Move to a new group'
              : 'Split right'
          }
        >
          <SplitIcon size={14} />
        </button>
      </div>

      {menu && (
        <TabMenu
          x={menu.x}
          y={menu.y}
          tabs={tabs}
          tabId={menu.tabId}
          onClose={(ids) => { setMenu(null); closeTabs(workspace.id, ids) }}
        />
      )}
    </div>
  )
}

function TabMenu({
  x,
  y,
  tabs,
  tabId,
  onClose
}: {
  x: number
  y: number
  tabs: Tab[]
  tabId: TabId
  onClose: (ids: TabId[]) => void
}): React.ReactElement | null {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // Keep the menu on screen. useLayoutEffect rather than useEffect so the corrected position is
  // committed before the browser paints — with useEffect the menu would flash at the edge first.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4))
    })
  }, [x, y])

  if (!tabs.some((t) => t.id === tabId)) return null

  const others = tabsToClose(tabs, tabId, 'others', isDocumentViewType)
  const toRight = tabsToClose(tabs, tabId, 'right', isDocumentViewType)

  return (
    <div className="menu" ref={ref} style={pos} onMouseDown={(e) => e.stopPropagation()}>
      <button className="menu__item" onClick={() => onClose([tabId])}>
        <span>Close</span>
      </button>
      <button className="menu__item" disabled={others.length === 0} onClick={() => onClose(others)}>
        <span>Close Other Files</span>
      </button>
      <button className="menu__item" disabled={toRight.length === 0} onClick={() => onClose(toRight)}>
        <span>Close Files to the Right</span>
      </button>
      <div className="menu__sep" />
      {/* Named for what it does. "Close All" above a surviving terminal tab would be a lie. */}
      <button
        className="menu__item"
        onClick={() => onClose(tabsToClose(tabs, tabId, 'all', isDocumentViewType))}
      >
        <span>Close All Files</span>
      </button>
    </div>
  )
}

function tabTooltip(tab: Tab): string {
  switch (tab.kind) {
    case 'editor': {
      const viewer = tab.viewType ? displayNameOf(tab.viewType) : null
      return viewer ? `${tab.filePath} — ${viewer}` : tab.filePath
    }
    case 'custom': {
      // The plugin's own tooltip first: a diff's file path, a page's URL. The shell cannot read
      // either out of an opaque state bag, and falling back to the type name alone would have made
      // every diff tab hover as "Diff" — which is what the strip already says.
      const name = displayNameOf(tab.viewType) ?? tab.viewType
      return tab.tooltip ? `${tab.tooltip} — ${name}` : name
    }
    case 'terminal':
      return 'terminal'
  }
}
