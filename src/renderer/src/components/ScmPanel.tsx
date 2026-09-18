import { useCallback, useEffect, useState } from 'react'
import { onEvent, rpc } from '../ipc'
import { nextTabId, useActiveWorkspace, useApp } from '../store'
import type { DiffTarget, GitFileChange, RepoStatus } from '@shared/types'

/** Badge colours, matching VS Code's source control decorations. */
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

type Group = 'conflicts' | 'staged' | 'unstaged' | 'untracked'

export function ScmPanel(): React.ReactElement {
  const workspace = useActiveWorkspace()
  const scm = useApp((s) => s.scm)
  const setRepoStatus = useApp((s) => s.setRepoStatus)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const repoRoots = (workspace?.folders ?? [])
    .map((f) => f.repoRoot)
    .filter((r): r is string => r !== null)
  const rootsKey = repoRoots.join('|')

  const refresh = useCallback(async () => {
    if (repoRoots.length === 0) return
    try {
      const all = await rpc['scm:statusAll']({ repoRoots })
      for (const s of all) setRepoStatus(s)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey, setRepoStatus])

  useEffect(() => {
    // One initial read, then main pushes on every filesystem change — including changes made by
    // git running in one of the app's own terminals. No polling.
    void refresh()
    const off = onEvent('scm:status', ({ status }) => setRepoStatus(status))
    if (repoRoots.length > 0) void rpc['scm:watch']({ repoRoots })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey, refresh, setRepoStatus])

  /** Run a mutation, then refresh so the panel reflects reality rather than what we assumed. */
  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true)
      try {
        await fn()
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
        await refresh()
      }
    },
    [refresh]
  )

  if (!workspace) return <Panel><Muted>No workspace open.</Muted></Panel>
  if (repoRoots.length === 0) {
    return <Panel><Muted>No git repository in this workspace.</Muted></Panel>
  }

  return (
    <Panel>
      {repoRoots.map((root) => {
        const status = scm[root]
        return status ? (
          <RepoSection
            key={root}
            status={status}
            multi={repoRoots.length > 1}
            busy={busy}
            act={act}
          />
        ) : (
          <Muted key={root}>loading {root}…</Muted>
        )
      })}
      {error && (
        <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--git-deleted)', userSelect: 'text' }}>
          {error}
        </div>
      )}
    </Panel>
  )
}

function RepoSection({
  status,
  multi,
  busy,
  act
}: {
  status: RepoStatus
  multi: boolean
  busy: boolean
  act: (fn: () => Promise<unknown>) => Promise<void>
}): React.ReactElement {
  const [message, setMessage] = useState('')
  const root = status.root
  const total =
    status.staged.length + status.unstaged.length + status.untracked.length + status.conflicts.length

  const commit = useCallback(
    (amend: boolean) => {
      if (!message.trim() && !amend) return
      void act(async () => {
        await rpc['scm:commit']({ repoRoot: root, message, amend })
        setMessage('')
      })
    },
    [act, message, root]
  )

  const allUnstaged = [...status.unstaged, ...status.untracked].map((f) => f.path)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
        {multi && (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 6 }}>{status.name}</div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 11, color: 'var(--fg-muted)' }}>
          <span>{status.branch ?? `detached @ ${status.detachedAt ?? '?'}`}</span>
          {status.upstream && (status.ahead > 0 || status.behind > 0) && (
            <span>↑{status.ahead} ↓{status.behind}</span>
          )}
          {status.operation !== 'none' && (
            <span style={{ color: 'var(--git-conflict)' }}>{status.operation.toUpperCase()}</span>
          )}
          {status.stashCount > 0 && <span>stash {status.stashCount}</span>}
        </div>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(false) }
          }}
          placeholder={`Message (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}Enter to commit)`}
          rows={2}
          style={{
            width: '100%',
            resize: 'vertical',
            background: 'var(--bg-input)',
            color: 'var(--fg)',
            border: '1px solid transparent',
            borderRadius: 2,
            padding: '4px 6px',
            font: 'inherit',
            outline: 'none',
            userSelect: 'text'
          }}
        />
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button
            disabled={busy || (!message.trim() && status.staged.length === 0)}
            onClick={() => commit(false)}
            style={primaryButton(busy || !message.trim())}
          >
            Commit
          </button>
          <button disabled={busy} onClick={() => commit(true)} style={ghostButton} title="Amend the last commit">
            Amend
          </button>
          {allUnstaged.length > 0 && (
            <button
              disabled={busy}
              onClick={() => void act(() => rpc['scm:stage']({ repoRoot: root, paths: allUnstaged }))}
              style={ghostButton}
              title="Stage everything"
            >
              Stage all
            </button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {total === 0 && <Muted>No changes.</Muted>}
        <FileGroup
          title="Merge Changes" group="conflicts" files={status.conflicts} root={root} busy={busy} act={act}
          against={{ kind: 'worktree-vs-head' }}
        />
        <FileGroup
          title="Staged Changes" group="staged" files={status.staged} root={root} busy={busy} act={act}
          against={{ kind: 'index-vs-head' }}
        />
        <FileGroup
          title="Changes" group="unstaged" files={status.unstaged} root={root} busy={busy} act={act}
          against={{ kind: 'worktree-vs-index' }}
        />
        <FileGroup
          title="Untracked" group="untracked" files={status.untracked} root={root} busy={busy} act={act}
          against={{ kind: 'worktree-vs-head' }}
        />
      </div>
    </div>
  )
}

function FileGroup({
  title,
  group,
  files,
  root,
  busy,
  act,
  against
}: {
  title: string
  group: Group
  files: GitFileChange[]
  root: string
  busy: boolean
  act: (fn: () => Promise<unknown>) => Promise<void>
  against: DiffTarget
}): React.ReactElement | null {
  const openTab = useApp((s) => s.openTab)
  const workspaceId = useApp((s) => s.activeWorkspaceId)
  const [hover, setHover] = useState<string | null>(null)
  if (files.length === 0) return null

  const staged = group === 'staged'

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
        const letter = staged ? f.index : f.worktree !== '.' ? f.worktree : f.index
        const showing = hover === f.path
        return (
          <div
            key={`${group}:${f.path}`}
            title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
            onMouseEnter={() => setHover(f.path)}
            onMouseLeave={() => setHover(null)}
            onClick={() => {
              if (!workspaceId) return
              openTab(workspaceId, {
                id: nextTabId(),
                kind: 'diff',
                title: basename(f.path),
                pinned: false,
                filePath: f.path,
                repoId: root,
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
              cursor: 'pointer',
              background: showing ? 'var(--bg-hover)' : 'transparent'
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {basename(f.path)}
            </span>
            <span style={{ flex: 1, fontSize: 11, color: 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {dirname(f.path)}
            </span>

            {showing && (
              <span style={{ display: 'flex', gap: 2 }} onClick={(e) => e.stopPropagation()}>
                {!staged && (
                  <RowButton
                    title="Discard changes"
                    disabled={busy}
                    onClick={() => void act(() => rpc['scm:discard']({ repoRoot: root, paths: [f.path] }))}
                  >
                    ↺
                  </RowButton>
                )}
                <RowButton
                  title={staged ? 'Unstage' : 'Stage'}
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      staged
                        ? rpc['scm:unstage']({ repoRoot: root, paths: [f.path] })
                        : rpc['scm:stage']({ repoRoot: root, paths: [f.path] })
                    )
                  }
                >
                  {staged ? '−' : '+'}
                </RowButton>
              </span>
            )}

            <span style={{ color: LETTER_COLOR[letter] ?? 'var(--fg-muted)', fontWeight: 600, width: 10, textAlign: 'center' }}>
              {letter === '.' ? '' : letter}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function RowButton({
  children,
  onClick,
  title,
  disabled
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  disabled?: boolean
}): React.ReactElement {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{ width: 18, height: 18, borderRadius: 3, cursor: 'pointer', opacity: disabled ? 0.3 : 0.8 }}
    >
      {children}
    </button>
  )
}

const primaryButton = (disabled: boolean): React.CSSProperties => ({
  flex: 1,
  height: 24,
  borderRadius: 2,
  background: disabled ? '#0078d455' : 'var(--accent)',
  color: disabled ? 'var(--fg-muted)' : '#fff',
  cursor: disabled ? 'default' : 'pointer'
})

const ghostButton: React.CSSProperties = {
  height: 24,
  padding: '0 8px',
  borderRadius: 2,
  background: 'var(--bg-input)',
  cursor: 'pointer'
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
