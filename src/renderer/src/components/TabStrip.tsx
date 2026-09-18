import { useCallback, useRef } from 'react'
import { nextTabId, useActiveWorkspace, useApp, useTabs } from '../store'
import type { Tab } from '@shared/types'

const ICONS: Record<Tab['kind'], string> = {
  terminal: '❯',
  editor: '◧',
  diff: '±',
  browser: '◎'
}

export function TabStrip(): React.ReactElement {
  const workspace = useActiveWorkspace()
  const tabs = useTabs()
  const activeId = useApp((s) => (s.activeWorkspaceId ? s.activeTabByWorkspace[s.activeWorkspaceId] : null))
  const setActiveTab = useApp((s) => s.setActiveTab)
  const closeTab = useApp((s) => s.closeTab)
  const openTab = useApp((s) => s.openTab)
  const reorderTabs = useApp((s) => s.reorderTabs)

  const dragFrom = useRef<number | null>(null)

  const addTerminal = useCallback(() => {
    if (!workspace) return
    openTab(workspace.id, {
      id: nextTabId(),
      kind: 'terminal',
      title: 'terminal',
      pinned: false,
      windowId: null,
      paneId: null
    })
  }, [openTab, workspace])

  const addBrowser = useCallback(() => {
    if (!workspace) return
    openTab(workspace.id, {
      id: nextTabId(),
      kind: 'browser',
      title: 'new tab',
      pinned: false,
      url: 'https://www.google.com',
      viewId: '',
      canGoBack: false,
      canGoForward: false,
      loading: false,
      faviconDataUrl: null
    })
  }, [openTab, workspace])

  if (!workspace) return <div style={{ height: 'var(--tabstrip-h)', borderBottom: '1px solid var(--border)' }} />

  return (
    <div
      style={{
        height: 'var(--tabstrip-h)',
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'stretch',
        background: 'var(--bg-elevated)',
        borderBottom: '1px solid var(--border)',
        overflowX: 'auto',
        overflowY: 'hidden'
      }}
    >
      {tabs.map((tab, i) => {
        const active = tab.id === activeId
        return (
          <div
            key={tab.id}
            draggable
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
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 8px 0 11px',
              minWidth: 110,
              maxWidth: 220,
              background: active ? 'var(--bg)' : 'transparent',
              borderRight: '1px solid var(--border)',
              borderTop: `1px solid ${active ? 'var(--accent)' : 'transparent'}`,
              color: active ? 'var(--fg-bright)' : 'var(--fg-muted)',
              cursor: 'pointer'
            }}
          >
            <span style={{ fontSize: 11, opacity: 0.8 }}>{ICONS[tab.kind]}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
              {tab.title}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(workspace.id, tab.id) }}
              style={{ opacity: 0.6, padding: '0 2px', lineHeight: 1 }}
              title="Close"
            >
              ×
            </button>
          </div>
        )
      })}

      <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '0 6px' }}>
        <button onClick={addTerminal} title="New terminal" style={btn}>❯</button>
        <button onClick={addBrowser} title="New browser tab" style={btn}>◎</button>
      </div>
    </div>
  )
}

const btn: React.CSSProperties = {
  width: 24,
  height: 22,
  borderRadius: 3,
  color: 'var(--fg-muted)',
  cursor: 'pointer'
}

function tabTooltip(tab: Tab): string {
  switch (tab.kind) {
    case 'editor':
    case 'diff':
      return tab.filePath
    case 'browser':
      return tab.url
    case 'terminal':
      return tab.paneId ? `tmux pane ${tab.paneId}` : 'terminal'
  }
}
