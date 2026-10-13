import { rpc } from './ipc'
import { nextWorkspaceId, useApp } from './store'
import {
  SCRATCH_WORKSPACE_ID,
  type AppSettings,
  type Workspace,
  type WorkspaceFolder,
  type WorkspaceId
} from '@shared/types'
import { workspaceFileDir } from '@shared/workspaceFiles'

/**
 * The workspace model's own operations: opening folders as a workspace, adding folders to one,
 * saving one as a `.code-workspace` file — and where its terminals start.
 *
 * In one place because there are several ways in. The side bar's + menu, the menu a workspace
 * opens when right-clicked, a folder dropped on the explorer and the prompt a new terminal shows
 * all do these things, and the rules — Scratch never takes a folder, a saved workspace's file
 * keeps up with its folders — are the same whichever way the user came.
 */

/** Write the workspace list now. */
export function persistWorkspaces(): void {
  const s = useApp.getState()
  void rpc['state:saveWorkspaces']({
    // Scratch is rebuilt at boot; persisting it would let a stale copy outlive the code.
    workspaces: s.workspaces.filter((w) => w.id !== SCRATCH_WORKSPACE_ID),
    activeWorkspaceId: s.activeWorkspaceId
  })
}

const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** One git spawn per folder, so all at once: a workspace of a dozen repos is what this is for. */
function probeFolders(paths: readonly string[]): Promise<WorkspaceFolder[]> {
  return Promise.all(
    paths.map(async (path) => {
      const probe = await rpc['workspace:probeFolder'](path)
      return { path, name: folderName(path), isGitRepo: probe.isGitRepo, repoRoot: probe.repoRoot }
    })
  )
}

/** A new workspace of these folders, named after the first, and switched to. */
export async function openAsWorkspace(paths: readonly string[]): Promise<void> {
  const [first, ...rest] = await probeFolders(paths)
  if (!first) return
  useApp.getState().addWorkspace({
    id: nextWorkspaceId(),
    name: first.name,
    folders: [first, ...rest],
    createdAt: Date.now(),
    lastOpenedAt: Date.now()
  } satisfies Workspace)
  persistWorkspaces()
}

/**
 * Add folders to a workspace — and to its `.code-workspace` file, when it has one, which is what
 * makes the file the workspace rather than a snapshot of how it once was.
 *
 * Adding to Scratch makes a NEW workspace instead. Scratch is the workspace with no folders by
 * definition, synthesised at boot rather than persisted, so a folder added to it used to appear in
 * the explorer, never appear as a workspace, and be gone on the next launch.
 *
 * The folders join the workspace even if the file cannot take them — moved, deleted, unwritable —
 * since joining is what was asked for; the side bar says the file was left behind, and Save
 * Workspace As… writes it again.
 */
export async function addFolders(workspaceId: WorkspaceId, paths: readonly string[]): Promise<void> {
  const ws = useApp.getState().workspaces.find((w) => w.id === workspaceId)
  if (!ws || ws.id === SCRATCH_WORKSPACE_ID) {
    await openAsWorkspace(paths)
    return
  }
  const fresh = [...new Set(paths)].filter((p) => !ws.folders.some((f) => f.path === p))
  if (fresh.length === 0) return
  const probed = await probeFolders(fresh)

  // Read again: probing took a git spawn per folder, and the list may have changed meanwhile.
  const s = useApp.getState()
  const now = s.workspaces.find((w) => w.id === workspaceId)
  if (!now) return
  const added = probed.filter((f) => !now.folders.some((g) => g.path === f.path))
  if (added.length === 0) return
  s.setWorkspaces(s.workspaces.map((w) => (w.id === workspaceId ? { ...w, folders: [...w.folders, ...added] } : w)))
  persistWorkspaces()

  if (!now.filePath) return
  try {
    await rpc['workspace:addFoldersToFile']({
      file: now.filePath,
      folders: added.map((f) => ({ path: f.path, name: f.name }))
    })
  } catch (e) {
    // Main's reasons name the file, so this does not.
    useApp.getState().setWorkspaceError(
      `Added to “${now.name}”, but its workspace file could not be updated: ${reason(e).replace(/\.?$/, '.')} ` +
        'Save Workspace As… writes it again.'
    )
  }
}

/**
 * Write a workspace's folders out as a `.code-workspace` file, which is then the file that
 * workspace is: it takes the file's name, and its terminals start in the folder the file is in.
 *
 * `named` files it under the workspace files folder from Settings, asking nothing; `pick` asks
 * where with a save dialog. True once written, false if the user cancelled. Throws with a message
 * fit to show when it could not be written — a folder that is not writable is the user's to fix.
 */
export async function saveWorkspaceFile(
  workspaceId: WorkspaceId,
  name: string,
  location: 'named' | 'pick'
): Promise<boolean> {
  const ws = useApp.getState().workspaces.find((w) => w.id === workspaceId)
  if (!ws || ws.folders.length === 0) return false
  let path: string | null
  try {
    path = await rpc['workspace:saveWorkspaceFile']({
      name,
      folders: ws.folders.map((f) => ({ path: f.path, name: f.name })),
      location,
      current: ws.filePath ?? null
    })
  } catch (e) {
    throw new Error(reason(e))
  }
  if (!path) return false
  const filePath = path
  const saved = (filePath.split(/[\\/]/).pop() ?? name).replace(/\.code-workspace$/i, '')
  // Read again: the save may have waited on a dialog, and the list may have changed meanwhile.
  const now = useApp.getState()
  now.setWorkspaces(now.workspaces.map((w) => (w.id === workspaceId ? { ...w, name: saved, filePath } : w)))
  persistWorkspaces()
  return true
}

/**
 * The workspace's own folder: the one its `.code-workspace` file is in. Null when it has no file —
 * never saved, opened as a plain folder, or Scratch.
 *
 * With a workspace files folder in Settings it is `<folder>/<name>/`, made for it, while the folders
 * the workspace lists are typically repos that each belong to something else. Its terminals start
 * here, and the explorer heads its tree with it; one definition, so the two cannot disagree.
 */
export function workspaceDir(ws: Workspace): string | null {
  return ws.filePath ? workspaceFileDir(ws.filePath) : null
}

/**
 * Where a new terminal in this workspace starts, when it is not a split of one already running.
 *
 * A saved workspace starts in its own folder (see `workspaceDir`), because an agent started in one
 * of its repos sees that repo rather than the workspace. Unsaved, there is no such folder, and the
 * first one stands in. A folder that has gone since is main's to notice: it starts the shell at home.
 */
export function terminalCwd(ws: Workspace): string {
  return workspaceDir(ws) ?? ws.folders[0]?.path ?? ws.defaultCwd ?? '.'
}

/**
 * Whether a terminal opened here asks first to save the workspace: one that could be saved — not
 * Scratch, at least one folder — and has not been, while the user still wants to be asked.
 */
export function remindsToSave(ws: Workspace, settings: AppSettings): boolean {
  return (
    settings.remindToSaveWorkspace !== false &&
    ws.id !== SCRATCH_WORKSPACE_ID &&
    ws.folders.length > 0 &&
    !ws.filePath
  )
}

/** Stop asking. Kept in Settings, where the General page can turn it back on. */
export function stopRemindingToSave(): void {
  const settings: AppSettings = { ...useApp.getState().settings, remindToSaveWorkspace: false }
  useApp.getState().setSettings(settings)
  void rpc['state:saveSettings']({ settings })
}

/**
 * The part of a failed request worth reading. Electron wraps what main threw as "Error invoking
 * remote method 'x': Error: x: …", and `handle` adds the channel again; the user wants the end.
 */
export function reason(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message
    .replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
    .replace(/^[\w-]+:[\w-]+: /, '')
}
