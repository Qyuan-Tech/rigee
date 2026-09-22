import { useCallback, useEffect, useMemo, useState } from 'react'
import { rpc } from '../ipc'
import {
  ChevronIcon,
  CollapseAllIcon,
  ExpandAllIcon,
  CloseIcon,
  CollapseLeftIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  TerminalIcon
} from '../icons'
import { resolveViewType } from '../plugins/registry'
import { nextTabId, nextWorkspaceId, useActiveWorkspace, useApp } from '../store'
import { SCRATCH_WORKSPACE_ID, type FileStat, type Workspace, type WorkspaceFolder } from '@shared/types'

/**
 * The workspace list, and nothing else.
 *
 * The file tree that used to sit under it is a plugin now (src/plugins/explorer). What is left is
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
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  const persist = useCallback(() => {
    const s = useApp.getState()
    void rpc['state:saveWorkspaces']({
      // Scratch is rebuilt at boot; persisting it would let a stale copy outlive the code.
      workspaces: s.workspaces.filter((w) => w.id !== SCRATCH_WORKSPACE_ID),
      activeWorkspaceId: s.activeWorkspaceId
    })
  }, [])

  const openAsWorkspace = useCallback(
    async (path: string) => {
      const probe = await rpc['workspace:probeFolder'](path)
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
      add({
        id: nextWorkspaceId(),
        name,
        folders: [{ path, name, isGitRepo: probe.isGitRepo, repoRoot: probe.repoRoot }],
        createdAt: Date.now(),
        lastOpenedAt: Date.now()
      } satisfies Workspace)
      persist()
    },
    [add, persist]
  )

  const openFolder = useCallback(async () => {
    const path = await rpc['workspace:pickFolder']()
    if (path) await openAsWorkspace(path)
  }, [openAsWorkspace])

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
      persist()
    } catch (e) {
      // A workspace file that will not parse is the user's file, not a crash of ours.
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [add, persist])

  /**
   * Write the active workspace's folders out as a `.code-workspace` file.
   *
   * This is the only way a multi-root workspace comes into existence, exactly as in VS Code:
   * there is no "new workspace" command. You collect folders — by dropping them on the explorer
   * or adding them — and then save the result.
   */
  const saveWorkspaceAs = useCallback(async () => {
    const s = useApp.getState()
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
    if (!ws || ws.folders.length === 0) return
    const path = await rpc['workspace:saveWorkspaceFile']({
      suggestedName: ws.name,
      folders: ws.folders.map((f) => ({ path: f.path, name: f.name }))
    })
    if (!path) return
    const name = (path.split(/[\\/]/).pop() ?? ws.name).replace(/\.code-workspace$/i, '')
    s.setWorkspaces(s.workspaces.map((w) => (w.id === ws.id ? { ...w, name, filePath: path } : w)))
    persist()
  }, [persist])

  const addFolder = useCallback(async () => {
    const s = useApp.getState()
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
    const path = await rpc['workspace:pickFolder']()
    if (!path) return

    /*
     * Opening a folder from Scratch makes a workspace; it does not add a folder to Scratch.
     *
     * Scratch is the workspace with no folders by definition, and it is synthesised at boot
     * rather than persisted — `persist()` filters it out on every save. So a folder added here
     * used to appear in the explorer, never appear as a workspace beside Scratch, and be silently
     * gone on the next launch, taking the only record of it with it. There is no reading of
     * "open this repo" that this satisfies.
     */
    if (!ws || ws.id === SCRATCH_WORKSPACE_ID) {
      await openAsWorkspace(path)
      return
    }

    if (ws.folders.some((f) => f.path === path)) return
    const probe = await rpc['workspace:probeFolder'](path)
    const folder: WorkspaceFolder = {
      path,
      name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
      isGitRepo: probe.isGitRepo,
      repoRoot: probe.repoRoot
    }
    s.setWorkspaces(s.workspaces.map((w) => (w.id === ws.id ? { ...w, folders: [...w.folders, folder] } : w)))
    persist()
  }, [openAsWorkspace, persist])

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
          onAddFolder={() => { setMenuOpen(false); void addFolder() }}
          onSaveAs={() => { setMenuOpen(false); void saveWorkspaceAs() }}
          canAddFolder={activeId !== null && activeId !== SCRATCH_WORKSPACE_ID}
          canSave={(workspaces.find((w) => w.id === activeId)?.folders.length ?? 0) > 0}
        />
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
              onClick={() => { setActive(w.id); persist() }}
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
                      onClick={(e) => { e.stopPropagation(); remove(w.id); persist() }}
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
