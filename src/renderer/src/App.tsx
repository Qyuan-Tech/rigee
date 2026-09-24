import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityBar } from './components/ActivityBar'
import { Sidebar } from './components/Sidebar'
import { CenterPane } from './components/CenterPane'
import { PluginOverlays, PluginViewSlot, slotLabel } from './components/PluginHost'
import { StatusBar } from './components/StatusBar'
import { Splitter } from './components/Splitter'
import { SettingsDialog } from './components/SettingsDialog'
import { isMac, rpc } from './ipc'
import { CollapseLeftIcon, CollapseRightIcon, GearIcon } from './icons'
import { activeGroup, allTabs } from './groups'
import { setDisabledPlugins, setDiskPlugins } from './plugins/registry'
import {
  nextGroupId,
  newTerminalTab,
  rowOf,
  sanitizeGroups,
  useActiveWorkspace,
  useApp
} from './store'
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
      // In parallel: main has both answers ready and the registry needs them before anything is
      // rendered from it.
      const [state, platform, installed] = await Promise.all([
        rpc['state:load']() as Promise<PersistedState>,
        rpc['app:getPlatformInfo'](),
        rpc['plugins:list']()
      ])
      if (cancelled) return
      const store = useApp.getState()

      // Both of these FIRST, before a single contribution table is read. A disabled plugin must
      // not have its icon in the activity bar for even one frame, and must not claim a file type
      // it is about to stop being able to open; an untrusted one must not claim anything at all,
      // because claiming a file type would mean the shell tries to open one with code the user
      // has not agreed to run.
      setDisabledPlugins(state.disabledPlugins ?? [])
      setDiskPlugins(
        installed.map((p) => ({
          manifest: p.manifest,
          trusted: p.trust.status === 'trusted',
          rendererUrl: p.rendererUrl
        }))
      )

      // Scratch is synthesised, never loaded: it must exist even on a first run, and its
      // definition should follow the app rather than whatever was persisted long ago.
      const persisted = state.workspaces.filter((w) => w.id !== SCRATCH_WORKSPACE_ID)
      store.setWorkspaces([scratchWorkspace(platform.homeDir), ...persisted])
      store.setActiveWorkspace(state.activeWorkspaceId ?? persisted[0]?.id ?? SCRATCH_WORKSPACE_ID)

      for (const [wsId, ui] of Object.entries(state.ui)) {
        // The row on disk may predate the current shape; repair it rather than render a broken
        // one. Written in ONE setState per workspace: the groups and their widths are a single
        // invariant, and a render landing between two writes would see a row it cannot lay out.
        useApp.setState((s) => ({
          rowsByWorkspace: { ...s.rowsByWorkspace, [wsId]: sanitizeGroups(ui, nextGroupId) },
          // Only when the record has one. Leaving it absent is what tells a plugin this
          // workspace has never been opened with it — which is how the explorer knows to start
          // with its roots expanded rather than as the user last left them.
          pluginStateByWorkspace: ui.pluginState
            ? { ...s.pluginStateByWorkspace, [wsId]: ui.pluginState }
            : s.pluginStateByWorkspace
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
  useScratchTerminal()

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
        {/*
          The rail is always there, collapsed or not — it is how you get the panel back, and a
          collapsed side bar with no way to reopen it but a keyboard shortcut is how VS Code's
          activity bar earns its width.
        */}
        <ActivityBar />

        {leftW > 0 && (
          <>
            <div className="pane" style={{ width: leftW }}>
              <Sidebar onCollapse={() => setLayout({ leftCollapsed: true })} />
              <PluginViewSlot slot="left" onCollapse={() => setLayout({ leftCollapsed: true })} />
            </div>
            <Splitter orientation="vertical" onDrag={onLeftDrag} value={layout.leftWidth} />
          </>
        )}

        <div className="center">
          <CenterPane />
        </div>

        {/*
          The right rail holds whatever plugins put there — source control today, and nothing the
          shell has to know about. An empty slot still renders the pane, so dragging the splitter
          and the collapse state behave the same whether or not a plugin ever fills it.
        */}
        {rightW > 0 ? (
          <>
            <Splitter orientation="vertical" onDrag={onRightDrag} value={layout.rightWidth} />
            <div className="pane" style={{ width: rightW }}>
              <PluginViewSlot slot="right" onCollapse={() => setLayout({ rightCollapsed: true })} />
            </div>
          </>
        ) : (
          <Rail
            side="right"
            label={slotLabel('right', 'Panel')}
            onExpand={() => setLayout({ rightCollapsed: false })}
          />
        )}
      </div>

      <StatusBar />
      <PluginOverlays />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

/** What a collapsed panel leaves behind: a strip you can click to bring it back. */
function Rail({
  side,
  label,
  onExpand
}: {
  side: 'left' | 'right'
  label: string
  onExpand: () => void
}): React.ReactElement {
  const Icon = side === 'left' ? CollapseRightIcon : CollapseLeftIcon
  return (
    <div
      className={`rail rail--${side}`}
      onClick={onExpand}
      title={`Show ${label.toLowerCase()}`}
      role="button"
    >
      <span className="rail__grip"><Icon size={13} /></span>
      <span className="rail__label">{label}</span>
    </div>
  )
}

function TitleBar({ onSettings }: { onSettings: () => void }): React.ReactElement {
  const workspace = useActiveWorkspace()
  return (
    <div className="titlebar" style={{ paddingLeft: isMac() ? 80 : 12 }}>
      <span className="titlebar__brand">
        <span className="titlebar__mark" />
        Rigee
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
        // The active group's active tab — the one the user is looking at. Closing it may take the
        // group with it, which `closeTabs` handles.
        const active = activeGroup(rowOf(s, ws)).activeTabId
        if (active) s.closeTab(ws, active)
      } else if (e.key === '\\') {
        // Cmd/Ctrl+\ is VS Code's Split Editor, and the fingers that reach for it are the same
        // ones this feature is for. The strip's button does the same thing with the mouse.
        e.preventDefault()
        s.splitTab(ws)
      } else if (e.key >= '1' && e.key <= '9') {
        // Cmd/Ctrl+1..9 jumps to a column, as VS Code does. Swallowed even when the column does
        // not exist: half-pressing your way to a group that is not there should do nothing, not
        // fall through to whatever the terminal would have made of the digit.
        e.preventDefault()
        const group = rowOf(s, ws).groups[Number(e.key) - 1]
        if (group) s.focusGroup(ws, group.id)
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

/**
 * Arriving at an empty Scratch opens a terminal.
 *
 * Scratch is the workspace with no folders: somewhere to run a shell and pick the directory
 * yourself, without opening a project first. Switching to it and being shown "Nothing open" is
 * the wrong answer to that — the switch had happened, it just did not look like it had.
 *
 * Keyed on ARRIVING rather than on the tab count being zero. Reacting to emptiness would respawn
 * a terminal the instant the user deliberately closed the last one, which is worse than the
 * problem it solves. Gated on `ready` so it cannot race the restore from disk and leave a stray
 * terminal beside the persisted ones.
 */
function useScratchTerminal(): void {
  const ready = useApp((s) => s.ready)
  const activeId = useApp((s) => s.activeWorkspaceId)
  const seen = useRef<string | null>(null)

  useEffect(() => {
    if (!ready) return
    const arrived = seen.current !== activeId
    seen.current = activeId
    if (!arrived || activeId !== SCRATCH_WORKSPACE_ID) return

    const s = useApp.getState()
    // Across every group, not just the active one: with the terminal sitting in the right-hand
    // column, counting only group 0 would spawn a second one on every arrival, forever.
    if (allTabs(rowOf(s, SCRATCH_WORKSPACE_ID)).length > 0) return
    s.openTab(SCRATCH_WORKSPACE_ID, newTerminalTab())
  }, [ready, activeId])
}

function usePersistence(): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const save = useCallback(() => {
    const s = useApp.getState()
    if (!s.ready) return // never write over a good document with a half-loaded one

    const ui: Record<string, WorkspaceUiState> = {}
    for (const ws of s.workspaces) {
      const row = rowOf(s, ws.id)
      ui[ws.id] = {
        groups: row.groups,
        activeGroupId: row.activeGroupId,
        // Genuinely per workspace, unlike `layout` — which is one global written into every
        // record and only ever read back from the active one.
        groupSizes: row.sizes,
        layout: s.layout,
        /*
         * Written only when there IS a record, never defaulted to {}.
         *
         * Absence means "no plugin has recorded anything for this workspace", which the explorer
         * reads as "never opened, so show the roots expanded". An empty record means the user
         * collapsed everything and is authoritative. Defaulting here turns the first into the
         * second on the very first save — so every workspace migrated from an older document
         * would open fully collapsed, for ever. `pnpm smoke:migrate` caught exactly this.
         */
        ...(s.pluginStateByWorkspace[ws.id] ? { pluginState: s.pluginStateByWorkspace[ws.id] } : {})
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
        [
          s.rowsByWorkspace,
          s.layout,
          s.activeWorkspaceId,
          s.workspaces,
          s.pluginStateByWorkspace
        ] as const,
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
