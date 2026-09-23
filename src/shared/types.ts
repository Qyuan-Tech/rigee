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
  /**
   * The `.code-workspace` file this workspace was opened from, when it came from one.
   *
   * Absent for a workspace that is just a folder — which is the majority, and is exactly VS Code's
   * distinction between a folder and a saved multi-root workspace. Its presence is what makes
   * "Save Workspace As" an overwrite rather than a new file.
   */
  filePath?: string | null
}

// ---------------------------------------------------------------------------
// Tabs (the centre pane)
// ---------------------------------------------------------------------------

/**
 * Three kinds, and only the first two are the shell's business.
 *
 * `custom` is the escape hatch a plugin owns end to end — a diff, a browser tab. The shell routes
 * it by `viewType` and never looks inside `state`. Before the plugin system there were separate
 * `diff` and `browser` kinds here; they are gone, and tabs persisted under those names are
 * rewritten on load from the owning plugin's `legacyKind` declaration (see `sanitizeTabs`).
 */
export type TabKind = 'terminal' | 'editor' | 'custom'

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

/**
 * A file, shown by whichever editor claimed it.
 *
 * `viewType` is resolved once, from the manifests alone, when the tab is created — a plain array
 * scan, no plugin loaded. Absent means the text editor, which is itself a plugin but the one that
 * claims everything. A `viewType` whose plugin has since disappeared is not repaired on load: the
 * pane says so and offers to open the file as text, which is a better answer than silently
 * handing a PDF to Monaco.
 */
export interface EditorTab extends TabBase {
  kind: 'editor'
  filePath: string
  repoId: RepoId | null
  readOnly: boolean
  /** `<pluginId>.<name>`, e.g. `pdf.preview`. See ViewType in @shared/plugin. */
  viewType?: string
}

/**
 * A tab a plugin owns: the shell stores it, restores it and closes it, and renders whatever the
 * plugin bound to `viewType`.
 *
 * `state` is opaque here and must survive JSON. The plugin validates it on restore — the shell
 * cannot, because the shell does not know what a browser tab or a diff is.
 */
export interface CustomTab extends TabBase {
  kind: 'custom'
  viewType: string
  state: Record<string, unknown>
  /**
   * What the tab strip shows on hover. The plugin sets it, because only the plugin knows what
   * would be useful there — a diff's file path, a page's URL — and the shell cannot read either
   * out of an opaque state bag.
   */
  tooltip?: string
  /**
   * Identity for de-duplication, when the plugin has one.
   *
   * Clicking the same file in the source control panel twice should re-activate the diff rather
   * than open a second one; opening two browser tabs on the same URL is legitimate. So the plugin
   * decides, by setting this or leaving it undefined.
   */
  key?: string
}

export type Tab = TerminalTab | EditorTab | CustomTab

// ---------------------------------------------------------------------------
// Editor groups
// ---------------------------------------------------------------------------

export type GroupId = string

/**
 * One column of the centre pane: its own strip of tabs, its own active tab.
 *
 * The row of groups is what makes a PDF and a terminal visible at the same time. The arithmetic
 * that maintains it — splitting, closing, dragging a tab across, redistributing the widths — is
 * pure and lives in src/renderer/src/groups.ts; this is only the shape it persists as, which has
 * to be here because main migrates the document and cannot import from the renderer.
 */
export interface TabGroup {
  id: GroupId
  tabs: Tab[]
  /** Which tab this group shows. Null only while the group is empty. */
  activeTabId: TabId | null
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

/** Why a terminal cannot start, when it cannot. */
export type TerminalError = { kind: 'spawn-failed'; message: string }

// Source control types used to live here. They are the source control PLUGIN's contract now, and
// live beside it in src/plugins/scm/protocol.ts — nothing in the shell needs to know what a hunk
// is. `RepoId` stays because a workspace folder records whether it is a work tree, which is how
// the explorer decides what to show before any plugin has loaded.

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
  /**
   * Which view the activity bar is showing in the left panel, by view id.
   *
   * Null means "the first one", which is what a workspace opened before the activity bar existed
   * gets. A view id whose plugin has since been disabled or removed falls back the same way — the
   * shell never renders an activity bar with nothing selected.
   */
  leftView?: string | null
}

/** Per-workspace UI state restored on reopen. */
export interface WorkspaceUiState {
  /** The centre pane, left to right. Always at least one, even when it holds nothing. */
  groups: TabGroup[]
  activeGroupId: GroupId
  /** One fraction per group, parallel to `groups`, summing to 1. */
  groupSizes: number[]
  layout: PanelLayout
  /**
   * Expanded directories in the file explorer, absolute paths.
   *
   * OPTIONAL, and its absence is load-bearing: it is what tells the explorer this workspace has
   * never been opened, so it should start with its roots expanded. A record with an empty array
   * means "everything collapsed" and is authoritative. Anything that manufactures `[]` here makes
   * every existing workspace open fully collapsed, permanently.
   */
  expandedDirs?: string[]
}

/**
 * The persisted root document. Written atomically (tmp file + rename) to
 * `<userData>/workspaces.json`. `version` gates migrations; bump it and add a migration step
 * rather than mutating the shape in place.
 */
export interface PersistedState {
  version: 3
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  ui: Record<WorkspaceId, WorkspaceUiState>
  keybindings: KeyBindings
  /**
   * Plugins the user has switched off, by id. Global rather than per workspace: a plugin is code,
   * and wanting it in one project but not another is not a thing anybody has asked for.
   *
   * Optional so a document written before the plugins view existed loads unchanged — absent means
   * everything is enabled, which is the only sensible reading of silence.
   */
  disabledPlugins?: string[]
}

export const PERSISTED_STATE_VERSION = 3 as const

export const DEFAULT_PANEL_LAYOUT: PanelLayout = {
  leftView: null,
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
