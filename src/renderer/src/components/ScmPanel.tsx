import { useEffect, useState } from 'react'
import { onEvent, rpc } from '../ipc'
import { nextTabId, useActiveWorkspace, useApp } from '../store'
import type { DiffTarget, GitFileChange, RepoStatus } from '@shared/types'

/** Badge colour per status letter, matching VSCode's source control decorations. */
const LETTER_COLOR: Record<string, string> = {
  M: 'var(--git-modified)',
  A: 'var(--git-added)',
  D: 'var(--git-deleted)',
  R: 'var(--git-modified)',
  C: 'var(--git-modified)',
  U: 'var(--git-conflict)',
  '?': 'var(--git-untracked)',
  '!': 'var(--git-ignored)',
  T: 'var(--git-modified)'
}

export function ScmPanel(): React.ReactElement {
  const workspace = useActiveWorkspace()
  const scm = useApp((s) => s.scm)
  const setRepoStatus = useApp((s) => s.setRepoStatus)
  const [message, setMessage] = useState('')

  const repoRoots = (workspace?.folders ?? [])
    .map((f) => f.repoRoot)
    .filter((r): r is string => r !== null)
  const rootsKey = repoRoots.join('|')

  useEffect(() => {
    if (repoRoots.length === 0) return
    let cancelled = false
    void rpc['scm:statusAll']({ repoRoots }).then((all) => {
      if (cancelled) return
      for (const s of all) setRepoStatus(s)
    })
    void rpc['scm:watch']({ repoRoots })
    const off = onEvent('scm:status', ({ status }) => setRepoStatus(status))
    return () => { cancelled = true; off() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey, setRepoStatus])

  if (!workspace) {
    return <Panel><Muted>No workspace open.</Muted></Panel>
  }
  if (repoRoots.length === 0) {
    return <Panel><Muted>No git repository in this workspace.</Muted></Panel>
  }

  return (
    <Panel>
      <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Message (⌘Enter to commit)"
          style={{ width: '100%' }}
        />
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {repoRoots.map((root) => {
          const status = scm[root]
          return status ? (
            <RepoSection key={root} status={status} multi={repoRoots.length > 1} />
          ) : (
            <Muted key={root}>loading {root}…</Muted>
          )
        })}
      </div>
    </Panel>
  )
}

function RepoSection({ status, multi }: { status: RepoStatus; multi: boolean }): React.ReactElement {
  const total =
    status.staged.length + status.unstaged.length + status.untracked.length + status.conflicts.length

  return (
    <div>
      {multi && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            padding: '5px 10px',
            fontSize: 11,
            color: 'var(--fg-muted)',
            background: 'var(--bg)',
            position: 'sticky',
            top: 0
          }}
        >
          <span style={{ flex: 1 }}>{status.name}</span>
          {status.branch && <span>{status.branch}</span>}
        </div>
      )}
      {total === 0 && <Muted>No changes.</Muted>}
      <Group title="Merge Changes" files={status.conflicts} repoRoot={status.root} against={{ kind: 'worktree-vs-head' }} />
      <Group title="Staged Changes" files={status.staged} repoRoot={status.root} against={{ kind: 'index-vs-head' }} />
      <Group title="Changes" files={status.unstaged} repoRoot={status.root} against={{ kind: 'worktree-vs-index' }} />
      <Group title="Untracked" files={status.untracked} repoRoot={status.root} against={{ kind: 'worktree-vs-head' }} />
    </div>
  )
}

function Group({
  title,
  files,
  repoRoot,
  against
}: {
  title: string
  files: GitFileChange[]
  repoRoot: string
  against: DiffTarget
}): React.ReactElement | null {
  const openTab = useApp((s) => s.openTab)
  const workspaceId = useApp((s) => s.activeWorkspaceId)
  if (files.length === 0) return null

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 22,
          padding: '0 10px',
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          color: 'var(--fg-muted)'
        }}
      >
        <span style={{ flex: 1 }}>{title}</span>
        <span>{files.length}</span>
      </div>
      {files.map((f) => {
        const letter = f.worktree !== '.' ? f.worktree : f.index
        return (
          <div
            key={f.path}
            title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
            onClick={() => {
              if (!workspaceId) return
              openTab(workspaceId, {
                id: nextTabId(),
                kind: 'diff',
                title: basename(f.path),
                pinned: false,
                filePath: f.path,
                repoId: repoRoot,
                against
              })
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 22,
              padding: '0 10px',
              fontSize: 12,
              cursor: 'pointer'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {basename(f.path)}
            </span>
            <span style={{ flex: 1, fontSize: 11, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {dirname(f.path)}
            </span>
            <span style={{ color: LETTER_COLOR[letter] ?? 'var(--fg-muted)', fontWeight: 600 }}>{letter}</span>
          </div>
        )
      })}
    </div>
  )
}

function Panel({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>{children}</div>
}

function Muted({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--fg-muted)' }}>{children}</div>
}

const basename = (p: string): string => p.split('/').pop() ?? p
const dirname = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '' : p.slice(0, i)
}
