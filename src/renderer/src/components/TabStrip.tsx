import { useCallback, useRef } from 'react'
import { CloseIcon, DiffIcon, FileIcon, GlobeIcon, TerminalIcon } from '../icons'
import { newTerminalTab, nextTabId, useActiveWorkspace, useApp, useTabs } from '../store'
import type { Tab } from '@shared/types'

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
  const openTab = useApp((s) => s.openTab)
  const reorderTabs = useApp((s) => s.reorderTabs)

  const dragFrom = useRef<number | null>(null)

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
