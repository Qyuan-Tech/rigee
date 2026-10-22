import { icons } from '@rigee/plugin-api'
import { useCallback, useEffect, useState } from 'react'
import { isMac, openPluginTab, useActiveWorkspace } from '@rigee/plugin-api'
import { diffTabKey } from './diffTab'
import { useT } from './l10n'
import { scm } from './rpc'
import { setRepoStatus, useScm } from './store'
import type { PluginViewProps } from '@rigee/plugin-api'
import type { DiffTarget, GitFileChange, RepoStatus } from '../protocol'

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

export function ScmPanel({ onCollapse }: PluginViewProps): React.ReactElement {
  const { t } = useT()
  const workspace = useActiveWorkspace()
  const byRepo = useScm((s) => s.byRepo)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const repoRoots = (workspace?.folders ?? [])
    .map((f) => f.repoRoot)
    .filter((r): r is string => r !== null)
  const rootsKey = repoRoots.join('|')

  const refresh = useCallback(async () => {
    if (repoRoots.length === 0) return
    try {
      const all = await scm('scm:statusAll', { repoRoots })
      for (const s of all) setRepoStatus(s)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey])

  useEffect(() => {
    // One initial read, then main pushes on every filesystem change — including changes made by
    // git running in one of the app's own terminals. No polling.
    //
    // The push listener is not here any more: it is registered once when the plugin activates, so
    // the status bar item keeps up to date while the panel is collapsed and unmounted.
    void refresh()
    if (repoRoots.length > 0) void scm('scm:watch', { repoRoots })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey, refresh])

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

  if (!workspace) return <Panel onCollapse={onCollapse}><div className="muted">{t('No workspace open.')}</div></Panel>
  if (repoRoots.length === 0) {
    return <Panel onCollapse={onCollapse}><div className="muted">{t('No git repository in this workspace.')}</div></Panel>
  }

  const multi = repoRoots.length > 1

  /*
   * One repo and many repos need different layouts, and trying to serve both with one was the bug.
   *
   * Every section used to be `flex: 1` in the panel's column. That is right for a single repo —
   * the branch line and commit box stay pinned while the file list scrolls under them — and
   * catastrophic for ten, where each section is handed a tenth of the height, roughly 80px, for
   * content that needs about 200. They do not scroll, they crush into each other.
   *
   * So: one repo keeps the pinned layout. Several stack at their natural height inside a single
   * panel scroller, each collapsible, and a repo with no changes starts collapsed so ten repos
   * read as a list of ten names rather than ten commit boxes.
   */
  return (
    <Panel onCollapse={onCollapse} scroll={multi}>
      {repoRoots.map((root) => {
        const status = byRepo[root]
        return status ? (
          <RepoSection key={root} status={status} multi={multi} busy={busy} act={act} />
        ) : (
          <div className="muted" key={root}>{t('reading {name}…', { name: basename(root) })}</div>
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
  const { t } = useT()
  const [message, setMessage] = useState('')
  const root = status.root
  const total =
    status.staged.length + status.unstaged.length + status.untracked.length + status.conflicts.length

  const commit = useCallback(
    (amend: boolean) => {
      if (!message.trim() && !amend) return
      void act(async () => {
        await scm('scm:commit', { repoRoot: root, message, amend })
        setMessage('')
      })
    },
    [act, message, root]
  )

  const allUnstaged = [...status.unstaged, ...status.untracked].map((f) => f.path)

  // A clean repo among many is noise; one with changes is the reason you opened the panel.
  const [open, setOpen] = useState(!multi || total > 0)

  return (
    <div className={multi ? 'scm__repo' : 'scm__repo scm__repo--only'}>
      {multi && (
        <button className="scm__repo-header" onClick={() => setOpen((o) => !o)}>
          <icons.Chevron size={12} open={open} />
          <span className="scm__repo-name">{status.name}</span>
          <span className="scm__repo-branch">{status.branch ?? status.detachedAt ?? ''}</span>
          {total > 0 && <span className="badge">{total}</span>}
        </button>
      )}
      {(!multi || open) && (
        <>
      <div className="scm__head">

        <div className="scm__branch">
          <span className="scm__branch-name">
            <icons.Branch size={12} />
            {status.branch ?? t('detached @ {commit}', { commit: status.detachedAt ?? '?' })}
          </span>
          {status.upstream && (status.ahead > 0 || status.behind > 0) && (
            <span className="badge">↑{status.ahead} ↓{status.behind}</span>
          )}
          {status.stashCount > 0 && <span className="badge">{t('stash {n}', { n: status.stashCount })}</span>}
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
          placeholder={t('Message ({key}+Enter to commit)', { key: isMac() ? 'Cmd' : 'Ctrl' })}
          rows={2}
        />

        <div className="scm__buttons">
          <button
            className="btn btn--primary btn--block"
            disabled={busy || !message.trim()}
            onClick={() => commit(false)}
          >
            {status.staged.length > 0 ? t('Commit {n}', { n: status.staged.length }) : t('Commit')}
          </button>
          <button className="btn" disabled={busy} onClick={() => commit(true)} title={t('Amend the last commit')}>
            {t('Amend')}
          </button>
          {allUnstaged.length > 0 && (
            <button
              className="btn"
              disabled={busy}
              title={t('Stage everything')}
              onClick={() => void act(() => scm('scm:stage', { repoRoot: root, paths: allUnstaged }))}
            >
              {t('Stage all')}
            </button>
          )}
        </div>
      </div>

      <div className={multi ? 'scm__files' : 'scm__files scm__files--scroll'}>
        {total === 0 && <div className="muted">{t('Working tree clean.')}</div>}
        <FileGroup title={t('Merge changes')} group="conflicts" files={status.conflicts} root={root}
          busy={busy} act={act} against={{ kind: 'worktree-vs-head' }} />
        <FileGroup title={t('Staged')} group="staged" files={status.staged} root={root}
          busy={busy} act={act} against={{ kind: 'index-vs-head' }} />
        <FileGroup title={t('Changes')} group="unstaged" files={status.unstaged} root={root}
          busy={busy} act={act} against={{ kind: 'worktree-vs-index' }} />
        <FileGroup title={t('Untracked')} group="untracked" files={status.untracked} root={root}
          busy={busy} act={act} against={{ kind: 'worktree-vs-head' }} />
      </div>
        </>
      )}
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
  const { t } = useT()
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
              const state = { filePath: f.path, repoId: root, against }
              openPluginTab('scm', {
                viewType: 'scm.diff',
                title: basename(f.path),
                // The strip shows the basename; the hover has to say which file, because a repo
                // with three index.ts in it otherwise offers three identical tabs.
                tooltip: f.path,
                state,
                key: diffTabKey(state)
              })
            }}
          >
            <span className="row__label" style={{ flex: '0 1 auto' }}>{basename(f.path)}</span>
            <span className="path-dim">{dirname(f.path)}</span>

            <span className="row__actions" onClick={(e) => e.stopPropagation()}>
              {!staged && (
                <button
                  className="icon-button"
                  title={t('Discard changes')}
                  disabled={busy}
                  onClick={() => void act(() => scm('scm:discard', { repoRoot: root, paths: [f.path] }))}
                >
                  <icons.Discard size={12} />
                </button>
              )}
              <button
                className="icon-button"
                title={staged ? t('Unstage') : t('Stage')}
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    staged
                      ? scm('scm:unstage', { repoRoot: root, paths: [f.path] })
                      : scm('scm:stage', { repoRoot: root, paths: [f.path] })
                  )
                }
              >
                {staged ? <icons.Unstage size={12} /> : <icons.Stage size={12} />}
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
  onCollapse,
  scroll = false
}: {
  children: React.ReactNode
  onCollapse: () => void
  /** True when several repo sections stack and the panel itself has to scroll them. */
  scroll?: boolean
}): React.ReactElement {
  const { t } = useT()
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="section-header">
        <span className="section-header__title">{t('Source control')}</span>
        <button className="icon-button" title={t('Collapse panel')} onClick={onCollapse}>
          <icons.CollapseRight size={14} />
        </button>
      </div>
      <div className={scroll ? 'scm__body scm__body--scroll' : 'scm__body'}>{children}</div>
    </div>
  )
}

const basename = (p: string): string => p.split('/').pop() ?? p
const dirname = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '' : p.slice(0, i)
}
