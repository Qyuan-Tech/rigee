/**
 * The onestop domain model.
 *
 * This file is the contract shared by main, preload and renderer. It deliberately contains no
 * behaviour and no imports so it can be pulled into any of the three build targets.
 *
 * Identifier conventions:
 *   - Ids we mint ourselves are opaque strings (`ws_1`, `tab_7`, ...).
 *   - Ids that come from tmux keep tmux's own sigils verbatim: sessions `$0`, windows `@1`,
 *     panes `%2`. Never strip the sigil — it is what you pass back to tmux as a -t target.
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

/** tmux identifiers, sigil included. */
export type TmuxSessionId = string
export type TmuxWindowId = string
export type TmuxPaneId = string

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

export interface Workspace {
  id: WorkspaceId
  name: string
  folders: WorkspaceFolder[]
  /**
   * The tmux session this workspace owns. Sessions are named, not id'd, because the name is what
   * survives a tmux server restart and is what the user sees in their own tmux client.
   */
  tmuxSessionName: string
  createdAt: number
  lastOpenedAt: number
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

/** A view onto one tmux pane. The pane lives in the workspace's tmux session. */
export interface TerminalTab extends TabBase {
  kind: 'terminal'
  windowId: TmuxWindowId | null
  paneId: TmuxPaneId | null
}

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
// tmux model (mirrors control-mode state; main owns it, renderer reads it)
// ---------------------------------------------------------------------------

export interface TmuxPane {
  id: TmuxPaneId
  windowId: TmuxWindowId
  active: boolean
  /** Cell geometry as tmux currently has it laid out. */
  width: number
  height: number
  /** Offset within the window's layout, in cells. */
  left: number
  top: number
  title: string
  currentCommand: string
  currentPath: string
  /** True while the pane is in copy-mode/view-mode; keystrokes mean different things then. */
  inMode: boolean
  dead: boolean
}

export interface TmuxWindow {
  id: TmuxWindowId
  sessionId: TmuxSessionId
  index: number
  name: string
  active: boolean
  /** Raw tmux layout string, checksum included. Parsed into a split tree for rendering. */
  layout: string
  panes: TmuxPaneId[]
}

export interface TmuxSession {
  id: TmuxSessionId
  name: string
  attached: boolean
  windows: TmuxWindowId[]
}

/** Parsed form of a tmux window_layout string. */
export type TmuxLayoutNode =
  | { kind: 'pane'; paneId: TmuxPaneId; x: number; y: number; width: number; height: number }
  | {
      kind: 'split'
      direction: 'horizontal' | 'vertical'
      x: number
      y: number
      width: number
      height: number
      children: TmuxLayoutNode[]
    }

/** Connection state of the single control-mode client per workspace. */
export type TmuxConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'connected'; sessionId: TmuxSessionId }
  | { status: 'failed'; error: string }
  /** tmux is not installed, or on Windows WSL2 is missing. */
  | { status: 'unavailable'; reason: string }

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
  version: 1
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  ui: Record<WorkspaceId, WorkspaceUiState>
}

export const PERSISTED_STATE_VERSION = 1 as const

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
