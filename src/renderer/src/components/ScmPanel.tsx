import { useCallback, useEffect, useState } from 'react'
import { onEvent, isMac, rpc } from '../ipc'
import { BranchIcon, CollapseRightIcon, DiscardIcon, StageIcon, UnstageIcon } from '../icons'
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

export function ScmPanel({ onCollapse }: { onCollapse: () => void }): React.ReactElement {
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

  if (!workspace) return <Panel onCollapse={onCollapse}><div className="muted">No workspace open.</div></Panel>
  if (repoRoots.length === 0) {
    return <Panel onCollapse={onCollapse}><div className="muted">No git repository in this workspace.</div></Panel>
  }

  return (
    <Panel onCollapse={onCollapse}>
      {repoRoots.map((root) => {
        const status = scm[root]
        return status ? (
          <RepoSection key={root} status={status} multi={repoRoots.length > 1} busy={busy} act={act} />
        ) : (
          <div className="muted" key={root}>reading {root.split('/').pop()}…</div>
        )
      })}
      {error && <div className="error-banner">{error}</div>}
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
      <div className="scm__head">
        {multi && (
          <div style={{ fontSize: 11, color: 'var(--fg-faint)', marginBottom: 6 }}>{status.name}</div>
        )}

        <div className="scm__branch">
          <span className="scm__branch-name">
            <BranchIcon size={12} />
            {status.branch ?? `detached @ ${status.detachedAt ?? '?'}`}
          </span>
          {status.upstream && (status.ahead > 0 || status.behind > 0) && (
            <span className="badge">↑{status.ahead} ↓{status.behind}</span>
          )}
          {status.stashCount > 0 && <span className="badge">stash {status.stashCount}</span>}
          {status.operation !== 'none' && (
            <span className="badge badge--warn">{status.operation}</span>
          )}
        </div>

        <textarea
          className="scm__message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(false) }
          }}
          placeholder={`Message (${isMac() ? 'Cmd' : 'Ctrl'}+Enter to commit)`}
          rows={2}
        />

        <div className="scm__buttons">
          <button
            className="btn btn--primary btn--block"
            disabled={busy || !message.trim()}
            onClick={() => commit(false)}
          >
            Commit{status.staged.length > 0 ? ` ${status.staged.length}` : ''}
          </button>
          <button className="btn" disabled={busy} onClick={() => commit(true)} title="Amend the last commit">
            Amend
          </button>
          {allUnstaged.length > 0 && (
            <button
              className="btn"
              disabled={busy}
              title="Stage everything"
              onClick={() => void act(() => rpc['scm:stage']({ repoRoot: root, paths: allUnstaged }))}
            >
              Stage all
            </button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
        {total === 0 && <div className="muted">Working tree clean.</div>}
        <FileGroup title="Merge changes" group="conflicts" files={status.conflicts} root={root}
          busy={busy} act={act} against={{ kind: 'worktree-vs-head' }} />
        <FileGroup title="Staged" group="staged" files={status.staged} root={root}
          busy={busy} act={act} against={{ kind: 'index-vs-head' }} />
        <FileGroup title="Changes" group="unstaged" files={status.unstaged} root={root}
          busy={busy} act={act} against={{ kind: 'worktree-vs-index' }} />
        <FileGroup title="Untracked" group="untracked" files={status.untracked} root={root}
          busy={busy} act={act} against={{ kind: 'worktree-vs-head' }} />
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
  if (files.length === 0) return null

  const staged = group === 'staged'

  return (
    <div>
      <div className="scm__group-header">
        <span style={{ flex: 1 }}>{title}</span>
        <span className="badge">{files.length}</span>
      </div>
      {files.map((f) => {
        const letter = staged ? f.index : f.worktree !== '.' ? f.worktree : f.index
        return (
          <div
            key={`${group}:${f.path}`}
            className="row row--clickable"
            title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
            onClick={() => {
              if (!workspaceId) return
              openTab(workspaceId, {
                id: nextTabId(), kind: 'diff', title: basename(f.path), pinned: false,
                filePath: f.path, repoId: root, against
              })
            }}
          >
            <span className="row__label" style={{ flex: '0 1 auto' }}>{basename(f.path)}</span>
            <span className="path-dim">{dirname(f.path)}</span>

            <span className="row__actions" onClick={(e) => e.stopPropagation()}>
              {!staged && (
                <button
                  className="icon-button"
                  title="Discard changes"
                  disabled={busy}
                  onClick={() => void act(() => rpc['scm:discard']({ repoRoot: root, paths: [f.path] }))}
                >
                  <DiscardIcon size={12} />
                </button>
              )}
              <button
                className="icon-button"
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
                {staged ? <UnstageIcon size={12} /> : <StageIcon size={12} />}
              </button>
            </span>

            <span className="status-letter" style={{ color: LETTER_COLOR[letter] ?? 'var(--fg-faint)' }}>
              {letter === '.' ? '' : letter}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function Panel({
  children,
  onCollapse
}: {
  children: React.ReactNode
  onCollapse: () => void
}): React.ReactElement {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="section-header">
        <span className="section-header__title">Source control</span>
        <button className="icon-button" title="Collapse panel" onClick={onCollapse}>
          <CollapseRightIcon size={14} />
        </button>
      </div>
      {children}
    </div>
  )
}

const basename = (p: string): string => p.split('/').pop() ?? p
const dirname = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '' : p.slice(0, i)
}
