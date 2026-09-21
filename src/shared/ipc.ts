/**
 * The complete IPC surface, shared by main / preload / renderer.
 *
 * This file must live in src/shared. Importing renderer-facing types out of src/preload makes
 * tsconfig.web.json fail with TS6307.
 *
 * Two transports exist, and the split matters:
 *   - Everything here is request/response or low-rate push, and goes over ipcMain/ipcRenderer.
 *   - Terminal byte streams do NOT appear here. They ride a MessagePort established by
 *     'terminal:requestPort' so they bypass the ipcRenderer router entirely. See src/main/ptyPort.ts.
 */

import type {
  FileStat,
  PersistedState,
  RepoStatus,
  Tab,
  PtyPaneId,
  Platform,
  ViewBounds,
  Workspace,
  WorkspaceFolder,
  WorkspaceId,
  WorkspaceUiState,
  DiffTarget,
  DiffHunkView,
  SelectionAction,
  KeyBindings
} from './types'

/** renderer -> main -> renderer. Every one of these is awaited. */
export interface IpcRequests {
  // --- app -------------------------------------------------------------
  'app:getVersions': () => Record<string, string | undefined>
  'app:getPlatformInfo': () => {
    platform: Platform
    /** The shell terminals will run, for display in the status bar. */
    shell: string
    homeDir: string
  }

  // --- persistence -----------------------------------------------------
  'state:load': () => PersistedState
  'state:saveWorkspaces': (args: {
    workspaces: Workspace[]
    activeWorkspaceId: WorkspaceId | null
  }) => void
  'state:saveUi': (args: { workspaceId: WorkspaceId; ui: WorkspaceUiState }) => void
  /** Persist every workspace's UI in one write, so switching away cannot lose the previous one. */
  'state:saveAllUi': (args: { ui: Record<WorkspaceId, WorkspaceUiState> }) => void
  'state:saveKeybindings': (args: { keybindings: KeyBindings }) => void

  // --- workspaces ------------------------------------------------------
  /** Opens a native directory picker; returns null if the user cancelled. */
  'workspace:pickFolder': () => string | null
  /** Resolves whether a path is a git work tree and where its root is. */
  'workspace:probeFolder': (path: string) => { isGitRepo: boolean; repoRoot: string | null }
  /** Picks a `.code-workspace` file to open; null if cancelled. */
  'workspace:pickWorkspaceFile': () => string | null
  /**
   * Read a `.code-workspace` file and resolve every folder it names, relative paths included.
   * Rejects with a message naming the file if it cannot be parsed.
   */
  'workspace:readWorkspaceFile': (path: string) => {
    name: string
    folders: WorkspaceFolder[]
  }
  /**
   * Prompt for a location and write a `.code-workspace` file holding these folders. Returns the
   * path written, or null if the user cancelled.
   */
  'workspace:saveWorkspaceFile': (args: {
    suggestedName: string
    folders: { path: string; name: string }[]
  }) => string | null

  // --- clipboard -------------------------------------------------------
  /**
   * Terminal copy and paste go through main, not `navigator.clipboard`.
   *
   * The web API requires the document to hold focus and rejects otherwise, which turns copy into
   * something that works almost always and fails without a word the rest of the time. The main
   * process clipboard has no such condition.
   */
  'clipboard:write': (args: { text: string }) => void
  'clipboard:read': () => string

  // --- filesystem ------------------------------------------------------
  'fs:list': (dir: string) => FileStat[]
  'fs:readFile': (path: string) => { content: string; truncated: boolean; tooLarge: boolean }
  'fs:writeFile': (args: { path: string; content: string }) => void

  // --- terminals ---------------------------------------------------------
  /** Start a pty for one pane. The renderer sizes it from its own layout. */
  'terminal:spawn': (args: {
    workspaceId: WorkspaceId
    cwd: string
    cols: number
    rows: number
  }) => { paneId: PtyPaneId }
  'terminal:resize': (args: { paneId: PtyPaneId; cols: number; rows: number }) => void
  'terminal:kill': (args: { paneId: PtyPaneId }) => void
  /** Establish the MessagePort carrying this workspace's terminal bytes, both directions. */
  'terminal:requestPort': (args: { workspaceId: WorkspaceId }) => void
  /** Kill every pane of a workspace and drop its port. */
  'terminal:disconnect': (args: { workspaceId: WorkspaceId }) => void

  // --- source control --------------------------------------------------
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

  // --- browser tabs ----------------------------------------------------
  'browser:create': (args: { tabId: string; url: string; bounds: ViewBounds }) => { viewId: string }
  'browser:destroy': (args: { viewId: string }) => void
  /** Only one browser view is visible at a time; the rest stay alive but hidden. */
  'browser:setVisible': (args: { viewId: string; visible: boolean }) => void
  'browser:setBounds': (args: { viewId: string; bounds: ViewBounds }) => void
  'browser:navigate': (args: { viewId: string; url: string }) => void
  'browser:goBack': (args: { viewId: string }) => void
  'browser:goForward': (args: { viewId: string }) => void
  'browser:reload': (args: { viewId: string }) => void
  'browser:stop': (args: { viewId: string }) => void
  'browser:openDevTools': (args: { viewId: string }) => void
  /**
   * Answer an HTTP 401/407. `username: null` cancels the request, which is what closing the
   * dialog must do — leaving it unanswered would hang the page forever.
   */
  'browser:authResponse': (args: {
    requestId: string
    username: string | null
    password: string
  }) => void
}

/** main -> renderer push. Low rate; terminal bytes do NOT go through here. */
export interface IpcEvents {
  'terminal:exit': { workspaceId: WorkspaceId; paneId: PtyPaneId; exitCode: number }
  'scm:status': { status: RepoStatus }
  'browser:state': {
    viewId: string
    url: string
    title: string
    canGoBack: boolean
    canGoForward: boolean
    loading: boolean
    faviconDataUrl: string | null
  }
  /** A page called window.open and we adopted it; the renderer must register a new tab. */
  'browser:tabRequested': { viewId: string; url: string; openerViewId: string }
  /** HTTP 401/407. The renderer shows a prompt and answers with 'browser:authResponse'. */
  'browser:authRequested': {
    viewId: string
    requestId: string
    host: string
    realm: string
    isProxy: boolean
    url: string
  }
  'fs:changed': { paths: string[] }
  'app:error': { scope: string; message: string }
}

export type IpcRequestChannel = keyof IpcRequests
export type IpcEventChannel = keyof IpcEvents

export const REQUEST_CHANNELS: readonly IpcRequestChannel[] = [
  'app:getVersions',
  'app:getPlatformInfo',
  'state:load',
  'state:saveWorkspaces',
  'state:saveUi',
  'state:saveAllUi',
  'state:saveKeybindings',
  'workspace:pickFolder',
  'workspace:probeFolder',
  'workspace:pickWorkspaceFile',
  'workspace:readWorkspaceFile',
  'workspace:saveWorkspaceFile',
  'clipboard:write',
  'clipboard:read',
  'fs:list',
  'fs:readFile',
  'fs:writeFile',
  'terminal:spawn',
  'terminal:resize',
  'terminal:kill',
  'terminal:requestPort',
  'terminal:disconnect',
  'scm:status',
  'scm:statusAll',
  'scm:diff',
  'scm:stage',
  'scm:unstage',
  'scm:discard',
  'scm:commit',
  'scm:watch',
  'scm:hunks',
  'scm:applySelection',
  'browser:create',
  'browser:destroy',
  'browser:setVisible',
  'browser:setBounds',
  'browser:navigate',
  'browser:goBack',
  'browser:goForward',
  'browser:reload',
  'browser:stop',
  'browser:openDevTools',
  'browser:authResponse'
] as const

export const EVENT_CHANNELS: readonly IpcEventChannel[] = [
  'terminal:exit',
  'scm:status',
  'browser:state',
  'browser:tabRequested',
  'browser:authRequested',
  'fs:changed',
  'app:error'
] as const

/**
 * What the preload puts on window.onestop.
 *
 * MUST stay flat and structured-clonable. contextBridge cannot clone exotic objects; exposing a
 * Proxy here fails at load time with "An object could not be cloned." The ergonomic typed facade
 * is built on the renderer side instead, where a Proxy is legal.
 */
export interface OnestopBridge {
  platform: Platform
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, cb: (payload: unknown) => void): () => void
  /** Terminal byte stream, carried on a MessagePort that never crosses the bridge. */
  onTerminalData(workspaceId: string, cb: (paneId: string, data: string) => void): () => void
  writeTerminal(workspaceId: string, paneId: string, data: string): void
  /** Filesystem path of a dropped File. Empty string when it has none (a synthesised File). */
  pathForFile(file: File): string
}

/** Re-exported so consumers need only one import. */
export type { Tab, Workspace, RepoStatus, FileStat, ViewBounds }
