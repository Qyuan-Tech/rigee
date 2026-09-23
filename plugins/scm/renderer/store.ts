import { create } from 'zustand'
import type { RepoStatus } from '../protocol'

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
}

/** The status of one repository, or undefined before its first read lands. */
export function useRepoStatus(root: string | null): RepoStatus | undefined {
  return useScm((s) => (root === null ? undefined : s.byRepo[root]))
}
