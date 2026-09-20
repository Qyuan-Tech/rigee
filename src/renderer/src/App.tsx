import { useCallback, useEffect, useRef, useState } from 'react'
import { Sidebar } from './components/Sidebar'
import { TabStrip } from './components/TabStrip'
import { CenterPane } from './components/CenterPane'
import { ScmPanel } from './components/ScmPanel'
import { StatusBar } from './components/StatusBar'
import { Splitter } from './components/Splitter'
import { AuthDialog } from './components/AuthDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { isMac, rpc } from './ipc'
import { GearIcon } from './icons'
import { newTerminalTab, sanitizeTabs, useActiveWorkspace, useApp } from './store'
import {
  SCRATCH_WORKSPACE_ID,
  scratchWorkspace,
  type PersistedState,
  type WorkspaceUiState
} from '@shared/types'

export function App(): React.ReactElement {
  const ready = useApp((s) => s.ready)
  const [settingsOpen, setSettingsOpen] = useState(false)
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
      if (state.keybindings) store.setKeybindings(state.keybindings)
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
      <TitleBar onSettings={() => setSettingsOpen(true)} />

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
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

function TitleBar({ onSettings }: { onSettings: () => void }): React.ReactElement {
  const workspace = useActiveWorkspace()
  return (
    <div className="titlebar" style={{ paddingLeft: isMac() ? 80 : 12 }}>
      <span className="titlebar__brand">
        <span className="titlebar__mark" />
        onestop
      </span>
      {workspace && <span className="titlebar__context">{workspace.name}</span>}
      <button
        className="icon-button"
        title="Key bindings"
        onClick={onSettings}
        style={{ marginLeft: 'auto', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <GearIcon size={14} />
      </button>
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

/**
 * Persist open tabs, split layouts and panel sizes.
 *
 * Every workspace is written, not just the active one. Saving only the active workspace loses the
 * others: switching changes activeWorkspaceId, so the next save writes the NEW workspace and the
 * one just left behind never reaches disk with its latest tabs.
 *
 * Three triggers, because each covers a case the others miss: a debounce catches ordinary edits,
 * an interval catches a session that sits open for hours and then crashes or loses power, and
 * beforeunload catches the close itself.
 */
const SAVE_DEBOUNCE_MS = 400
const SAVE_INTERVAL_MS = 15_000

function usePersistence(): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const save = useCallback(() => {
    const s = useApp.getState()
    if (!s.ready) return // never write over a good document with a half-loaded one

    const ui: Record<string, WorkspaceUiState> = {}
    for (const ws of s.workspaces) {
      ui[ws.id] = {
        tabs: s.tabsByWorkspace[ws.id] ?? [],
        activeTabId: s.activeTabByWorkspace[ws.id] ?? null,
        layout: s.layout,
        expandedDirs: []
      }
    }
    rpc['state:saveAllUi']({ ui }).catch((e: unknown) => console.error('[persist] saveAllUi failed', e))
    rpc['state:saveWorkspaces']({
      workspaces: s.workspaces.filter((w) => w.id !== SCRATCH_WORKSPACE_ID),
      activeWorkspaceId: s.activeWorkspaceId
    }).catch((e: unknown) => console.error('[persist] saveWorkspaces failed', e))
  }, [])

  useEffect(() => {
    const schedule = (): void => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(save, SAVE_DEBOUNCE_MS)
    }

    const unsub = useApp.subscribe(
      (s) =>
        [s.tabsByWorkspace, s.activeTabByWorkspace, s.layout, s.activeWorkspaceId, s.workspaces] as const,
      schedule
    )
    const interval = setInterval(save, SAVE_INTERVAL_MS)
    // Synchronous on the way out: a debounce that has not fired yet would be lost.
    window.addEventListener('beforeunload', save)

    return () => {
      unsub()
      clearInterval(interval)
      window.removeEventListener('beforeunload', save)
      if (timer.current) clearTimeout(timer.current)
      save()
    }
  }, [save])
}
