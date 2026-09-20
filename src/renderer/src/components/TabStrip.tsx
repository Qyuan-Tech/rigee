import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CloseIcon, DiffIcon, FileIcon, GlobeIcon, TerminalIcon } from '../icons'
import { newTerminalTab, nextTabId, useActiveWorkspace, useApp, useTabs } from '../store'
import { isFileTab, tabsToClose } from '../tabs'
import type { Tab, TabId } from '@shared/types'

function TabIcon({ kind }: { kind: Tab['kind'] }): React.ReactElement {
  switch (kind) {
    case 'terminal':
      return <TerminalIcon size={13} />
    case 'editor':
      return <FileIcon size={13} />
    case 'diff':
      return <DiffIcon size={13} />
    case 'browser':
      return <GlobeIcon size={13} />
  }
}

export function TabStrip(): React.ReactElement {
  const workspace = useActiveWorkspace()
  const tabs = useTabs()
  const activeId = useApp((s) =>
    s.activeWorkspaceId ? s.activeTabByWorkspace[s.activeWorkspaceId] : null
  )
  const setActiveTab = useApp((s) => s.setActiveTab)
  const closeTab = useApp((s) => s.closeTab)
  const closeTabs = useApp((s) => s.closeTabs)
  const openTab = useApp((s) => s.openTab)
  const reorderTabs = useApp((s) => s.reorderTabs)

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
    openTab(workspace.id, newTerminalTab())
  }, [openTab, workspace])

  const addBrowser = useCallback(() => {
    if (!workspace) return
    openTab(workspace.id, {
      id: nextTabId(), kind: 'browser', title: 'new tab', pinned: false,
      url: 'https://www.google.com', viewId: '',
      canGoBack: false, canGoForward: false, loading: false, faviconDataUrl: null
    })
  }, [openTab, workspace])

  if (!workspace) return <div className="tabstrip" />

  return (
    <div className="tabstrip">
      {tabs.map((tab, i) => (
        <div
          key={tab.id}
          draggable
          className={`tab${tab.id === activeId ? ' tab--active' : ''}`}
          onDragStart={() => { dragFrom.current = i }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (dragFrom.current !== null) reorderTabs(workspace.id, dragFrom.current, i)
            dragFrom.current = null
          }}
          onMouseDown={(e) => {
            if (e.button === 1) { e.preventDefault(); closeTab(workspace.id, tab.id) }
            else setActiveTab(workspace.id, tab.id)
          }}
          onContextMenu={(e) => {
            // There is no useful default menu on the strip, so swallow it either way.
            e.preventDefault()
            if (!isFileTab(tab)) return
            // Select as well as target. Partly because acting on a tab you cannot see is
            // disorienting, but mostly because a visible browser tab is a native WebContentsView
            // composited ON TOP of this whole page: the menu would be drawn underneath it and
            // simply not appear. Selecting a file tab hides every browser view (see CenterPane).
            setActiveTab(workspace.id, tab.id)
            setMenu({ x: e.clientX, y: e.clientY, tabId: tab.id })
          }}
          title={tabTooltip(tab)}
        >
          <span className="tab__icon"><TabIcon kind={tab.kind} /></span>
          <span className="tab__label">{tab.title}</span>
          <button
            className="tab__close"
            onClick={(e) => { e.stopPropagation(); closeTab(workspace.id, tab.id) }}
            title="Close tab"
          >
            <CloseIcon size={11} />
          </button>
        </div>
      ))}

      <div className="tabstrip__actions">
        <button className="icon-button" onClick={addTerminal} title="New terminal">
          <TerminalIcon size={14} />
        </button>
        <button className="icon-button" onClick={addBrowser} title="New browser tab">
          <GlobeIcon size={14} />
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

  const others = tabsToClose(tabs, tabId, 'others')
  const toRight = tabsToClose(tabs, tabId, 'right')

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
      <button className="menu__item" onClick={() => onClose(tabsToClose(tabs, tabId, 'all'))}>
        <span>Close All Files</span>
      </button>
    </div>
  )
}

function tabTooltip(tab: Tab): string {
  switch (tab.kind) {
    case 'editor':
    case 'diff':
      return tab.filePath
    case 'browser':
      return tab.url
    case 'terminal':
      return 'terminal'
  }
}
