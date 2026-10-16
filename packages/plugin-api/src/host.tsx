/**
 * The shell, as a plugin's renderer half sees it.
 *
 * WHY THIS IS A SHIM AND NOT AN IMPLEMENTATION. A plugin bundled with the app could simply import
 * the shell's modules; a plugin from somebody else's repository cannot — it is built separately,
 * against this package, and only meets the shell at runtime. So the package declares the SHAPE and
 * the shell installs the BEHAVIOUR, once, before any plugin activates. Both kinds of plugin then
 * write the same import and get the same object, and there is exactly one implementation to keep
 * correct.
 *
 * It matters that there is exactly one copy of this module in the window. Everything below reads
 * module-level state, so two copies would mean a plugin talking to a host nobody installed. For
 * bundled plugins the build guarantees it (one alias, one chunk); for disk plugins the renderer's
 * import map points `@rigee/plugin-api` at the shell's own copy, which is the entire reason that
 * import map exists.
 *
 * CORDIS-FREE, ON PURPOSE. A plugin uses `ctx` for things that must be revoked when it is
 * disposed — binding components, subscribing to its main half — and this module for everything
 * else. A cordis service access costs ~15 us against ~8 ns for a plain call, which is unacceptable
 * inside a React render, and none of this needs a lifecycle.
 */

import type { FileStat, TabId, Workspace, WorkspaceId } from './data'
import type { PluginId, ViewType } from './manifest'
import type { IconSet, NoticeProps } from './ui'
import type { ComponentType, ReactElement } from 'react'

export interface PluginTabRequest {
  viewType: ViewType
  title: string
  /** Hover text for the tab strip — the path, the URL, whatever identifies it to a reader. */
  tooltip?: string
  state: Record<string, unknown>
  /**
   * Identity for de-duplication. Opening the same key twice re-activates the existing tab rather
   * than adding a second one; leave it out when duplicates are legitimate.
   *
   * De-duplication is PER EDITOR GROUP: the same key open in two columns is two tabs, because the
   * same document side by side is what splitting is for.
   */
  key?: string
  /**
   * Open beside this tab — in whichever group holds it — instead of in the active group.
   *
   * For a tab opened BY another tab rather than by the user. A `window.open` popup from a page in
   * the right-hand group belongs in the right-hand group: the user's focus may be anywhere by the
   * time the page gets round to opening it, and landing in the wrong column looks like the click
   * did something else entirely. Ignored when the tab is gone or lives in another workspace.
   */
  nearTabId?: TabId
}

/** Open a file in whichever viewer claims it. What clicking a file in a tree should do. */
export interface OpenFileRequest {
  /** Absolute path. */
  path: string
  /** Tab title. Defaults to the basename. */
  title?: string
  readOnly?: boolean
  /**
   * Open it in this editor instead of the one the shell would pick — one `editorsOnRequest`
   * offered. Ignored unless that editor claims the file, so a stale menu still opens something.
   */
  viewType?: ViewType
  /** As on `PluginTabRequest`: put it beside this tab rather than in the active group. */
  nearTabId?: TabId
  /**
   * Where to put the cursor — a search result's match. Delivered to the editor through
   * `onRevealInFile`, whether the tab is new or was already open.
   */
  selection?: TextSelection
  /**
   * Leave the keyboard where it is instead of handing it to the file's viewer. What a single click
   * in a file tree does, so the tree's arrow keys and Delete go on acting on the tree. Without it
   * the viewer takes the keyboard — as it mounts, or at once if the file is already on screen.
   */
  preserveFocus?: boolean
}

/** A file or folder a plugin renamed or moved: where it was, and where it is now. */
export interface FileMove {
  from: string
  to: string
}

/** A place in a text file. 1-based, columns in UTF-16 code units, as Monaco counts them. */
export interface TextSelection {
  line: number
  column: number
  /** Defaults to `line`. */
  endLine?: number
  /** Defaults to `column`: a caret, not a range. */
  endColumn?: number
}

/**
 * How the shell saves or drops a file's unsaved changes, when a tab closing or the app quitting
 * asks the user and the user answers. Both reject to say they could not.
 */
export interface FileHandlers {
  save: () => Promise<void>
  discard: () => Promise<void>
}

/**
 * One run of a line of code that tokenises as one thing: where it starts, and what it is.
 *
 * `type` is a Monarch token type, as the text editor's tokenizers name them — `keyword.ts`,
 * `string.escape.js`, `attribute.value.html`. The first segment is the kind; the last is the
 * language and rarely matters.
 */
export interface CodeToken {
  /** In UTF-16 code units from the start of the line. */
  offset: number
  type: string
}

/** What `pluginTabs` reports about one of a plugin's own tabs. */
/**
 * One row of a context menu a plugin asks the shell to show: a command, or a separator. Plain data;
 * what a command does stays with the plugin, which gets back the `id` of the row picked.
 */
export type MenuItem =
  | {
      kind: 'item'
      id: string
      label: string
      enabled?: boolean
      /**
       * The shortcut drawn beside the label, in Electron's accelerator syntax: `CmdOrCtrl+C`. Shown,
       * not listened for — the plugin answers the key itself, wherever it has the keyboard.
       */
      accelerator?: string
    }
  | { kind: 'separator' }

export interface PluginTabInfo {
  tabId: TabId
  state: Record<string, unknown>
  key?: string
}

/** An editor that opens a file only when asked, as a file's menu offers it. */
export interface EditorOffer {
  viewType: ViewType
  /** In the editor's own words, from its manifest: `Open Preview`. */
  label: string
}

/**
 * Everything the shell provides. Implemented once, in the shell; see `installShellHost`.
 *
 * Adding a method here is backwards compatible. Removing or reshaping one is not — bump
 * `PLUGIN_API_VERSION` when you do, because a disk plugin built against the old shape is refused
 * at discovery rather than left to fail at a call site.
 */
export interface ShellHost {
  // --- platform and theme -------------------------------------------------
  isMac: () => boolean
  /** The font stack the shell's editors use, so a plugin's does not look foreign. */
  monoFamily: () => string
  editorFontSize: () => number

  // --- workspaces ---------------------------------------------------------
  activeWorkspaceId: () => WorkspaceId | null
  /** React hook. Re-renders when the workspace changes. */
  useActiveWorkspace: () => Workspace | null
  /**
   * The workspace's own folder — the one its `.code-workspace` file is in, where its terminals
   * start — or null for a workspace with no file: never saved, a plain folder, Scratch. Not
   * necessarily one of `folders`, and usually not: those are the repos it groups.
   */
  workspaceDir: (workspace: Workspace) => string | null
  addWorkspaceFolders: (paths: string[]) => Promise<void>
  /**
   * Take some of the active workspace's `folders` out of it, and out of its `.code-workspace` file
   * when it has one. Only the workspace changes: the folders stay on disk, and so do the tabs of
   * files in them. Paths it does not list are ignored.
   */
  removeWorkspaceFolders: (paths: string[]) => Promise<void>

  // --- terminals ----------------------------------------------------------
  /**
   * Open a terminal in the active workspace whose shell starts in `cwd` — a folder the user picked,
   * so it never stops to ask about saving the workspace. `tab` (the default) is a new terminal tab;
   * `split` is a new pane beside the active one in the terminal on screen, or a new tab when no
   * terminal is showing. Returns the tab it is in, or null with no workspace to put it in.
   */
  openTerminal: (request: { cwd: string; where?: 'tab' | 'split' }) => TabId | null

  // --- tabs ---------------------------------------------------------------
  openPluginTab: (pluginId: PluginId, request: PluginTabRequest) => TabId | null
  openFile: (request: OpenFileRequest) => TabId | null
  editorsOnRequest: (path: string) => EditorOffer[]
  patchPluginTab: (
    tabId: TabId,
    patch: { title?: string; tooltip?: string; key?: string; state?: Record<string, unknown> }
  ) => void
  closePluginTab: (tabId: TabId) => void
  activateTab: (tabId: TabId) => void
  pluginTabs: (viewType: ViewType) => PluginTabInfo[]
  liveTabIds: () => Set<TabId>
  subscribeTabs: (listener: (live: Set<TabId>) => void) => () => void
  duplicatedFrom: (tabId: TabId) => TabId | null

  // --- layout -------------------------------------------------------------
  focusedTabId: () => TabId | null
  useFocusedTabId: () => TabId | null
  mountedTabIds: () => TabId[]
  subscribeMountedTabs: (listener: (tabIds: TabId[]) => void) => () => void

  // --- per-plugin persisted state ----------------------------------------
  pluginState: (pluginId: PluginId, workspaceId: WorkspaceId) => Record<string, unknown> | undefined
  usePluginState: (
    pluginId: PluginId,
    workspaceId: WorkspaceId | null
  ) => Record<string, unknown> | undefined
  setPluginState: (
    pluginId: PluginId,
    workspaceId: WorkspaceId,
    patch: Record<string, unknown>
  ) => void

  // --- editing ------------------------------------------------------------
  setFileDirty: (path: string, dirty: boolean, handlers?: FileHandlers) => void
  onRevealInFile: (tabId: TabId, cb: (selection: TextSelection) => void) => () => void
  onViewRevealed: (viewId: string, cb: () => void) => () => void
  openedInBackground: (tabId: TabId) => boolean

  // --- files a plugin moved or deleted -----------------------------------
  filesMoved: (moves: FileMove[]) => void
  filesDeleted: (paths: string[]) => void
  unsavedFiles: (paths: string[]) => string[]

  // --- file decorations ---------------------------------------------------
  setFileDecorations: (source: string, decorations: Record<string, FileDecoration>) => void
  useFileDecoration: (path: string) => FileDecoration | undefined

  // --- files (permissioned) ----------------------------------------------
  readFile: (path: string) => Promise<{ content: string; truncated: boolean; tooLarge: boolean; notUtf8?: boolean }>
  writeFile: (path: string, content: string) => Promise<void>
  listDir: (path: string) => Promise<FileStat[]>

  // --- code ---------------------------------------------------------------
  tokenizeCode: (text: string, language: string) => Promise<CodeToken[][] | null>

  // --- workers ------------------------------------------------------------
  workerUrl: (script: string | URL) => string

  // --- UI -----------------------------------------------------------------
  /**
   * A native context menu at the pointer: the id of the row picked, or null when dismissed. Native
   * because a browser tab's page is drawn over the whole document, and a menu drawn in it can end
   * up underneath.
   */
  popupMenu: (items: MenuItem[]) => Promise<string | null>
  icons: IconSet
  Notice: ComponentType<NoticeProps>
}

let host: ShellHost | null = null

/**
 * Called by the shell, exactly once, before any plugin activates.
 *
 * Throwing on a second call is not pedantry: a second install means a second copy of this module
 * got loaded, and the plugins that imported the first copy are now talking to a host the shell has
 * stopped updating. That failure is invisible — components render, calls resolve, and one plugin's
 * tabs quietly go to the wrong place. Far better to fail at the install.
 */
export function installShellHost(impl: ShellHost): void {
  if (host) throw new Error('@rigee/plugin-api: the shell host is already installed')
  host = impl
  Object.assign(icons, impl.icons)
}

/** True once the shell has installed itself. For the shell's own start-up assertions. */
export function shellHostInstalled(): boolean {
  return host !== null
}

function shell(): ShellHost {
  if (!host) {
    throw new Error(
      '@rigee/plugin-api: no shell host installed. Either this is being called outside Rigee, ' +
        'or a second copy of @rigee/plugin-api was bundled into the plugin instead of being ' +
        'left external and resolved through the import map.'
    )
  }
  return host
}

/**
 * The shell's icons, filled in at install.
 *
 * A mutable object rather than named exports because named exports cannot be assigned from
 * outside the module, and a per-icon forwarding component would add a React layer to every row of
 * a file tree. After install these are the shell's own components, reached by one property read.
 */
export const icons: IconSet = {} as IconSet

// ---------------------------------------------------------------------------
// The functions. Each is a forward; the comments that matter are on ShellHost.
// ---------------------------------------------------------------------------

export const isMac = (): boolean => shell().isMac()
export const monoFamily = (): string => shell().monoFamily()
export const editorFontSize = (): number => shell().editorFontSize()

export const activeWorkspaceId = (): WorkspaceId | null => shell().activeWorkspaceId()
export const useActiveWorkspace = (): Workspace | null => shell().useActiveWorkspace()
export const workspaceDir = (workspace: Workspace): string | null => shell().workspaceDir(workspace)
export const addWorkspaceFolders = (paths: string[]): Promise<void> =>
  shell().addWorkspaceFolders(paths)
export const removeWorkspaceFolders = (paths: string[]): Promise<void> =>
  shell().removeWorkspaceFolders(paths)

export const openTerminal = (request: { cwd: string; where?: 'tab' | 'split' }): TabId | null =>
  shell().openTerminal(request)

export const popupMenu = (items: MenuItem[]): Promise<string | null> => shell().popupMenu(items)

/**
 * Open (or re-activate) a tab this plugin owns, in the active workspace's active group.
 *
 * Returns the tab's id, or null when there is no workspace to put it in. The view type must be one
 * this plugin declared; the shell throws if it belongs to somebody else.
 */
export const openPluginTab = (pluginId: PluginId, request: PluginTabRequest): TabId | null =>
  shell().openPluginTab(pluginId, request)

/**
 * Open a file in whichever editor claims it.
 *
 * The resolution is the SHELL's — it reads the manifests, so no plugin is loaded to answer "who
 * opens a .pdf" and the caller does not need to know that editors have priorities. This is what a
 * file tree calls; before it existed the explorer reached into the store, invented a tab id and
 * resolved the view type itself, which meant three shell internals in one click handler.
 */
export const openFile = (request: OpenFileRequest): TabId | null => shell().openFile(request)

/**
 * The editors that open this file only when asked — a Markdown file's preview — in the words to
 * offer them in. What a file tree puts in a file's menu; picking one is `openFile({ viewType })`.
 * Read off the manifests, so nothing is loaded to answer, and empty for most files.
 */
export const editorsOnRequest = (path: string): EditorOffer[] => shell().editorsOnRequest(path)

export const patchPluginTab = (
  tabId: TabId,
  patch: { title?: string; tooltip?: string; key?: string; state?: Record<string, unknown> }
): void => shell().patchPluginTab(tabId, patch)

export const closePluginTab = (tabId: TabId): void => shell().closePluginTab(tabId)

/**
 * Make this tab the one its column shows, and its column the active one. For content that takes
 * the keyboard where the shell cannot see it — a click inside a native view — so that the shell's
 * idea of "where the user is working", which every shortcut acts on, follows. A no-op when it is
 * already so.
 */
export const activateTab = (tabId: TabId): void => shell().activateTab(tabId)

/**
 * Every open tab of one of this plugin's own view types, across every workspace.
 *
 * Exists for one job: repairing tabs restored from a persisted state older than the plugin. The
 * shell can move an old tab's fields into `state`, but it cannot invent a dedup key — only the
 * plugin knows what identifies one of its tabs.
 */
export const pluginTabs = (viewType: ViewType): PluginTabInfo[] => shell().pluginTabs(viewType)

/**
 * Every tab id that exists, in every group of every workspace.
 *
 * For plugins holding a resource per tab — a native browser view, a parsed document — that has to
 * be released when the tab goes. Callers treat anything absent from this set as closed, so it spans
 * every workspace deliberately: switching workspace must not read as "every tab was closed".
 */
export const liveTabIds = (): Set<TabId> => shell().liveTabIds()

/** Watch for tabs disappearing. Wrap the returned undo in `ctx.effect` so it dies with the plugin. */
export const subscribeTabs = (listener: (live: Set<TabId>) => void): (() => void) =>
  shell().subscribeTabs(listener)

/**
 * The tab this one was split from, or null.
 *
 * CONSUME-ONCE. Read it on first mount and keep what you got; the second caller, and every render
 * after the first, gets null. StrictMode's double-invoked effect counts as a second caller, so this
 * belongs in a `useState` initialiser or a ref, never in an effect body.
 */
export const duplicatedFrom = (tabId: TabId): TabId | null => shell().duplicatedFrom(tabId)

/**
 * The one tab with the keyboard: the active group's active tab, in the active workspace.
 *
 * One rule, in one place. Two copies of it is how two visible panes end up disagreeing about which
 * of them should be typing.
 */
export const focusedTabId = (): TabId | null => shell().focusedTabId()

/** The same rule as a hook, for a pane that has to re-render when focus moves to another column. */
export const useFocusedTabId = (): TabId | null => shell().useFocusedTabId()

/**
 * The active tab of every group in the active workspace, left to right.
 *
 * What is actually on screen. A plugin compositing something outside the DOM — a native view — has
 * to know exactly this set, and only for the active workspace: the tabs of the workspace you
 * switched away from are alive but not visible.
 */
export const mountedTabIds = (): TabId[] => shell().mountedTabIds()

/** Fires when `mountedTabIds` changes — a split, a drag between groups, a workspace switch. */
export const subscribeMountedTabs = (listener: (tabIds: TabId[]) => void): (() => void) =>
  shell().subscribeMountedTabs(listener)

/**
 * A plugin's own persisted state for one workspace.
 *
 * Saved and restored with the workspace by the shell, which never looks inside it. For the things
 * a panel wants to remember per project — which directories are expanded, a filter, a scroll
 * position. Undefined means "nothing recorded yet", which is different from "recorded as empty":
 * the file tree opens its root folders on first sight and must not do it again after the user
 * collapses everything.
 */
export const pluginState = (
  pluginId: PluginId,
  workspaceId: WorkspaceId
): Record<string, unknown> | undefined => shell().pluginState(pluginId, workspaceId)

/** The same, as a hook. Null workspace yields undefined rather than throwing. */
export const usePluginState = (
  pluginId: PluginId,
  workspaceId: WorkspaceId | null
): Record<string, unknown> | undefined => shell().usePluginState(pluginId, workspaceId)

/** Merge into this plugin's state for one workspace, and persist it. */
export const setPluginState = (
  pluginId: PluginId,
  workspaceId: WorkspaceId,
  patch: Record<string, unknown>
): void => shell().setPluginState(pluginId, workspaceId, patch)

/**
 * Say whether a file has unsaved changes, and how to save or drop them.
 *
 * The shell marks its tabs with a dot and, when one would close — or the app would quit — with
 * the changes unsaved, asks the user and calls `save` or `discard`. Keyed by PATH, not tab: one
 * document can be open in two columns, and it is the document that is unsaved.
 */
export const setFileDirty = (path: string, dirty: boolean, handlers?: FileHandlers): void =>
  shell().setFileDirty(path, dirty, handlers)

/** How a file's name is drawn in the tree: source control's colours, in VS Code's manner. */
export interface FileDecoration {
  /** A CSS colour, usually one of the theme's variables: `var(--git-modified)`. */
  color: string
  /** One or two characters shown at the end of the row — `M`, `U`, `A`. */
  badge?: string
  tooltip?: string
  /** Which wins when two decorations meet on one folder. Higher is more important. */
  weight?: number
}

/**
 * Replace every decoration one source publishes, keyed by absolute path. A path ending in a
 * separator covers the folder and everything inside it. An empty record withdraws the source.
 * Folders above a decorated path take its colour, so collapsed trees still show where changes are.
 */
export const setFileDecorations = (source: string, decorations: Record<string, FileDecoration>): void =>
  shell().setFileDecorations(source, decorations)

/** The decoration to draw for a path. A hook: re-renders when that path's decoration changes. */
export const useFileDecoration = (path: string): FileDecoration | undefined => shell().useFileDecoration(path)

/**
 * Where the cursor should go in the file this tab shows — the target of a search result or any
 * other `openFile({ selection })`. A request made before the editor subscribed is delivered as it
 * subscribes, so subscribe on mount. Wrap the returned undo in the unmount.
 */
export const onRevealInFile = (tabId: TabId, cb: (selection: TextSelection) => void): (() => void) =>
  shell().onRevealInFile(tabId, cb)

/**
 * Called when the user asks for this side panel by keyboard — the panel should take the keyboard,
 * as a search box does. Delivered on subscribe if the request came before the panel mounted.
 */
export const onViewRevealed = (viewId: string, cb: () => void): (() => void) =>
  shell().onViewRevealed(viewId, cb)

/**
 * Whether this tab was opened with `preserveFocus`, so its viewer should leave the keyboard where
 * it is instead of taking it as it mounts. Answers true once, for the open that asked: call it at
 * the moment the viewer would focus itself, not before.
 */
export const openedInBackground = (tabId: TabId): boolean => shell().openedInBackground(tabId)

/**
 * Files a plugin has just renamed or moved for the user — a file tree's Rename, its Cut and Paste,
 * a drag — so the tabs showing them follow, under their new names. A folder covers everything in
 * it. Files moved by other programs are not reported here, and their tabs stay where they were.
 */
export const filesMoved = (moves: FileMove[]): void => shell().filesMoved(moves)

/**
 * Files a plugin has just deleted for the user. Their tabs close, and unsaved changes in them are
 * dropped — so ask about those first, with `unsavedFiles`. A folder covers everything in it.
 */
export const filesDeleted = (paths: string[]): void => shell().filesDeleted(paths)

/** Which files at these paths, or inside them, have unsaved changes. */
export const unsavedFiles = (paths: string[]): string[] => shell().unsavedFiles(paths)

/**
 * Needs `files:read`. `notUtf8` means the bytes were not valid UTF-8 and `content` is a lossy
 * decoding — show it, but never write it back.
 */
export const readFile = (
  path: string
): Promise<{ content: string; truncated: boolean; tooLarge: boolean; notUtf8?: boolean }> => shell().readFile(path)

/** Needs `files:write`. */
export const writeFile = (path: string, content: string): Promise<void> =>
  shell().writeFile(path, content)

/** Needs `files:read`. */
export const listDir = (path: string): Promise<FileStat[]> => shell().listDir(path)

/**
 * Tokenise code with the text editor's own tokenizers: the tokens of each line, in order, or null
 * when no language goes by that name. The name may be a language id, an alias or an extension —
 * `ts`, `typescript` and `TypeScript` all find TypeScript — so a Markdown fence's word can be
 * passed as it is.
 *
 * The tokens' text is the caller's: slice each line at the offsets. That is the point of asking
 * for tokens rather than coloured HTML — HTML from the editor writes spaces as no-break spaces, so
 * code copied out of it would not be the code that was written.
 *
 * Loads the editor's tokenizers the first time, which is megabytes: call it for code that is about
 * to be shown, not speculatively. Since Rigee 1.1.0.
 */
export const tokenizeCode = (text: string, language: string): Promise<CodeToken[][] | null> =>
  shell().tokenizeCode(text, language)

/**
 * The URL to start a Web Worker from, for a script that ships with this plugin.
 *
 * A window may only start a worker from its own origin, and a plugin's files are served from
 * another — `rigee-plugin://` — so `new Worker(new URL('./x.js', import.meta.url))` is refused.
 * Pass the same URL here instead and start the worker from what comes back, as a module worker:
 *
 *   new Worker(workerUrl(new URL('./parse.worker.js', import.meta.url)), { type: 'module' })
 *
 * The script must be self-contained: a worker has no import map, so `react` and this package
 * cannot be imported from inside one. Messages posted before the script has loaded are held until
 * it has, and then delivered. The worker gets no Content Security Policy of its own, so it may
 * compile WebAssembly, which the window may not. Since Rigee 1.1.0.
 */
export const workerUrl = (script: string | URL): string => shell().workerUrl(script)

/**
 * The shell's "this pane has nothing to show" state.
 *
 * A wrapper rather than an entry in `icons`, because a notice is rendered once per failed pane
 * where an icon is rendered once per row — the extra component layer costs nothing here and reads
 * better at the call site.
 */
export function Notice(props: NoticeProps): ReactElement {
  const Impl = shell().Notice
  return <Impl {...props} />
}
