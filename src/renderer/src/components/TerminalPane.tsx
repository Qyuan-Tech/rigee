import { useEffect, useState } from 'react'
import { rpc } from '../ipc'
import type { TerminalTab } from '@shared/types'

/**
 * Terminal tab.
 *
 * Not wired up yet: the tmux control-mode client in main is still being built, so there is no
 * byte stream to attach an xterm instance to. This renders the detected tmux state so the gap is
 * visible rather than silently blank.
 *
 * When the client lands, this component will: loadXterm(), create one Terminal with the WebGL
 * renderer, register a sink via window.onestop.onTerminalData(workspaceId, ...) keyed by pane id,
 * and send keystrokes back through writeTerminal(). The Terminal instance is kept in a module
 * Map keyed by tab id, never in the store.
 */
export function TerminalPane({ tab }: { tab: TerminalTab }): React.ReactElement {
  const [info, setInfo] = useState<{ available: boolean; version: string | null } | null>(null)

  useEffect(() => {
    void rpc['app:getPlatformInfo']().then((i) =>
      setInfo({ available: i.tmuxAvailable, version: i.tmuxVersion })
    )
  }, [])

  return (
    <div
      style={{
        height: '100%',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        color: 'var(--fg-muted)',
        background: '#141414'
      }}
    >
      <div style={{ textAlign: 'center', lineHeight: 1.9 }}>
        <div style={{ color: 'var(--fg)', marginBottom: 8 }}>Terminal not connected</div>
        <div>
          {info === null
            ? 'checking for tmux…'
            : info.available
              ? `${info.version} detected`
              : 'tmux not found on PATH'}
        </div>
        <div>tmux control-mode client is not implemented yet</div>
        {tab.paneId && <div>pane {tab.paneId}</div>}
      </div>
    </div>
  )
}
