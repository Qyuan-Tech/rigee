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
  Tab,
  PtyPaneId,
  Platform,
  ViewBounds,
  Workspace,
  WorkspaceFolder,
  WorkspaceId,
  WorkspaceUiState,
  KeyBindings
} from './types'
import type { PluginEventEnvelope, PluginInvocation } from '@rigee/plugin-api/manifest'

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
  /** Persist every workspace's UI in one write, so switching away cannot lose the previous one. */
  'state:saveAllUi': (args: { ui: Record<WorkspaceId, WorkspaceUiState> }) => void
  'state:saveKeybindings': (args: { keybindings: KeyBindings }) => void
  /**
   * Switch plugins on and off.
   *
   * Not a plugin command — it is about plugins, so routing it through the plugin command registry
   * would mean asking a plugin to authorise its own disabling. Main persists the set and stops the
   * main halves; the renderer stops its own and re-reads the contribution tables.
   */
  'state:setDisabledPlugins': (args: { disabled: string[] }) => void

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

  // --- plugins ---------------------------------------------------------
  /**
   * Every renderer→main plugin call, on one channel.
   *
   * Source control and the browser used to own twenty-two channels between them here. They are
   * plugins now, and their commands are typed beside them — see plugins/scm/protocol.ts and
   * plugins/browser/protocol.ts. The allowlist below grew by two entries and stops there,
   * which is the whole point: it stays a literal that can be read and audited.
   */
  'plugin:invoke': (args: PluginInvocation) => unknown
}

/** main -> renderer push. Low rate; terminal bytes do NOT go through here. */
export interface IpcEvents {
  'terminal:exit': { workspaceId: WorkspaceId; paneId: PtyPaneId; exitCode: number }
  /** Everything a plugin pushes, enveloped with its id. See src/shared/plugin.ts. */
  'plugin:event': PluginEventEnvelope
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
  'state:saveAllUi',
  'state:saveKeybindings',
  'state:setDisabledPlugins',
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
  'plugin:invoke'
] as const

export const EVENT_CHANNELS: readonly IpcEventChannel[] = [
  'terminal:exit',
  'plugin:event',
  'fs:changed',
  'app:error'
] as const

/**
 * What the preload puts on window.rigee.
 *
 * MUST stay flat and structured-clonable. contextBridge cannot clone exotic objects; exposing a
 * Proxy here fails at load time with "An object could not be cloned." The ergonomic typed facade
 * is built on the renderer side instead, where a Proxy is legal.
 */
export interface RigeeBridge {
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
export type { Tab, Workspace, FileStat, ViewBounds }
