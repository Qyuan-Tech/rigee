import { icons } from '@rigee/plugin-api'
import { useActiveWorkspace } from '@rigee/plugin-api'
import { useRepoStatus } from './store'

/**
 * Branch and dirty count, in the status bar.
 *
 * The first repository of the workspace, not all of them: the status bar has one line and a list
 * of ten branch names is worse than none. The panel is where several repositories are shown.
 *
 * Nothing here fetches. A status item never activates its plugin — a branch name is not worth
 * loading source control for — so this renders only once something else (the panel, a diff tab)
 * has brought the plugin up, and it reads whatever the watcher has pushed since.
 */
export function BranchStatusItem(): React.ReactElement | null {
  const workspace = useActiveWorkspace()
  const repo = workspace?.folders.find((f) => f.repoRoot)?.repoRoot ?? null
  const status = useRepoStatus(repo)
  if (!status) return null

  const dirty = status.staged.length + status.unstaged.length + status.untracked.length

  return (
    <span className="statusbar__item">
      <icons.Branch size={12} />
      {status.branch ?? `detached @ ${status.detachedAt ?? '?'}`}
      {dirty > 0 && <span style={{ color: 'var(--git-modified)' }}>{dirty}</span>}
      {status.operation !== 'none' && (
        <span style={{ color: 'var(--git-conflict)' }}>{status.operation}</span>
      )}
    </span>
  )
}
