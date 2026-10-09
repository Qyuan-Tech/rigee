import { create } from 'zustand'
import { setFileDecorations, type FileDecoration } from '@rigee/plugin-api'
import type { GitFileChange, GitStatusLetter, RepoStatus } from '../protocol'

/**
 * Where repository statuses live now that the shell's store has no `scm` slice.
 *
 * Module-level and plugin-local, for the reason the slice existed in the first place: the panel
 * and the status bar item are mounted in different corners of the tree with no common ancestor
 * below the shell root, so the only alternatives were prop drilling through the shell — which
 * would put git back into code that no longer knows what a branch is — or two independent
 * subscriptions that disagree with each other.
 *
 * The shell's HARD RULE still applies here: descriptors only. A `RepoStatus` is a snapshot of
 * names and counts, not a live handle, and main only pushes one when the status genuinely
 * differs (see `statusKey` in main/git/service.ts) — so a build touching 2000 files produces one
 * render, not 2000. Anything high-churn would belong in a module Map reached by ref instead.
 *
 * zustand rather than a hand-rolled store because the shell already ships it, so this is free:
 * Rollup gives both copies the same chunk.
 */

interface ScmState {
  /** Keyed by repo root, which is a repository's identity everywhere in this plugin. */
  byRepo: Record<string, RepoStatus>
}

export const useScm = create<ScmState>()(() => ({ byRepo: {} }))

/**
 * Record a status.
 *
 * A plain function rather than an action on the store, because the caller is the plugin's event
 * subscription rather than a component: nothing needs to read it through a hook, and one fewer
 * field is one fewer thing a selector can accidentally depend on.
 */
export function setRepoStatus(status: RepoStatus): void {
  useScm.setState((s) => ({ byRepo: { ...s.byRepo, [status.root]: status } }))
  setFileDecorations(`scm:${status.root}`, decorationsOf(status))
}

/** VS Code's colours and letters, and the order a folder picks between them: conflicts first. */
const LOOK: Partial<Record<GitStatusLetter, FileDecoration>> = {
  U: { color: 'var(--git-conflict)', badge: '!', tooltip: 'Conflicted', weight: 5 },
  M: { color: 'var(--git-modified)', badge: 'M', tooltip: 'Modified', weight: 4 },
  T: { color: 'var(--git-modified)', badge: 'T', tooltip: 'Type changed', weight: 4 },
  D: { color: 'var(--git-deleted)', badge: 'D', tooltip: 'Deleted', weight: 3 },
  A: { color: 'var(--git-added)', badge: 'A', tooltip: 'Added', weight: 2 },
  R: { color: 'var(--git-added)', badge: 'R', tooltip: 'Renamed', weight: 2 },
  C: { color: 'var(--git-added)', badge: 'C', tooltip: 'Copied', weight: 2 },
  '?': { color: 'var(--git-untracked)', badge: 'U', tooltip: 'Untracked', weight: 1 }
}

/**
 * What the explorer should colour, for one status snapshot. The working tree's letter wins over
 * the index's, since it is what the file on disk is now; a file staged as added and then edited
 * is still new to the repository, so it stays A.
 */
function decorationsOf(status: RepoStatus): Record<string, FileDecoration> {
  const out: Record<string, FileDecoration> = {}
  const add = (c: GitFileChange, letter: GitStatusLetter | '.'): void => {
    const look = letter === '.' ? undefined : LOOK[letter]
    // `?` records for a directory end in a slash, which the shell reads as "all of it".
    if (look) out[`${status.root}/${c.path}`] = look
  }
  for (const c of status.untracked) add(c, '?')
  for (const c of [...status.staged, ...status.unstaged]) {
    add(c, c.index === 'A' ? 'A' : c.worktree !== '.' ? c.worktree : c.index)
  }
  for (const c of status.conflicts) add(c, 'U')
  return out
}

/** The status of one repository, or undefined before its first read lands. */
export function useRepoStatus(root: string | null): RepoStatus | undefined {
  return useScm((s) => (root === null ? undefined : s.byRepo[root]))
}
