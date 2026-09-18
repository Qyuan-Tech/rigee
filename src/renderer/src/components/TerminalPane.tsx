import { useEffect, useRef, useState } from 'react'
import { rpc } from '../ipc'
import { ensureTerminal, writeToPane } from '../terminals'
import { useApp } from '../store'
import type { TerminalTab, TmuxConnectionState } from '@shared/types'
import '@xterm/xterm/css/xterm.css'

/**
 * A terminal tab: one xterm.js view onto one tmux pane.
 *
 * The Terminal instance lives in terminals.ts, not here. This component only parents its
 * element, binds the byte stream, and reports geometry.
 *
 * Bytes arrive over a MessagePort established once per workspace, already demultiplexed by pane
 * id and coalesced in main — never through ipcRenderer.
 */
export function TerminalPane({ tab }: { tab: TerminalTab }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const workspaceId = useApp((s) => s.activeWorkspaceId)
  const workspace = useApp((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null)
  const updateTab = useApp((s) => s.updateTab)
  const [status, setStatus] = useState<TmuxConnectionState>({ status: 'connecting' })

  useEffect(() => {
    if (!workspaceId || !workspace) return
    let cancelled = false
    let detachSink: (() => void) | null = null
    let resizeObserver: ResizeObserver | null = null

    void (async () => {
      const handle = await ensureTerminal(tab.id)
      if (cancelled) return

      // Re-parent the persistent element; on a tab switch this is all that happens.
      host.current?.appendChild(handle.element)
      handle.fit.fit()

      const cwd = workspace.folders[0]?.path ?? workspace.folders[0]?.repoRoot ?? '.'
      const connection = await rpc['tmux:connect']({
        workspaceId,
        sessionName: workspace.tmuxSessionName,
        cwd
      })
      if (cancelled) return
      setStatus(connection)
      if (connection.status !== 'connected') return

      // One MessagePort per workspace; requesting it again replaces the previous one.
      await rpc['terminal:requestPort']({ workspaceId })
      if (cancelled) return

      let paneId = tab.paneId
      if (!paneId) {
        // A terminal tab owns a tmux window; splits inside the tab become panes of that window.
        const { windowId } = await rpc['tmux:newWindow']({ workspaceId, cwd })
        if (cancelled) return
        const state = await rpc['tmux:listState']({ workspaceId })
        paneId = state.panes.find((p) => p.windowId === windowId)?.id ?? null
        if (paneId) updateTab(workspaceId, tab.id, { windowId, paneId })
      }
      if (!paneId || cancelled) return
      handle.paneId = paneId

      detachSink = window.onestop.onTerminalData(workspaceId, (pane, data) => {
        writeToPane(pane, data)
      })

      handle.term.onData((data) => {
        window.onestop.writeTerminal(workspaceId, paneId!, data)
      })

      const pushSize = (): void => {
        handle.fit.fit()
        void rpc['tmux:resizeClient']({
          workspaceId,
          cols: handle.term.cols,
          rows: handle.term.rows
        })
      }
      pushSize()
      if (host.current) {
        resizeObserver = new ResizeObserver(pushSize)
        resizeObserver.observe(host.current)
      }
      handle.term.focus()
    })()

    return () => {
      cancelled = true
      detachSink?.()
      resizeObserver?.disconnect()
      // The element stays alive in terminals.ts; only its parent link is dropped.
      const handle = host.current?.firstElementChild
      if (handle) host.current?.removeChild(handle)
    }
  }, [tab.id, tab.paneId, workspaceId, workspace, updateTab])

  return (
    <div style={{ position: 'relative', height: '100%', background: '#141414' }}>
      <div ref={host} style={{ position: 'absolute', inset: 0, padding: 4 }} />
      {status.status !== 'connected' && <Overlay status={status} />}
    </div>
  )
}

function Overlay({ status }: { status: TmuxConnectionState }): React.ReactElement {
  const message =
    status.status === 'connecting'
      ? 'attaching to tmux…'
      : status.status === 'unavailable'
        ? status.reason
        : status.status === 'failed'
          ? status.error
          : 'disconnected'

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        background: '#141414e0',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        color: status.status === 'connecting' ? 'var(--fg-muted)' : 'var(--git-deleted)',
        textAlign: 'center',
        padding: 24
      }}
    >
      {message}
    </div>
  )
}
