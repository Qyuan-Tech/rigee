import { useCallback, useEffect, useRef } from 'react'
import { Sidebar } from './components/Sidebar'
import { TabStrip } from './components/TabStrip'
import { CenterPane } from './components/CenterPane'
import { ScmPanel } from './components/ScmPanel'
import { StatusBar } from './components/StatusBar'
import { Splitter } from './components/Splitter'
import { AuthDialog } from './components/AuthDialog'
import { isMac, rpc } from './ipc'
import { newTerminalTab, sanitizeTabs, useActiveWorkspace, useApp } from './store'
import { SCRATCH_WORKSPACE_ID, scratchWorkspace, type PersistedState } from '@shared/types'

export function App(): React.ReactElement {
  const ready = useApp((s) => s.ready)
  const layout = useApp((s) => s.layout)
  const setLayout = useApp((s) => s.setLayout)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [state, platform] = await Promise.all([
        rpc['state:load']() as Promise<PersistedState>,
        rpc['app:getPlatformInfo']()
      ])
      if (cancelled) return
      const store = useApp.getState()

      // Scratch is synthesised, never loaded: it must exist even on a first run, and its
      // definition should follow the app rather than whatever was persisted long ago.
      const persisted = state.workspaces.filter((w) => w.id !== SCRATCH_WORKSPACE_ID)
      store.setWorkspaces([scratchWorkspace(platform.homeDir), ...persisted])
      store.setActiveWorkspace(state.activeWorkspaceId ?? persisted[0]?.id ?? SCRATCH_WORKSPACE_ID)

      for (const [wsId, ui] of Object.entries(state.ui)) {
        // Tabs on disk may predate the current shape; repair or drop them rather than render one.
        const tabs = sanitizeTabs(ui.tabs)
        const ids = new Set(tabs.map((t) => t.id))
        useApp.setState((s) => ({
          tabsByWorkspace: { ...s.tabsByWorkspace, [wsId]: tabs },
          activeTabByWorkspace: {
            ...s.activeTabByWorkspace,
            [wsId]: ui.activeTabId && ids.has(ui.activeTabId) ? ui.activeTabId : (tabs[0]?.id ?? null)
          }
        }))
      }
      const activeUi = state.activeWorkspaceId ? state.ui[state.activeWorkspaceId] : undefined
      if (activeUi) store.setLayout(activeUi.layout)
      store.setReady(true)
    })()
    return () => { cancelled = true }
  }, [])

  useShortcuts()
  usePersistence()

  const onLeftDrag = useCallback(
    (dx: number, startWidth: number) => setLayout({ leftWidth: clamp(startWidth + dx, 180, 560) }),
    [setLayout]
  )
  const onRightDrag = useCallback(
    (dx: number, startWidth: number) => setLayout({ rightWidth: clamp(startWidth - dx, 220, 680) }),
    [setLayout]
  )

  if (!ready) return <Splash />

  const leftW = layout.leftCollapsed ? 0 : layout.leftWidth
  const rightW = layout.rightCollapsed ? 0 : layout.rightWidth

  return (
    <div className="shell">
      <TitleBar />

      <div className="body">
        {leftW > 0 && (
          <>
            <div className="pane" style={{ width: leftW }}>
              <Sidebar />
            </div>
            <Splitter orientation="vertical" onDrag={onLeftDrag} value={layout.leftWidth} />
          </>
        )}

        <div className="center">
          <TabStrip />
          <CenterPane />
        </div>

        {rightW > 0 && (
          <>
            <Splitter orientation="vertical" onDrag={onRightDrag} value={layout.rightWidth} />
            <div className="pane" style={{ width: rightW }}>
              <ScmPanel />
            </div>
          </>
        )}
      </div>

      <StatusBar />
      <AuthDialog />
    </div>
  )
}

function TitleBar(): React.ReactElement {
  const workspace = useActiveWorkspace()
  return (
    <div className="titlebar" style={{ paddingLeft: isMac() ? 80 : 12 }}>
      <span className="titlebar__brand">
        <span className="titlebar__mark" />
        onestop
      </span>
      {workspace && <span className="titlebar__context">{workspace.name}</span>}
    </div>
  )
}

function Splash(): React.ReactElement {
  return (
    <div className="empty" style={{ height: '100%' }}>
      <div className="empty__mark" />
    </div>
  )
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Cmd/Ctrl shortcuts for the things worth reaching without the mouse. */
function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = isMac() ? e.metaKey : e.ctrlKey
      if (!mod) return
      const s = useApp.getState()
      const ws = s.activeWorkspaceId
      if (!ws) return

      if (e.key === 't') {
        e.preventDefault()
        s.openTab(ws, newTerminalTab())
      } else if (e.key === 'w') {
        e.preventDefault()
        const active = s.activeTabByWorkspace[ws]
        if (active) s.closeTab(ws, active)
      } else if (e.key === 'b') {
        e.preventDefault()
        s.setLayout({ leftCollapsed: !s.layout.leftCollapsed })
      } else if (e.key === 'g' && e.shiftKey) {
        e.preventDefault()
        s.setLayout({ rightCollapsed: !s.layout.rightCollapsed })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** Persist layout and tabs on change, coalesced so dragging a splitter does not hammer the disk. */
function usePersistence(): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const unsub = useApp.subscribe(
      (s) => [s.tabsByWorkspace, s.activeTabByWorkspace, s.layout, s.activeWorkspaceId] as const,
      () => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          const s = useApp.getState()
          if (!s.activeWorkspaceId) return
          void rpc['state:saveUi']({
            workspaceId: s.activeWorkspaceId,
            ui: {
              tabs: s.tabsByWorkspace[s.activeWorkspaceId] ?? [],
              activeTabId: s.activeTabByWorkspace[s.activeWorkspaceId] ?? null,
              layout: s.layout,
              expandedDirs: []
            }
          })
        }, 400)
      }
    )
    return () => {
      unsub()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])
}
