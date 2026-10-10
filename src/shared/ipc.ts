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
  AppSettings,
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
import type {
  PluginEventEnvelope,
  PluginId,
  PluginInvocation,
  PluginManifest,
  PluginPermission
} from '@rigee/plugin-api/manifest'

/**
 * One plugin installed from disk.
 *
 * MUST BE CLONABLE, all the way down: it crosses contextBridge, which refuses functions with
 * "An object could not be cloned" — an error that arrives at the caller naming no cause. That is
 * why only DISK manifests travel: they come from JSON, so they cannot contain a function, whereas
 * a bundled manifest may hold a `match` predicate as its file selector. The renderer composes the
 * full list from these plus the manifests it already has statically.
 */
export interface InstalledPluginInfo {
  manifest: PluginManifest
  trust:
    | { status: 'trusted' }
    | { status: 'untrusted' }
    | { status: 'changed'; approvedVersion: string }
    | { status: 'needs-permissions'; added: PluginPermission[] }
  permissions: PluginPermission[]
  version: string
  /**
   * Where the renderer imports this plugin's renderer half from, when there is one to import.
   *
   * A `rigee-plugin://` URL, and null unless the plugin is trusted as it stands — so "can the
   * renderer load this?" is answered by main, which owns the trust store, rather than re-derived
   * on the other side of the bridge from a status string.
   */
  rendererUrl: string | null
}

/**
 * One row of a native context menu: a command to pick, or a separator.
 *
 * Plain data, because it crosses the bridge. What a command DOES stays with whoever asked for the
 * menu, which gets back the `id` of the row picked.
 */
export type ContextMenuItem =
  | { kind: 'item'; id: string; label: string; enabled?: boolean }
  | { kind: 'separator' }

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
  /**
   * Ghostty's `toggle_fullscreen`. Through main because the renderer's Fullscreen API would put
   * one ELEMENT full screen, not the window — the macOS green-button kind, with its own Space.
   */
  'window:toggleFullScreen': () => void

  // --- persistence -----------------------------------------------------
  'state:load': () => PersistedState
  'state:saveWorkspaces': (args: {
    workspaces: Workspace[]
    activeWorkspaceId: WorkspaceId | null
  }) => void
  /** Persist every workspace's UI in one write, so switching away cannot lose the previous one. */
  'state:saveAllUi': (args: { ui: Record<WorkspaceId, WorkspaceUiState> }) => void
  'state:saveKeybindings': (args: { keybindings: KeyBindings }) => void
  /** The settings dialog's General page. Replaces what is stored, unknown fields included. */
  'state:saveSettings': (args: { settings: AppSettings }) => void
  /**
   * Switch plugins on and off.
   *
   * Not a plugin command — it is about plugins, so routing it through the plugin command registry
   * would mean asking a plugin to authorise its own disabling. Main persists the set and stops the
   * main halves; the renderer stops its own and re-reads the contribution tables.
   */
  'state:setDisabledPlugins': (args: { disabled: string[] }) => void

  // --- unsaved changes -------------------------------------------------
  /** Which files have unsaved changes, reported as it changes. See src/main/unsaved.ts. */
  'app:setDirtyFiles': (args: { files: string[] }) => void
  /** The answer to an 'app:saveAll' event: whether everything was saved. */
  'app:saveAllDone': (args: { id: number; ok: boolean }) => void
  /** Ask the user about unsaved files a closing tab would take with it. A native dialog. */
  'dialog:unsaved': (args: { files: string[]; quitting: boolean }) => 'save' | 'discard' | 'cancel'
  /**
   * Ask before closing tabs stops programs still running in their terminals — `processes` names
   * them, `tabs` is how many tabs are closing. True means close anyway. A native dialog.
   */
  'dialog:closeRunning': (args: { processes: string[]; tabs: number }) => boolean

  // --- menus -----------------------------------------------------------
  /**
   * Show a native context menu at the pointer. Resolves with the id of the row picked, or null when
   * the menu was dismissed.
   *
   * Native rather than drawn in the page, because a browser tab's page is a native view composited
   * OVER the page: a menu drawn in the DOM anywhere near one is drawn underneath it, and never
   * appears. The tab strip is exactly that case — right-clicking a browser tab puts its page on
   * screen, right where the menu opens.
   */
  'menu:popup': (args: { items: ContextMenuItem[] }) => string | null

  // --- shortcuts -------------------------------------------------------
  /**
   * What each key types unshifted on the user's layout, for main's matching of keys pressed in a
   * browser page (src/main/shortcuts.ts). Only the renderer can read the layout.
   */
  'shortcuts:setLayout': (args: { map: Record<string, string> }) => void

  // --- workspaces ------------------------------------------------------
  /**
   * Opens a native directory picker; returns null if the user cancelled. Without arguments it asks
   * for a folder to add to the workspace; the settings dialog asks for something else, starting
   * from wherever its answer currently is.
   */
  'workspace:pickFolder': (args?: { message?: string; defaultPath?: string }) => string | null
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
   * Write a `.code-workspace` file holding these folders. Returns the path written, or null if the
   * user cancelled.
   *
   * `named` files it without asking where: `<folder>/<name>/<name>.code-workspace`, under the
   * workspace files folder from Settings, asking only before it replaces some other workspace's
   * file. `pick` asks where with a save dialog, and `name` is only what it suggests.
   */
  'workspace:saveWorkspaceFile': (args: {
    name: string
    folders: { path: string; name: string }[]
    location: 'named' | 'pick'
    /** The file this workspace came from, if any: replaced without asking, and where `pick` starts. */
    current?: string | null
  }) => string | null
  /**
   * Add folders to an existing `.code-workspace` file, the folder having just been added to the
   * workspace it is. Everything else in the file stays as it was, comments included; folders it
   * already names are skipped. Rejects with a message fit to show when the file cannot be updated.
   */
  'workspace:addFoldersToFile': (args: { file: string; folders: { path: string; name: string }[] }) => void

  // --- clipboard -------------------------------------------------------
  /**
   * Terminal copy and paste go through main, not `navigator.clipboard`.
   *
   * The web API requires the document to hold focus and rejects otherwise, which turns copy into
   * something that works almost always and fails without a word the rest of the time. The main
   * process clipboard has no such condition.
   */
  'clipboard:write': (args: { text: string }) => void
  /**
   * `selection` is the X11/Wayland PRIMARY selection — whatever was last selected anywhere, which
   * is what Linux means by "paste the selection". Linux only; elsewhere it reads as empty.
   */
  'clipboard:read': (args?: { selection?: boolean }) => string

  // --- filesystem ------------------------------------------------------
  'fs:list': (dir: string) => FileStat[]
  'fs:readFile': (path: string) => {
    content: string
    truncated: boolean
    tooLarge: boolean
    /** The bytes are not valid UTF-8, so `content` is lossy and must not be written back. */
    notUtf8?: boolean
  }
  'fs:writeFile': (args: { path: string; content: string }) => void

  // --- terminals ---------------------------------------------------------
  /** Start a pty for one pane. The renderer sizes it from its own layout. */
  'terminal:spawn': (args: {
    workspaceId: WorkspaceId
    cwd: string
    /**
     * A live pane whose directory this one starts in — where that pane's shell is NOW, `cd` and
     * all. A split opens beside the pane it was split from, as it does in Ghostty and iTerm. `cwd`
     * stands in when that pane is gone or its directory cannot be read.
     */
    cwdFrom?: PtyPaneId
    cols: number
    rows: number
  }) => { paneId: PtyPaneId }
  'terminal:resize': (args: { paneId: PtyPaneId; cols: number; rows: number }) => void
  'terminal:kill': (args: { paneId: PtyPaneId }) => void
  /**
   * Which of these panes have a program running in the foreground rather than a shell waiting at
   * its prompt, and what each program is called. Empty where the platform cannot tell (Windows).
   */
  'terminal:running': (args: { paneIds: PtyPaneId[] }) => Array<{ paneId: PtyPaneId; process: string }>
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

  /**
   * The plugins installed from disk, with their trust state.
   *
   * A SHELL channel, not a plugin one — the allowlist above still grows only for the shell's own
   * features, and a plugin still cannot add a channel of its own. Managing plugins is exactly the
   * kind of thing the shell has to keep for itself: a plugin that could approve a plugin would
   * make the trust model decorative.
   */
  'plugins:list': () => InstalledPluginInfo[]
  /**
   * Approve or withdraw approval for one disk plugin.
   *
   * Approval pins the plugin's current hash and permissions; see src/main/plugins/trust.ts.
   */
  'plugins:setTrust': (args: { id: PluginId; trusted: boolean }) => { ok: boolean; reason?: string }
}

/** main -> renderer push. Low rate; terminal bytes do NOT go through here. */
export interface IpcEvents {
  'terminal:exit': { workspaceId: WorkspaceId; paneId: PtyPaneId; exitCode: number }
  /** Everything a plugin pushes, enveloped with its id. See src/shared/plugin.ts. */
  'plugin:event': PluginEventEnvelope
  'fs:changed': { paths: string[] }
  'app:error': { scope: string; message: string }
  /**
   * An app shortcut pressed while a page had the keyboard — a browser tab, whose keys never reach
   * the shell's renderer. Main matched it against the keymap; the renderer runs it. See
   * src/main/shortcuts.ts.
   */
  'shortcuts:run': { action: string }
  /** Main is about to quit or close the window and the user chose Save: save everything. */
  'app:saveAll': { id: number }
}

export type IpcRequestChannel = keyof IpcRequests
export type IpcEventChannel = keyof IpcEvents

export const REQUEST_CHANNELS: readonly IpcRequestChannel[] = [
  'app:getVersions',
  'app:getPlatformInfo',
  'window:toggleFullScreen',
  'state:load',
  'state:saveWorkspaces',
  'state:saveAllUi',
  'state:saveKeybindings',
  'state:saveSettings',
  'state:setDisabledPlugins',
  'app:setDirtyFiles',
  'app:saveAllDone',
  'dialog:unsaved',
  'dialog:closeRunning',
  'menu:popup',
  'shortcuts:setLayout',
  'workspace:pickFolder',
  'workspace:probeFolder',
  'workspace:pickWorkspaceFile',
  'workspace:readWorkspaceFile',
  'workspace:saveWorkspaceFile',
  'workspace:addFoldersToFile',
  'clipboard:write',
  'clipboard:read',
  'fs:list',
  'fs:readFile',
  'fs:writeFile',
  'terminal:spawn',
  'terminal:resize',
  'terminal:kill',
  'terminal:running',
  'terminal:requestPort',
  'terminal:disconnect',
  'plugin:invoke',
  'plugins:list',
  'plugins:setTrust'
] as const

export const EVENT_CHANNELS: readonly IpcEventChannel[] = [
  'terminal:exit',
  'plugin:event',
  'fs:changed',
  'app:error',
  'shortcuts:run',
  'app:saveAll'
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
