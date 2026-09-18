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
  TmuxConnectionState,
  TmuxPane,
  TmuxWindow,
  Platform,
  ViewBounds,
  Workspace,
  WorkspaceId,
  WorkspaceUiState,
  DiffTarget
} from './types'

/** renderer -> main -> renderer. Every one of these is awaited. */
export interface IpcRequests {
  // --- app -------------------------------------------------------------
  'app:getVersions': () => Record<string, string | undefined>
  'app:getPlatformInfo': () => {
    platform: Platform
    /** Whether a usable tmux was found (through WSL on win32). */
    tmuxAvailable: boolean
    tmuxVersion: string | null
    homeDir: string
  }

  // --- persistence -----------------------------------------------------
  'state:load': () => PersistedState
  'state:saveWorkspaces': (args: {
    workspaces: Workspace[]
    activeWorkspaceId: WorkspaceId | null
  }) => void
  'state:saveUi': (args: { workspaceId: WorkspaceId; ui: WorkspaceUiState }) => void

  // --- workspaces ------------------------------------------------------
  /** Opens a native directory picker; returns null if the user cancelled. */
  'workspace:pickFolder': () => string | null
  /** Resolves whether a path is a git work tree and where its root is. */
  'workspace:probeFolder': (path: string) => { isGitRepo: boolean; repoRoot: string | null }

  // --- filesystem ------------------------------------------------------
  'fs:list': (dir: string) => FileStat[]
  'fs:readFile': (path: string) => { content: string; truncated: boolean; tooLarge: boolean }
  'fs:writeFile': (args: { path: string; content: string }) => void

  // --- tmux ------------------------------------------------------------
  /** Starts (or reuses) the control-mode client for a workspace's session. */
  'tmux:connect': (args: { workspaceId: WorkspaceId; sessionName: string; cwd: string }) => TmuxConnectionState
  'tmux:disconnect': (args: { workspaceId: WorkspaceId }) => void
  'tmux:listState': (args: { workspaceId: WorkspaceId }) => {
    windows: TmuxWindow[]
    panes: TmuxPane[]
  }
  'tmux:newWindow': (args: { workspaceId: WorkspaceId; cwd: string }) => { windowId: string }
  'tmux:splitPane': (args: {
    workspaceId: WorkspaceId
    paneId: string
    direction: 'horizontal' | 'vertical'
  }) => { paneId: string }
  'tmux:killPane': (args: { workspaceId: WorkspaceId; paneId: string }) => void
  'tmux:selectPane': (args: { workspaceId: WorkspaceId; paneId: string }) => void
  /** Tells tmux the client geometry so it re-lays-out panes. Debounced by the caller. */
  'tmux:resizeClient': (args: { workspaceId: WorkspaceId; cols: number; rows: number }) => void
  /** Establishes the MessagePort for this workspace's terminal byte stream. */
  'terminal:requestPort': (args: { workspaceId: WorkspaceId }) => void

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
}

/** main -> renderer push. Low rate; terminal bytes do NOT go through here. */
export interface IpcEvents {
  'tmux:state': {
    workspaceId: WorkspaceId
    connection: TmuxConnectionState
    windows: TmuxWindow[]
    panes: TmuxPane[]
  }
  'tmux:paneExit': { workspaceId: WorkspaceId; paneId: string }
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
  'browser:authRequested': { viewId: string; requestId: string; host: string; realm: string }
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
  'workspace:pickFolder',
  'workspace:probeFolder',
  'fs:list',
  'fs:readFile',
  'fs:writeFile',
  'tmux:connect',
  'tmux:disconnect',
  'tmux:listState',
  'tmux:newWindow',
  'tmux:splitPane',
  'tmux:killPane',
  'tmux:selectPane',
  'tmux:resizeClient',
  'terminal:requestPort',
  'scm:status',
  'scm:statusAll',
  'scm:diff',
  'scm:stage',
  'scm:unstage',
  'scm:discard',
  'scm:commit',
  'scm:watch',
  'browser:create',
  'browser:destroy',
  'browser:setVisible',
  'browser:setBounds',
  'browser:navigate',
  'browser:goBack',
  'browser:goForward',
  'browser:reload',
  'browser:stop',
  'browser:openDevTools'
] as const

export const EVENT_CHANNELS: readonly IpcEventChannel[] = [
  'tmux:state',
  'tmux:paneExit',
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
  onTerminalData(workspaceId: string, cb: (paneId: string, data: Uint8Array) => void): () => void
  writeTerminal(workspaceId: string, paneId: string, data: string): void
}

/** Re-exported so consumers need only one import. */
export type { Tab, Workspace, RepoStatus, TmuxPane, TmuxWindow, FileStat, ViewBounds }
