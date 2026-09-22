import type { DiffTarget } from '../protocol'

/**
 * What a `scm.diff` tab carries in its state, and how to get it back out safely.
 *
 * The shell persists a custom tab's state verbatim and hands it back on restore without looking
 * inside — it cannot look, it does not know what a diff is. Two things therefore arrive here that
 * a fresh tab never would: a state written by an older version of this plugin, and a `diff` tab
 * persisted before the plugin system existed, whose whole object was spread into `state` by
 * `migrateLegacyTab`. Both are validated rather than trusted; an unusable one gets a Notice
 * instead of a crash inside Monaco.
 */
export interface DiffTabState {
  filePath: string
  repoId: string
  against: DiffTarget
}

const TARGET_KINDS: readonly string[] = ['worktree-vs-index', 'index-vs-head', 'worktree-vs-head']

/**
 * Identity for de-duplication, matching exactly what the shell's old `sameTarget` compared for a
 * `diff` tab: path, repo and which pair of revisions. Clicking the same file under "Changes"
 * twice re-activates the tab; clicking it under "Staged" as well legitimately opens a second one,
 * because it is a different diff.
 *
 * Unit-separated rather than joined with a slash or a colon: both are legal in a path, and a key
 * collision here would silently re-activate the wrong tab.
 */
export function diffTabKey(state: DiffTabState): string {
  return [state.repoId, state.filePath, state.against.kind].join('\u001f')
}

export function readDiffTabState(state: Record<string, unknown>): DiffTabState | null {
  const { filePath, repoId, against } = state
  if (typeof filePath !== 'string' || typeof repoId !== 'string') return null
  if (typeof against !== 'object' || against === null) return null

  const { kind } = against as { kind?: unknown }
  if (typeof kind !== 'string' || !TARGET_KINDS.includes(kind)) return null
  return { filePath, repoId, against: { kind } as DiffTarget }
}
