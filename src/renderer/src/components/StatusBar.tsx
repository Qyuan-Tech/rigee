import { useEffect, useState } from 'react'
import { rpc } from '../ipc'
import { useActiveWorkspace, useApp } from '../store'

export function StatusBar(): React.ReactElement {
  const workspace = useActiveWorkspace()
  const scm = useApp((s) => s.scm)
  const [tmux, setTmux] = useState<string | null>(null)

  useEffect(() => {
    void rpc['app:getPlatformInfo']().then((info) => {
      setTmux(info.tmuxAvailable ? info.tmuxVersion : 'tmux not found')
    })
  }, [])

  const repo = workspace?.folders.find((f) => f.repoRoot)?.repoRoot
  const status = repo ? scm[repo] : undefined
  const dirty = status ? status.staged.length + status.unstaged.length + status.untracked.length : 0

  return (
    <div
      style={{
        height: 'var(--statusbar-h)',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 10px',
        fontSize: 11,
        color: 'var(--fg-muted)',
        background: 'var(--bg-elevated)',
        borderTop: '1px solid var(--border)'
      }}
    >
      <span>{workspace ? workspace.name : 'no workspace'}</span>
      {status?.branch && (
        <span>
          {status.branch}
          {dirty > 0 ? ` · ${dirty}` : ''}
        </span>
      )}
      <span style={{ marginLeft: 'auto' }}>{tmux ?? '…'}</span>
    </div>
  )
}
