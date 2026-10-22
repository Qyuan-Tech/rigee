/**
 * The Rigee domain model.
 *
 * This file is the contract shared by main, preload and renderer. It contains no behaviour, and
 * its only imports are types from `@rigee/plugin-api` — which is itself runtime-free — so it can
 * still be pulled into any of the three build targets.
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

/**
 * The types that also appear on the plugin boundary are DEFINED in `@rigee/plugin-api` and
 * re-exported here, not declared twice.
 *
 * The shell keeps importing them from `@shared/types` as it always did — nothing below this line
 * reads differently — but there is one definition, and a plugin compiled against the package is
 * looking at the same `TabId` the shell is rather than a structurally similar one that happens to
 * match today.
 */
import type {
  FileStat,
  RepoId,
  TabId,
  ViewBounds,
  Workspace,
  WorkspaceFolder,
  WorkspaceId
} from '@rigee/plugin-api/data'
import type { PluginId } from '@rigee/plugin-api/manifest'

// Imported above so the rest of this file can keep saying `TabId`, re-exported here so every
// existing `from '@shared/types'` in the shell keeps working.
export type {
  FileStat,
  RepoId,
  TabId,
  ViewBounds,
  Workspace,
  WorkspaceFolder,
  WorkspaceId
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
  /**
   * Where this tab's panes start when they are not splits of a running one — a folder picked with
   * "Open in Terminal". Absent means where the workspace's terminals start.
   */
  cwd?: string
}

export type PaneNode =
  | {
      kind: 'leaf'
      id: string
      paneId: PtyPaneId | null
      /**
       * Where this pane's shell was last seen, `cd` and all: where it starts again after a restart,
       * rather than back at the tab's folder. See `noteEnter` in the renderer's terminals.ts.
       */
      cwd?: string
    }
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
  /** `<pluginId>.<name>`, e.g. `pdf.preview`. See ViewType in @rigee/plugin-api/manifest. */
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
 * One group of the centre pane: its own strip of tabs, its own active tab.
 *
 * Groups side by side and stacked are what make a PDF and a terminal visible at the same time. The
 * arithmetic that maintains them — splitting, closing, dragging a tab across, redistributing the
 * space — is pure and lives in src/renderer/src/groups.ts; this is only the shape it persists as,
 * which has to be here because main migrates the document and cannot import from the renderer.
 */
export interface TabGroup {
  id: GroupId
  tabs: Tab[]
  /** Which tab this group shows. Null only while the group is empty. */
  activeTabId: TabId | null
}

/**
 * Where the groups sit: a terminal tab's `PaneNode`, with groups for leaves.
 *
 * Only the arrangement. The groups themselves, and their tabs, stay in a flat list beside it, so
 * everything that just wants every tab — and most of the shell does — never walks a tree.
 */
export type GroupLayout =
  | { kind: 'group'; id: GroupId }
  | {
      kind: 'split'
      id: string
      /** row = side by side, column = stacked. */
      direction: 'row' | 'column'
      children: GroupLayout[]
      /** One fraction per child, summing to 1. */
      sizes: number[]
    }

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

/** Why a terminal cannot start, when it cannot. */
export type TerminalError = { kind: 'spawn-failed'; message: string }

// Source control types used to live here. They are the source control PLUGIN's contract now, and
// live beside it in plugins/scm/protocol.ts — nothing in the shell needs to know what a hunk
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
  /**
   * The user's changes to the default shortcuts, as Ghostty keybind lines applied in order on top
   * of the platform's defaults — `super+k=unbind`, `super+shift+k=clear_screen`. See keymap.ts.
   *
   * Only the DIFFERENCES are stored, never the whole table, so a default that changes in a later
   * release reaches everybody who had not changed that key themselves. Nested in here rather than
   * beside it because an older build rebuilds the document from the fields it knows at the top
   * level, and would drop a sibling on its first save; it carries this object through whole.
   */
  binds?: string[]
}

export const DEFAULT_KEYBINDINGS: KeyBindings = {
  prefix: 'ctrl+a',
  // tmux's own mnemonics: the character looks like the divider it creates.
  splitRight: '|',
  splitDown: '-',
  closePane: 'x'
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Preferences other than key bindings: the settings dialog's General page, and the ones set where
 * they take effect, like the order of the workspace list.
 *
 * One object rather than more top-level fields, so the next preference is a field here and not
 * another change to the document's shape. Fields this build does not know are kept, as
 * `KeyBindings` keeps them, so a preference written by a newer build survives a round trip
 * through an older one.
 */
export interface AppSettings {
  /**
   * The folder "Save Workspace As…" files workspaces under, each in a folder of its own:
   * `<this>/<name>/<name>.code-workspace`. A leading `~` is the home directory. Unset means ask
   * with a save dialog every time, which is all it did before this existed.
   */
  workspaceFilesDir?: string
  /**
   * Whether a terminal opened in a workspace with no workspace file offers to save one before its
   * shell starts — saved, the terminal starts in the folder the file is in. Unset means yes; it is
   * only ever stored as false, by the prompt's "Don't remind me again" or the General page.
   */
  remindToSaveWorkspace?: boolean
  /**
   * How the side bar orders the workspace list, chosen from the sort button in its header. Unset
   * means by heat, and only another order is ever stored. A value this build does not know — one a
   * newer build wrote — is kept, and read as heat.
   */
  workspaceSort?: WorkspaceSort
  /**
   * The language Rigee speaks, from the General page: one of `LOCALES` in l10n.ts. Unset means the
   * system's, or English when the system's is not one Rigee speaks. A value this build does not
   * know — a language a newer build added — is kept, and read as unset.
   */
  language?: string
}

/**
 * The orders the workspace list can be in, as the sort menu lists them: by heat, how much each
 * has been used lately; by when anything last happened in each; by when each was added; by name.
 */
export const WORKSPACE_SORTS = ['heat', 'recent', 'created', 'name'] as const
export type WorkspaceSort = (typeof WORKSPACE_SORTS)[number]

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/**
 * One day of a workspace's activity.
 *
 * Counted in minutes rather than events: a minute counts once however much happened in it, so a
 * burst of typing weighs the time it took, and a terminal printing a thousand lines a second weighs
 * no more than one printing ten.
 */
export interface ActivityDay {
  /** The local date, `YYYY-MM-DD`. */
  day: string
  /** Minutes in which the user did something here: switched to it, typed, clicked, scrolled. */
  used: number
  /** Minutes in which its terminals printed in earnest — an agent at work, a build — whoever was looking. */
  output: number
}

/**
 * How a workspace has been used lately: what the side bar's heat is worked out from (see heat.ts).
 *
 * Kept raw — minutes per day, not a score — so that weighing them differently later is a change to
 * arithmetic rather than to a document on disk.
 */
export interface WorkspaceActivity {
  /** The day this record began, `YYYY-MM-DD`: the workspace was opened, or this build first saw it. */
  since: string
  /** When the user last did something here, epoch ms. */
  usedAt?: number
  /** When its terminals last printed in earnest, epoch ms. */
  outputAt?: number
  /** The most recent days with anything in them, newest first; a few weeks' worth at most. */
  days: ActivityDay[]
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
   * How tall the workspace list at the top of the left panel may be, header included, in pixels:
   * where the divider under it was last let go. It is shorter when its rows do not fill that, and
   * leaves the view below it room whatever the window's height.
   *
   * Absent until the divider is first dragged, which means the list grows with its rows to a few
   * of them and then scrolls — all it did before the divider could be moved.
   */
  workspacesHeight?: number
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
  /** The centre pane's groups, in reading order. Always at least one, even when it holds nothing. */
  groups: TabGroup[]
  activeGroupId: GroupId
  /**
   * One fraction per group, parallel to `groups`, summing to 1: the row every document described
   * before groups could be stacked. Still written — each group's share of the width — so that a
   * build from before then opens a newer document as a row rather than not at all.
   */
  groupSizes: number[]
  /**
   * Where the groups sit. Absent in a document written before groups could be stacked, which
   * means the row `groupSizes` describes — so no version bump, for the same reason as
   * `disabledPlugins`: silence already says the right thing.
   */
  groupLayout?: GroupLayout
  layout: PanelLayout
  /**
   * Whatever each plugin wants to remember about this workspace, keyed by plugin id.
   *
   * The shell stores it and never reads inside it. This replaced a hard-coded `expandedDirs`
   * field, which was the last thing in the persisted document that named a particular feature —
   * the explorer is a plugin like any other now, and a plugin from somebody else's repository
   * wants the same facility for its own filter or scroll position.
   *
   * OPTIONAL AT EVERY LEVEL, and the absences are load-bearing. No record for a plugin means "this
   * workspace has never been opened with it", which is what lets the explorer expand the root
   * folders on first sight; a record holding an empty list means "the user collapsed everything"
   * and is authoritative. Anything that manufactures an empty record makes every existing
   * workspace open collapsed, permanently.
   */
  pluginState?: Record<PluginId, Record<string, unknown>>
  /**
   * How the workspace has been used lately, which its heat in the side bar is worked out from.
   * Here rather than on the workspace because it is the shell's bookkeeping, not part of the
   * workspace a plugin is handed — and because this map is written whole, so a workspace's record
   * goes when the workspace does. Absent in a document written before there was any.
   */
  activity?: WorkspaceActivity
}

/**
 * The persisted root document. Written atomically (tmp file + rename) to
 * `<userData>/workspaces.json`. `version` gates migrations; bump it and add a migration step
 * rather than mutating the shape in place.
 */
export interface PersistedState {
  version: 4
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
  /** Optional for the same reason: absent means every preference at its default. */
  settings?: AppSettings
}

export const PERSISTED_STATE_VERSION = 4 as const

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

/** Bounds of a DOM placeholder, in CSS pixels relative to the window's content area. */
