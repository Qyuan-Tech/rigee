import { useCallback, useEffect, useRef, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { TabStrip } from './components/TabStrip'
import { CenterPane } from './components/CenterPane'
import { ScmPanel } from './components/ScmPanel'
import { StatusBar } from './components/StatusBar'
import { Splitter } from './components/Splitter'
import { rpc } from './ipc'
import { isMac } from './ipc'
import { useApp } from './store'
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
      store.setActiveWorkspace(
        state.activeWorkspaceId ?? persisted[0]?.id ?? SCRATCH_WORKSPACE_ID
      )
      // Restore per-workspace tabs and the panel layout of the active workspace.
      for (const [wsId, ui] of Object.entries(state.ui)) {
        useApp.setState((s) => ({
          tabsByWorkspace: { ...s.tabsByWorkspace, [wsId]: ui.tabs },
          activeTabByWorkspace: { ...s.activeTabByWorkspace, [wsId]: ui.activeTabId }
        }))
      }
      const activeUi = state.activeWorkspaceId ? state.ui[state.activeWorkspaceId] : undefined
      if (activeUi) store.setLayout(activeUi.layout)
      store.setReady(true)
    })()
    return () => { cancelled = true }
  }, [])

  const onLeftDrag = useCallback(
    (dx: number, startWidth: number) => {
      setLayout({ leftWidth: clamp(startWidth + dx, 160, 560) })
    },
    [setLayout]
  )
  const onRightDrag = useCallback(
    (dx: number, startWidth: number) => {
      setLayout({ rightWidth: clamp(startWidth - dx, 200, 640) })
    },
    [setLayout]
  )

  if (!ready) return <Splash />

  const leftW = layout.leftCollapsed ? 0 : layout.leftWidth
  const rightW = layout.rightCollapsed ? 0 : layout.rightWidth

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: `var(--titlebar-h) 1fr var(--statusbar-h)`,
        height: '100%'
      }}
    >
      <TitleBar />

      <div style={{ display: 'flex', minHeight: 0, minWidth: 0 }}>
        {leftW > 0 && (
          <>
            <div style={{ width: leftW, flex: '0 0 auto', minWidth: 0, background: 'var(--bg-elevated)' }}>
              <Sidebar />
            </div>
            <Splitter orientation="vertical" onDrag={onLeftDrag} value={layout.leftWidth} />
          </>
        )}

        <div style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          <TabStrip />
          <CenterPane />
        </div>

        {rightW > 0 && (
          <>
            <Splitter orientation="vertical" onDrag={onRightDrag} value={layout.rightWidth} />
            <div style={{ width: rightW, flex: '0 0 auto', minWidth: 0, background: 'var(--bg-elevated)' }}>
              <ScmPanel />
            </div>
          </>
        )}
      </div>

      <StatusBar />
    </div>
  )
}

function TitleBar(): React.ReactElement {
  // On macOS the traffic lights are inset over this strip, so keep the left side clear.
  return (
    <div
      style={{
        height: 'var(--titlebar-h)',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: isMac() ? 78 : 10,
        paddingRight: 10,
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-elevated)',
        WebkitAppRegion: 'drag'
      } as React.CSSProperties}
    >
      <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>onestop</span>
    </div>
  )
}

function Splash(): React.ReactElement {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--fg-muted)' }}>
      loading…
    </div>
  )
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Persist layout and tabs on change, coalesced so dragging a splitter does not hammer the disk. */
export function usePersistence(): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [, force] = useState(0)
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
          force((n) => n + 1)
        }, 400)
      }
    )
    return () => {
      unsub()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])
}
