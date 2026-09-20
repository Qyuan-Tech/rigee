/**
 * The onestop domain model.
 *
 * This file is the contract shared by main, preload and renderer. It deliberately contains no
 * behaviour and no imports so it can be pulled into any of the three build targets.
 *
 * Identifier conventions:
 *   - Ids we mint ourselves are opaque strings (`ws_1`, `tab_7`, ...).
 *   - Ids minted in main (pty panes, browser views) are opaque to the renderer; it stores and
 *     echoes them back, never parses them.
 */

/**
 * Structurally identical to NodeJS.Platform, redeclared here because this module is also
 * consumed by the sandboxed renderer, which has no Node type definitions.
 */
export type Platform =
  | 'aix'
  | 'android'
  | 'cygwin'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'netbsd'
  | 'openbsd'
  | 'sunos'
  | 'win32'

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export type WorkspaceId = string
export type RepoId = string
export type TabId = string

/** One root folder inside a workspace. A workspace may hold several, VSCode-style. */
export interface WorkspaceFolder {
  /** Absolute path. */
  path: string
  /** Display name; defaults to basename(path) but the user may rename it. */
  name: string
  /** Whether `path` is (or is inside) a git work tree. Resolved at add time and on refresh. */
  isGitRepo: boolean
  /**
   * Absolute path to the repository root, when `isGitRepo`. May differ from `path` if the user
   * added a subdirectory of a repo. This, not `path`, is the identity of a repo.
   */
  repoRoot: string | null
}

/**
 * The always-present workspace with no folders.
 *
 * Plenty of terminal work has nothing to do with a repository — an ssh session, a one-off script,
 * poking at a cluster. Forcing the user to invent a workspace first would be friction for no
 * gain, but special-casing "a terminal with no workspace" would fork every code path that keys
 * off a workspace id (terminal ports, tab persistence, the byte transport). A synthetic workspace
 * keeps one path and costs nothing: it is rebuilt at boot, never persisted as a folder set, and
 * cannot be removed.
 */
export const SCRATCH_WORKSPACE_ID: WorkspaceId = '__scratch__'

export function scratchWorkspace(homeDir: string): Workspace {
  return {
    id: SCRATCH_WORKSPACE_ID,
    name: 'Scratch',
    folders: [],
    createdAt: 0,
    lastOpenedAt: 0,
    defaultCwd: homeDir
  }
}

export interface Workspace {
  id: WorkspaceId
  name: string
  folders: WorkspaceFolder[]
  createdAt: number
  lastOpenedAt: number
  /** Where terminals start when the workspace has no folders. Only set for Scratch. */
  defaultCwd?: string
}

// ---------------------------------------------------------------------------
// Tabs (the centre pane)
// ---------------------------------------------------------------------------

export type TabKind = 'terminal' | 'editor' | 'diff' | 'browser'

interface TabBase {
  id: TabId
  kind: TabKind
  title: string
  /** Pinned tabs are not reused by preview-open and survive "close others". */
  pinned: boolean
}

/**
 * One terminal tab, which owns a tree of split panes.
 *
 * The tree lives in the tab rather than in a multiplexer: we run plain pseudo-terminals, so
 * nothing else has an opinion about the layout. It persists with the tab, so reopening the app
 * restores the arrangement even though the processes themselves are gone.
 */
export interface TerminalTab extends TabBase {
  kind: 'terminal'
  root: PaneNode
  /** Which leaf takes keystrokes and is the target of a split. */
  activeLeafId: string
}

export type PaneNode =
  | { kind: 'leaf'; id: string; paneId: PtyPaneId | null }
  | {
      kind: 'split'
      id: string
      /** row = side by side, column = stacked. */
      direction: 'row' | 'column'
      children: PaneNode[]
      /** One fraction per child, summing to 1. */
      sizes: number[]
    }

/** Identifier minted by the pty manager in main. */
export type PtyPaneId = string

export interface EditorTab extends TabBase {
  kind: 'editor'
  filePath: string
  repoId: RepoId | null
  readOnly: boolean
}

/** Side-by-side diff, opened from the source control panel. */
export interface DiffTab extends TabBase {
  kind: 'diff'
  filePath: string
  repoId: RepoId
  /** Which pair of revisions to diff. */
  against: DiffTarget
}

/** What a diff compares. Mirrors the three things the SCM panel can show. */
export type DiffTarget =
  /** worktree vs index — i.e. the unstaged changes */
  | { kind: 'worktree-vs-index' }
  /** index vs HEAD — i.e. the staged changes */
  | { kind: 'index-vs-head' }
  /** worktree vs HEAD — everything, staged or not */
  | { kind: 'worktree-vs-head' }

export interface BrowserTab extends TabBase {
  kind: 'browser'
  url: string
  /**
   * Handle for the native WebContentsView living in main. The renderer never touches the view
   * itself; it only positions a placeholder div and tells main where to put the real thing.
   */
  viewId: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  faviconDataUrl: string | null
}

export type Tab = TerminalTab | EditorTab | DiffTab | BrowserTab

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

/** Why a terminal cannot start, when it cannot. */
export type TerminalError = { kind: 'spawn-failed'; message: string }

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

// ---------------------------------------------------------------------------
// Key bindings
// ---------------------------------------------------------------------------

/**
 * Terminal key bindings, tmux-style: a prefix chord, then a single key.
 *
 * A prefix rather than plain modifier combos because the shell and whatever runs inside it
 * already claim almost every Cmd/Ctrl combination, and a two-stroke sequence cannot collide with
 * them. It also means the defaults are the ones a tmux user's fingers already know.
 */
export interface KeyBindings {
  /** The prefix chord, e.g. "ctrl+a". Matched against modifiers plus one key. */
  prefix: string
  /** Pressed after the prefix. Single characters, compared case-sensitively. */
  splitRight: string
  splitDown: string
  closePane: string
}

export const DEFAULT_KEYBINDINGS: KeyBindings = {
  prefix: 'ctrl+a',
  // tmux's own mnemonics: the character looks like the divider it creates.
  splitRight: '|',
  splitDown: '-',
  closePane: 'x'
}

// ---------------------------------------------------------------------------
// Layout + persistence
// ---------------------------------------------------------------------------

export interface PanelLayout {
  leftWidth: number
  rightWidth: number
  leftCollapsed: boolean
  rightCollapsed: boolean
}

/** Per-workspace UI state restored on reopen. */
export interface WorkspaceUiState {
  tabs: Tab[]
  activeTabId: TabId | null
  layout: PanelLayout
  /** Expanded directories in the file explorer, absolute paths. */
  expandedDirs: string[]
}

/**
 * The persisted root document. Written atomically (tmp file + rename) to
 * `<userData>/workspaces.json`. `version` gates migrations; bump it and add a migration step
 * rather than mutating the shape in place.
 */
export interface PersistedState {
  version: 2
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  ui: Record<WorkspaceId, WorkspaceUiState>
  keybindings: KeyBindings
}

export const PERSISTED_STATE_VERSION = 2 as const

export const DEFAULT_PANEL_LAYOUT: PanelLayout = {
  leftWidth: 260,
  rightWidth: 320,
  leftCollapsed: false,
  rightCollapsed: false
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export interface FileStat {
  path: string
  name: string
  isDir: boolean
  /** True when a .gitignore in scope excludes this entry; the tree dims it. */
  ignored: boolean
}

/** Bounds of a DOM placeholder, in CSS pixels relative to the window's content area. */
export interface ViewBounds {
  x: number
  y: number
  width: number
  height: number
}
