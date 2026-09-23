import type { RepoId } from '@rigee/plugin-api/data'

/**
 * The source control contract: what the two halves of this plugin say to each other.
 *
 * These types lived in @shared/types until source control became a plugin. Nothing in the shell
 * needs to know what a hunk is, so they moved here — and the move is the point of the plugin
 * boundary: the shell's domain model shrank by a third without losing a feature. `RepoId` stayed
 * behind because a workspace folder records whether it is a work tree, which the explorer reads
 * before any plugin has loaded.
 *
 * REALM-FREE. This file is compiled into both the node project and the web project, so it must
 * not import node:*, touch the DOM, or contain JSX. Types, and the two four-line wrappers at the
 * bottom that keep either half from spelling a command name as a bare string.
 */

// ---------------------------------------------------------------------------
// Source control
// ---------------------------------------------------------------------------

/**
 * Single-letter status, matching what the UI badges show and what git porcelain v2 reports.
 *   M modified   A added   D deleted   R renamed   C copied
 *   U unmerged   ? untracked   ! ignored   T typechange
 */
export type GitStatusLetter = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | '!' | 'T'

export interface GitFileChange {
  /** Repo-relative, forward slashes on every platform. */
  path: string
  /** Present only for renames/copies: where the file came from. */
  origPath: string | null
  /** Status in the index (staged side). '.' means unchanged there. */
  index: GitStatusLetter | '.'
  /** Status in the working tree (unstaged side). '.' means unchanged there. */
  worktree: GitStatusLetter | '.'
  /** Rename/copy similarity score, 0-100, when index or worktree is R/C. */
  score: number | null
  /** True for submodule entries; they need different diff handling. */
  isSubmodule: boolean
}

/** What a partial-selection apply is trying to do; each maps to a different diff and apply. */
export type SelectionAction = 'stage' | 'unstage' | 'discard'

/** One line of a unified diff, as the hunk view renders and addresses it. */
export interface DiffLineView {
  kind: ' ' | '+' | '-'
  text: string
  noEol: boolean
  /** Stable within one diff; what a selection is expressed in. */
  id: number
  /** Line numbers for the gutter; null on the side where the line does not exist. */
  oldNo: number | null
  newNo: number | null
}

export interface DiffHunkView {
  section: string
  oldStart: number
  newStart: number
  lines: DiffLineView[]
}

/** An in-progress multi-step git operation, which changes what the commit button should do. */
export type GitOperation = 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'

export interface RepoStatus {
  repoId: RepoId
  /** Absolute path to the work tree root. */
  root: string
  name: string
  branch: string | null
  /** null when there is no upstream configured. */
  upstream: string | null
  ahead: number
  behind: number
  detachedAt: string | null
  operation: GitOperation
  /** Changes with something in the index. */
  staged: GitFileChange[]
  /** Tracked changes present only in the working tree. */
  unstaged: GitFileChange[]
  untracked: GitFileChange[]
  /** Unmerged paths. Non-empty means the commit box must show a conflict warning. */
  conflicts: GitFileChange[]
  stashCount: number
  /** When this snapshot was taken, for staleness display. */
  at: number
}

/** What a diff compares. Mirrors the three things the SCM panel can show. */
export type DiffTarget =
  /** worktree vs index — i.e. the unstaged changes */
  | { kind: 'worktree-vs-index' }
  /** index vs HEAD — i.e. the staged changes */
  | { kind: 'index-vs-head' }
  /** worktree vs HEAD — everything, staged or not */
  | { kind: 'worktree-vs-head' }

// ---------------------------------------------------------------------------
// Commands (renderer → main) and events (main → renderer)
// ---------------------------------------------------------------------------

/**
 * Every command this plugin's main half answers, with its argument and result shapes.
 *
 * Names carry the `scm:` prefix because the command registry enforces it — a plugin may only
 * claim its own namespace, so one plugin cannot shadow another's `diff`. These were ten entries
 * in the shell's `REQUEST_CHANNELS` allowlist and are now ten entries here, reachable only
 * through the single `plugin:invoke` channel.
 */
export interface ScmCommands {
  'scm:status': (args: { repoRoot: string }) => RepoStatus
  'scm:statusAll': (args: { repoRoots: string[] }) => RepoStatus[]
  'scm:diff': (args: {
    repoRoot: string
    path: string
    against: DiffTarget
  }) => { original: string; modified: string; binary: boolean; tooLarge: boolean }
  'scm:stage': (args: { repoRoot: string; paths: string[] }) => void
  'scm:unstage': (args: { repoRoot: string; paths: string[] }) => void
  'scm:discard': (args: { repoRoot: string; paths: string[] }) => void
  'scm:commit': (args: { repoRoot: string; message: string; amend: boolean }) => { sha: string }
  'scm:watch': (args: { repoRoots: string[] }) => void
  /** Hunks of one file, for selective staging. `binary` means the hunk UI must be disabled. */
  'scm:hunks': (args: {
    repoRoot: string
    path: string
    action: SelectionAction
  }) => { hunks: DiffHunkView[]; binary: boolean }
  /** Apply only the given line ids. Returns false when the selection produced no patch. */
  'scm:applySelection': (args: {
    repoRoot: string
    path: string
    lineIds: number[]
    action: SelectionAction
  }) => { applied: boolean }
}

/**
 * Pushes main makes on its own initiative. Names are plugin-local: `status`, not `scm:status` —
 * the envelope carries the plugin id, so one plugin's events never reach another's listeners.
 */
export interface ScmEvents {
  /** A watched repository's status changed. Fired by the filesystem watcher, not by a request. */
  status: { status: RepoStatus }
}

export type ScmCommand = keyof ScmCommands
export type ScmArgs<K extends ScmCommand> = Parameters<ScmCommands[K]>[0]
export type ScmResult<K extends ScmCommand> = Awaited<ReturnType<ScmCommands[K]>>

/** One typed call. What both halves use instead of `invoke('scm:statusAll', …)`. */
export type ScmCall = <K extends ScmCommand>(command: K, args: ScmArgs<K>) => Promise<ScmResult<K>>

export type ScmEmit = <K extends keyof ScmEvents>(event: K, payload: ScmEvents[K]) => void

export type ScmSubscribe = <K extends keyof ScmEvents>(
  event: K,
  listener: (payload: ScmEvents[K]) => void
) => void

/**
 * Wrap the host's untyped `invoke` in the command map.
 *
 * Small on purpose, and worth every line: a typo in a command name was previously a rejected
 * promise at click time. Now it is a compile error, and the payload of every call is checked
 * against the handler that will receive it.
 */
export function scmClient(invoke: (command: string, args: unknown) => Promise<unknown>): ScmCall {
  return (command, args) => invoke(command, args) as never
}

/** The same trick for the push direction, over `ctx.shell.emit`. */
export function scmEmitter(emit: (event: string, payload: unknown) => void): ScmEmit {
  return (event, payload) => { emit(event, payload) }
}

/** And for the listening side, over `ctx.rpc.on`. */
export function scmSubscriber(
  on: (event: string, listener: (payload: never) => void) => void
): ScmSubscribe {
  return (event, listener) => { on(event, listener as (payload: never) => void) }
}

/**
 * Every handler the main half must provide, derived from the command map.
 *
 * A mapped type rather than a hand-written interface, so adding a command to `ScmCommands` fails
 * the build in main until it is answered — the failure mode this replaces is a command the
 * renderer can name and nothing implements, which only shows up as a rejected promise in a click
 * handler.
 */
export type ScmHandlers = {
  [K in ScmCommand]: (args: ScmArgs<K>) => ScmResult<K> | Promise<ScmResult<K>>
}

/**
 * Register every handler with the host's command service.
 *
 * Iterates the handler object rather than a duplicated list of names: a list would be a second
 * place to forget an entry, and `ScmHandlers` already makes the set exhaustive.
 */
export function registerScmCommands(
  register: (name: string, handler: (payload: unknown) => unknown) => void,
  handlers: ScmHandlers
): void {
  for (const [name, handler] of Object.entries(handlers)) {
    register(name, handler as (payload: unknown) => unknown)
  }
}
