import { useCallback, useRef } from 'react'
import { canDuplicate, groupById, groupOfTab, type SplitDirection } from '../groups'
import { CloseIcon, FileIcon, ICONS, SplitDownIcon, SplitIcon, TerminalIcon } from '../icons'
import { ensurePlugin } from '../plugins/activate'
import { tabFactory } from '../plugins/bindings'
import {
  creatableTabs,
  displayNameOf,
  holdsEdits,
  iconFor,
  isDocumentViewType,
  isDuplicableViewType,
  ownerOf
} from '../plugins/registry'
import { popupMenu } from '../contextMenu'
import { closeTabsSafely } from '../editing'
import { leaves } from '../paneTree'
import { nextTabId, rowOf, useActiveWorkspace, useApp, useRow } from '../store'
import { isCloseCommand, isFileTab, tabsToClose } from '../tabs'
import { openTerminalTab } from '../terminals'
import type { GroupId, Tab, TabId, WorkspaceId } from '@shared/types'

/**
 * A tab's icon, asked for by name in the owning plugin's manifest.
 *
 * Manifest data only — looking this up must never activate anything, or the strip would load
 * every plugin whose tab is merely restored from disk.
 */
/** Stable identity, so a group that has not been created yet cannot cause a render loop. */
const EMPTY_TABS: Tab[] = []

/**
 * Which of the three things a tab is, for its colour: a terminal, a file, or a web page. Diffs and
 * PDFs are files; anything a plugin adds that is neither stays uncoloured.
 */
function tabKind(tab: Tab): 'terminal' | 'file' | 'web' | 'other' {
  if (tab.kind === 'terminal') return 'terminal'
  if (tab.kind === 'editor') return 'file'
  if (ownerOf(tab.viewType) === 'browser') return 'web'
  return isFileTab(tab, isDocumentViewType) || ownerOf(tab.viewType) === 'scm' ? 'file' : 'other'
}

function TabIcon({ tab }: { tab: Tab }): React.ReactElement {
  if (tab.kind === 'terminal') return <TerminalIcon size={13} />
  const name = iconFor(tab.kind === 'editor' ? tab.viewType : tab.viewType)
  const Icon = name ? ICONS[name] : FileIcon
  return <Icon size={13} />
}

/**
 * A tab's icon, or for a terminal with a pane at work a spinner in its place; and a dot on it for a
 * pane that has finished since the user last looked — which tab to open, once the side bar has said
 * which workspace (see paneWatch.ts).
 */
function TabStatusIcon({
  tab,
  working,
  unseen
}: {
  tab: Tab
  working: Record<string, string>
  unseen: Record<string, string>
}): React.ReactElement {
  const panes = tab.kind === 'terminal' ? leaves(tab.root).flatMap((l) => (l.paneId ? [l.paneId] : [])) : []
  const busy = panes.some((id) => id in working)
  const finished = panes.some((id) => id in unseen)
  return (
    <span className="tab__icon">
      {busy ? <span className="spinner" title="At work" /> : <TabIcon tab={tab} />}
      {finished && <span className="tab__finished" title="Finished since you last looked" />}
    </span>
  )
}

/**
 * The strip belonging to ONE editor group.
 *
 * Everything it does is scoped to that group: which tabs it shows, which one is active, where a new
 * terminal goes, and what "Close Others" reaches. That scoping is the whole difference from the
 * single strip this replaced — with two groups on screen, a bulk close that swept both would be
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
  const dirtyFiles = useApp((s) => s.dirtyFiles)
  const workingPanes = useApp((s) => s.workingPanes)
  const unseenPanes = useApp((s) => s.unseenPanes)
  const openTab = useApp((s) => s.openTab)
  const moveTab = useApp((s) => s.moveTab)
  const splitTab = useApp((s) => s.splitTab)

  const activeTab = tabs.find((t) => t.id === activeId) ?? null
  const dragFrom = useRef<number | null>(null)

  const addTerminal = useCallback(() => {
    if (workspace) openTerminalTab(workspace.id, { groupId })
  }, [groupId, workspace])

  const split = useCallback(
    (direction: SplitDirection) => {
      if (workspace) splitTab(workspace.id, groupId, direction)
    },
    [groupId, splitTab, workspace]
  )
  // The truth per kind, because the two behaviours look different on screen and a button that
  // says "split" while moving your terminal away is a small betrayal.
  const moves = activeTab !== null && !canDuplicate(activeTab, isDuplicableViewType)

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
          data-kind={tabKind(tab)}
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
            // There is no useful default menu on the strip.
            e.preventDefault()
            // Select as well as target: a command acting on a tab you cannot see is disorienting.
            setActiveTab(workspace.id, tab.id)
            void showTabMenu(workspace.id, tab.id, tabs)
          }}
          title={tabTooltip(tab)}
        >
          <TabStatusIcon tab={tab} working={workingPanes} unseen={unseenPanes} />
          <span className="tab__label">{tab.title}</span>
          <button
            className={`tab__close${unsaved(tab, dirtyFiles) ? ' tab__close--dirty' : ''}`}
            onClick={(e) => { e.stopPropagation(); closeTab(workspace.id, tab.id) }}
            title={unsaved(tab, dirtyFiles) ? 'Unsaved changes — close tab' : 'Close tab'}
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
          onClick={() => split('right')}
          disabled={!activeTab}
          title={moves ? 'Move to a new group' : 'Split right'}
        >
          <SplitIcon size={14} />
        </button>
        <button
          className="icon-button"
          onClick={() => split('down')}
          disabled={!activeTab}
          title={moves ? 'Move to a new group below' : 'Split down'}
        >
          <SplitDownIcon size={14} />
        </button>
      </div>
    </div>
  )
}

/**
 * A tab's context menu: the same commands on every kind of tab — terminal, page or file — as VS
 * Code has them. Greyed rather than left out when there is nothing for one to do, so the menu keeps
 * its shape from tab to tab.
 *
 * Native, and that is what lets terminals and pages have it at all. A browser tab's page is a
 * native view composited over the whole document and right-clicking a tab selects it, so a menu
 * drawn in the DOM opened underneath the page and never appeared; this menu used to be offered on
 * file tabs only for exactly that reason.
 */
async function showTabMenu(workspaceId: WorkspaceId, tabId: TabId, tabs: readonly Tab[]): Promise<void> {
  const none = (command: 'others' | 'right'): boolean => tabsToClose(tabs, tabId, command).length === 0
  const choice = await popupMenu([
    { kind: 'item', id: 'close', label: 'Close' },
    { kind: 'item', id: 'others', label: 'Close Others', enabled: !none('others') },
    { kind: 'item', id: 'right', label: 'Close to the Right', enabled: !none('right') },
    { kind: 'separator' },
    { kind: 'item', id: 'all', label: 'Close All' }
  ])
  if (!choice) return

  // Worked out again from the store as it is now, not from the strip the menu opened over: a menu
  // stays up as long as the user takes over it, and a shell can exit or a diff drop out meanwhile.
  const group = groupOfTab(rowOf(useApp.getState(), workspaceId), tabId)
  if (!group) return
  if (choice === 'close') void closeTabsSafely(workspaceId, [tabId])
  else if (isCloseCommand(choice)) void closeTabsSafely(workspaceId, tabsToClose(group.tabs, tabId, choice), { sweptFrom: tabId })
}

/** Whether a tab wears the unsaved dot: the file's own tab, never a preview of it. */
function unsaved(tab: Tab, dirtyFiles: Record<string, true>): boolean {
  return tab.kind === 'editor' && holdsEdits(tab.viewType) && dirtyFiles[tab.filePath] === true
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
