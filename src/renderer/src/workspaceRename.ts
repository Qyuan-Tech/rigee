import { dirtyPaths, filesMoved, movedPath } from './editing'
import { allTabs } from './groups'
import { rpc } from './ipc'
import { useApp } from './store'
import { persistWorkspaces, reason } from './workspaces'
import { SCRATCH_WORKSPACE_ID, type Workspace, type WorkspaceId } from '@shared/types'
import { workspaceNameProblem } from '@shared/workspaceFiles'
import type { FileMove } from '@rigee/plugin-api'

/**
 * Renaming a workspace: one of the workspace model's operations, kept out of `workspaces.ts` only
 * so that it comes with its form. The rename form is the one way in, nothing of it is on screen at
 * startup, and `pnpm perf:check` holds the entry chunk to a budget that everything that is has to
 * fit in — so this is fetched with the form rather than with the side bar.
 */

/**
 * What renaming this saved workspace's file to `name` would move — the file, and its folder when
 * that goes too — as main works it out; with `apply`, what it moved. Nothing for a workspace with no
 * file. Throws with main's reason, fit to show: a name taken, a file gone, unsaved changes in the way.
 */
export async function workspaceFileRename(ws: Workspace, name: string, apply: boolean): Promise<FileMove[]> {
  if (!ws.filePath) return []
  try {
    const { moves } = await rpc['workspace:renameWorkspaceFile']({
      file: ws.filePath,
      name,
      keep: useApp.getState().workspaces.flatMap((w) => w.folders.map((f) => f.path)),
      unsaved: dirtyPaths(),
      apply
    })
    return moves
  } catch (e) {
    throw new Error(reason(e))
  }
}

/**
 * Call a workspace something else. A saved one is called what its file is called, so its
 * `.code-workspace` file is renamed to match — and the folder it is in, when that was made for it
 * under the workspace files folder — and every tab on something that moved follows it, as does a
 * terminal told to start there. One never saved has no file, and only its name changes.
 *
 * Throws with a message fit to show when the file could not be renamed, and the name stays as it
 * was: a saved workspace and its file are not to disagree.
 */
export async function renameWorkspace(workspaceId: WorkspaceId, name: string): Promise<void> {
  const ws = useApp.getState().workspaces.find((w) => w.id === workspaceId)
  if (!ws || ws.id === SCRATCH_WORKSPACE_ID || name === ws.name) return
  const problem = workspaceNameProblem(name)
  if (problem) throw new Error(problem)
  const moves = await workspaceFileRename(ws, name, true)

  // Read again: the rename waited on main, and the list may have changed meanwhile. Every workspace
  // whose file moved follows it — the same file opened twice is two of them — and one that was
  // called after that file is called after it still.
  const s = useApp.getState()
  s.setWorkspaces(
    s.workspaces.map((w) => {
      const renamed = w.id === workspaceId || (!!ws.filePath && w.filePath === ws.filePath && w.name === ws.name)
      const filePath = w.filePath ? movedPath(moves, w.filePath) : null
      if (!renamed && (!filePath || filePath === w.filePath)) return w
      return { ...w, ...(renamed ? { name } : {}), ...(filePath ? { filePath } : {}) }
    })
  )
  filesMoved(moves)
  const now = useApp.getState()
  for (const [id, row] of Object.entries(now.rowsByWorkspace)) {
    for (const tab of allTabs(row)) {
      if (tab.kind !== 'terminal' || !tab.cwd) continue
      const cwd = movedPath(moves, tab.cwd)
      if (cwd !== tab.cwd) now.updateTab(id, tab.id, { cwd })
    }
  }
  persistWorkspaces()
}
