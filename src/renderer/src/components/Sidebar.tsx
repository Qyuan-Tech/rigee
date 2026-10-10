import { Suspense, useCallback, useEffect, useState } from 'react'
import { rpc } from '../ipc'
import { CloseIcon, CollapseLeftIcon, FolderIcon, PlusIcon, TerminalIcon } from '../icons'
import { popupMenu } from '../contextMenu'
import { closeTabsSafely } from '../editing'
import { allTabs } from '../groups'
import { nextWorkspaceId, rowOf, useApp } from '../store'
import {
  addFolders,
  openAsWorkspace,
  persistWorkspaces,
  reason,
  saveWorkspaceFile
} from '../workspaces'
import { SaveAsForm } from './LazySaveWorkspace'
import { SCRATCH_WORKSPACE_ID, type Workspace, type WorkspaceId } from '@shared/types'

/**
 * The workspace list, and nothing else.
 *
 * The file tree that used to sit under it is a plugin now (plugins/explorer). What is left is
 * the workspace model's own UI — opening folders and `.code-workspace` files, switching between
 * them, saving one out — which is the shell's, because the workspace model is the shell's. It
 * stays pinned above the activity bar's panel rather than becoming one of the switchable views:
 * which project you are in is context for every view, not a view of its own.
 */
export function Sidebar({ onCollapse }: { onCollapse: () => void }): React.ReactElement {
  return <WorkspaceList onCollapse={onCollapse} />
}

// ---------------------------------------------------------------------------

function WorkspaceList({ onCollapse }: { onCollapse: () => void }): React.ReactElement {
  const workspaces = useApp((s) => s.workspaces)
  const activeId = useApp((s) => s.activeWorkspaceId)
  const setActive = useApp((s) => s.setActiveWorkspace)
  const add = useApp((s) => s.addWorkspace)
  const remove = useApp((s) => s.removeWorkspace)
  const workspaceFilesDir = useApp((s) => s.settings.workspaceFilesDir)
  const error = useApp((s) => s.workspaceError)
  const setError = useApp((s) => s.setWorkspaceError)
  const [menuOpen, setMenuOpen] = useState(false)
  /**
   * Which workspace the name form "Save Workspace As…" shows is for, when there is a workspace
   * files folder to save in. Not necessarily the active one: a right-clicked workspace saves as
   * itself without being switched to.
   */
  const [naming, setNaming] = useState<WorkspaceId | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const dismiss = (): void => setMenuOpen(false)
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', dismiss)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', dismiss)
    }
  }, [menuOpen])

  // A click anywhere else puts the name form away, as it does the menu. Keys do not: they are
  // what is typed into it.
  useEffect(() => {
    if (!naming) return
    const dismiss = (): void => setNaming(null)
    window.addEventListener('mousedown', dismiss)
    return () => window.removeEventListener('mousedown', dismiss)
  }, [naming])

  const openFolder = useCallback(async () => {
    const path = await rpc['workspace:pickFolder']()
    if (path) await openAsWorkspace([path])
  }, [])

  /**
   * Open a `.code-workspace` file: one workspace holding every folder the file names.
   *
   * This is the multi-root half of VS Code's model. A plain folder is a workspace on its own; a
   * workspace file is how several repos become one.
   */
  const openWorkspaceFile = useCallback(async () => {
    const path = await rpc['workspace:pickWorkspaceFile']()
    if (!path) return
    try {
      const { name, folders } = await rpc['workspace:readWorkspaceFile'](path)
      add({
        id: nextWorkspaceId(),
        name,
        folders,
        filePath: path,
        createdAt: Date.now(),
        lastOpenedAt: Date.now()
      } satisfies Workspace)
      persistWorkspaces()
    } catch (e) {
      // A workspace file that will not parse is the user's file, not a crash of ours.
      setError(reason(e))
    }
  }, [add, setError])

  /** Save a workspace's file, saying here why when it could not be. True once written. */
  const save = useCallback(
    async (workspaceId: WorkspaceId, name: string, location: 'named' | 'pick'): Promise<boolean> => {
      try {
        const saved = await saveWorkspaceFile(workspaceId, name, location)
        if (saved) setError(null)
        return saved
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return false
      }
    },
    [setError]
  )

  /**
   * "Save Workspace As…".
   *
   * This is the only way a multi-root workspace comes into existence, exactly as in VS Code:
   * there is no "new workspace" command. You collect folders — by dropping them on the explorer
   * or adding them — and then save the result.
   *
   * With a workspace files folder in Settings, a name is all there is to ask: the file goes in a
   * folder of its own under it. Without one, a save dialog asks where, as it always did.
   */
  const saveWorkspaceAs = useCallback(
    (workspaceId: WorkspaceId) => {
      const s = useApp.getState()
      const ws = s.workspaces.find((w) => w.id === workspaceId)
      if (!ws || ws.folders.length === 0) return
      if (s.settings.workspaceFilesDir) setNaming(ws.id)
      else void save(ws.id, ws.name, 'pick')
    },
    [save]
  )

  /**
   * Add a folder to a workspace — and, when the workspace has been saved, to its file, so that
   * opening the file elsewhere brings the folder along. See `addFolders`.
   */
  const addFolder = useCallback(async (workspaceId: WorkspaceId) => {
    const ws = useApp.getState().workspaces.find((w) => w.id === workspaceId)
    // Named in the picker: from the right-click menu the workspace need not be the one on screen.
    const named = ws && ws.id !== SCRATCH_WORKSPACE_ID
    const path = await rpc['workspace:pickFolder'](named ? { message: `Add a folder to “${ws.name}”` } : undefined)
    if (path) await addFolders(workspaceId, [path])
  }, [])

  /** Its tabs go with it, so its unsaved files are asked about first, as closing those tabs would ask. */
  const removeWorkspace = useCallback(
    (workspaceId: WorkspaceId) => {
      const ids = allTabs(rowOf(useApp.getState(), workspaceId)).map((t) => t.id)
      void closeTabsSafely(workspaceId, ids).then((closed) => {
        if (!closed) return
        remove(workspaceId)
        persistWorkspaces()
      })
    },
    [remove]
  )

  /**
   * A workspace's own menu, on right-click: what the + menu offers for the active workspace, for
   * this one — whichever it is, without switching to it. Greyed rather than left out where there is
   * nothing for an item to do, so the menu keeps its shape from row to row, as the tab menu does.
   *
   * Native, like the tab menu. Nothing could cover a menu drawn in the side bar, but two kinds of
   * context menu in one window, drawn two different ways, would be one too many.
   */
  const showWorkspaceMenu = useCallback(
    async (w: Workspace) => {
      const scratch = w.id === SCRATCH_WORKSPACE_ID
      const choice = await popupMenu([
        { kind: 'item', id: 'add-folder', label: 'Add Folder to Workspace…', enabled: !scratch },
        { kind: 'item', id: 'save-as', label: 'Save Workspace As…', enabled: w.folders.length > 0 },
        { kind: 'separator' },
        { kind: 'item', id: 'remove', label: 'Remove Workspace', enabled: !scratch }
      ])
      if (choice === 'add-folder') void addFolder(w.id)
      else if (choice === 'save-as') saveWorkspaceAs(w.id)
      else if (choice === 'remove') removeWorkspace(w.id)
    },
    [addFolder, saveWorkspaceAs, removeWorkspace]
  )

  const activeWorkspace = workspaces.find((w) => w.id === activeId)
  const namingWorkspace = workspaces.find((w) => w.id === naming)

  return (
    <div style={{ flex: '0 0 auto', borderBottom: '1px solid var(--border)', position: 'relative' }}>
      <div className="section-header">
        <span className="section-header__title">Workspaces</span>
        <button
          className="icon-button"
          title="Open…"
          onMouseDown={(e) => { e.stopPropagation(); setMenuOpen((o) => !o) }}
        >
          <PlusIcon size={14} />
        </button>
        <button className="icon-button" title="Collapse panel" onClick={onCollapse}>
          <CollapseLeftIcon size={14} />
        </button>
      </div>

      {menuOpen && (
        <OpenMenu
          onFolder={() => { setMenuOpen(false); void openFolder() }}
          onWorkspaceFile={() => { setMenuOpen(false); void openWorkspaceFile() }}
          onAddFolder={() => { setMenuOpen(false); if (activeId) void addFolder(activeId) }}
          onSaveAs={() => { setMenuOpen(false); if (activeId) saveWorkspaceAs(activeId) }}
          canAddFolder={activeId !== null && activeId !== SCRATCH_WORKSPACE_ID}
          canSave={(activeWorkspace?.folders.length ?? 0) > 0}
        />
      )}

      {namingWorkspace && workspaceFilesDir && (
        <Suspense fallback={null}>
          <SaveAsForm
            // A fresh form for each workspace: the name typed for one is not a name for another.
            key={namingWorkspace.id}
            className="menu menu--inline"
            popup
            title={namingWorkspace.id === activeId ? 'Save workspace as' : `Save “${namingWorkspace.name}” as`}
            initialName={namingWorkspace.name}
            dir={workspaceFilesDir}
            onSave={async (name) => { if (await save(namingWorkspace.id, name, 'named')) setNaming(null) }}
            onElsewhere={async (name) => { setNaming(null); await save(namingWorkspace.id, name, 'pick') }}
            onCancel={() => setNaming(null)}
          />
        </Suspense>
      )}

      {error && (
        <div className="error-banner" onClick={() => setError(null)} title="Dismiss">
          {error}
        </div>
      )}

      <div style={{ maxHeight: 220, overflowY: 'auto', paddingBottom: 4 }}>
        {workspaces.map((w) => {
          const scratch = w.id === SCRATCH_WORKSPACE_ID
          return (
            <div
              key={w.id}
              className={`row row--clickable${w.id === activeId ? ' row--selected' : ''}`}
              onClick={() => { setActive(w.id); persistWorkspaces() }}
              onContextMenu={(e) => {
                e.preventDefault()
                void showWorkspaceMenu(w)
              }}
            >
              <span style={{ color: 'var(--fg-faint)', display: 'grid', placeItems: 'center' }}>
                {scratch ? <TerminalIcon size={13} /> : <FolderIcon size={13} />}
              </span>
              <span className="row__label">{w.name}</span>
              {scratch ? (
                <span className="row__meta" title="Always available; no folders">—</span>
              ) : (
                <>
                  <span className="row__meta row__meta--hide-on-hover">{w.folders.length}</span>
                  <span className="row__actions">
                    <button
                      className="icon-button"
                      title="Remove workspace"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeWorkspace(w.id)
                      }}
                    >
                      <CloseIcon size={11} />
                    </button>
                  </span>
                </>
              )}
            </div>
          )
        })}
        {workspaces.length <= 1 && (
          <div className="muted" style={{ paddingTop: 4 }}>
            Scratch is always here for terminals. Press + to add a folder as a workspace.
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The workspace menu.
 *
 * There is no "new workspace" item, deliberately — VS Code has none either, and inventing one
 * would imply an empty workspace exists as a thing you can hold. A workspace is a folder you
 * opened, or a set of folders you collected and then saved as a file.
 */
function OpenMenu({
  onFolder,
  onWorkspaceFile,
  onAddFolder,
  onSaveAs,
  canAddFolder,
  canSave
}: {
  onFolder: () => void
  onWorkspaceFile: () => void
  onAddFolder: () => void
  onSaveAs: () => void
  canAddFolder: boolean
  canSave: boolean
}): React.ReactElement {
  return (
    <div
      className="menu menu--inline"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button className="menu__item" onClick={onFolder}>
        <span>Open Folder…</span>
      </button>
      <button className="menu__item" onClick={onWorkspaceFile}>
        <span>Open Workspace File…</span>
        <span className="menu__hint">.code-workspace</span>
      </button>
      <div className="menu__sep" />
      <button className="menu__item" disabled={!canAddFolder} onClick={onAddFolder}>
        <span>Add Folder to Workspace…</span>
      </button>
      <button className="menu__item" disabled={!canSave} onClick={onSaveAs}>
        <span>Save Workspace As…</span>
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
