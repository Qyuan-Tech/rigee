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
  /** As on `PluginTabRequest`: put it beside this tab rather than in the active group. */
  nearTabId?: TabId
}

/** What `pluginTabs` reports about one of a plugin's own tabs. */
export interface PluginTabInfo {
  tabId: TabId
  state: Record<string, unknown>
  key?: string
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
  addWorkspaceFolders: (paths: string[]) => Promise<void>

  // --- tabs ---------------------------------------------------------------
  openPluginTab: (pluginId: PluginId, request: PluginTabRequest) => TabId | null
  openFile: (request: OpenFileRequest) => TabId | null
  patchPluginTab: (
    tabId: TabId,
    patch: { title?: string; tooltip?: string; key?: string; state?: Record<string, unknown> }
  ) => void
  closePluginTab: (tabId: TabId) => void
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

  // --- files (permissioned) ----------------------------------------------
  readFile: (path: string) => Promise<{ content: string; truncated: boolean; tooLarge: boolean }>
  writeFile: (path: string, content: string) => Promise<void>
  listDir: (path: string) => Promise<FileStat[]>

  // --- UI -----------------------------------------------------------------
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
export const addWorkspaceFolders = (paths: string[]): Promise<void> =>
  shell().addWorkspaceFolders(paths)

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

export const patchPluginTab = (
  tabId: TabId,
  patch: { title?: string; tooltip?: string; key?: string; state?: Record<string, unknown> }
): void => shell().patchPluginTab(tabId, patch)

export const closePluginTab = (tabId: TabId): void => shell().closePluginTab(tabId)

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

/** Needs `files:read`. */
export const readFile = (
  path: string
): Promise<{ content: string; truncated: boolean; tooLarge: boolean }> => shell().readFile(path)

/** Needs `files:write`. */
export const writeFile = (path: string, content: string): Promise<void> =>
  shell().writeFile(path, content)

/** Needs `files:read`. */
export const listDir = (path: string): Promise<FileStat[]> => shell().listDir(path)

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
