import { useEffect, useState } from 'react'
import { rpc } from '../ipc'
import { BranchIcon, TerminalIcon } from '../icons'
import { useActiveWorkspace, useApp } from '../store'

export function StatusBar(): React.ReactElement {
  const workspace = useActiveWorkspace()
  const scm = useApp((s) => s.scm)
  const [shell, setShell] = useState<string | null>(null)

  useEffect(() => {
    void rpc['app:getPlatformInfo']().then((info) => setShell(info.shell))
  }, [])

  const repo = workspace?.folders.find((f) => f.repoRoot)?.repoRoot
  const status = repo ? scm[repo] : undefined
  const dirty = status
    ? status.staged.length + status.unstaged.length + status.untracked.length
    : 0

  return (
    <div className="statusbar">
      {workspace && <span className="statusbar__item">{workspace.name}</span>}

      {status && (
        <span className="statusbar__item">
          <BranchIcon size={12} />
          {status.branch ?? `detached @ ${status.detachedAt ?? '?'}`}
          {dirty > 0 && <span style={{ color: 'var(--git-modified)' }}>{dirty}</span>}
          {status.operation !== 'none' && (
            <span style={{ color: 'var(--git-conflict)' }}>{status.operation}</span>
          )}
        </span>
      )}

      <span className="statusbar__item" style={{ marginLeft: 'auto' }}>
        <TerminalIcon size={12} />
        <span>{shell ? shell.split('/').pop() : '…'}</span>
      </span>
    </div>
  )
}
