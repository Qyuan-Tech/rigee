import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { platform, rpc } from '../ipc'
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
import { closeTabsSafely } from '../editing'
import { allTabs } from '../groups'
import { nextTabId, nextWorkspaceId, rowOf, useActiveWorkspace, useApp } from '../store'
import { SCRATCH_WORKSPACE_ID, type FileStat, type Workspace, type WorkspaceFolder } from '@shared/types'
import { namedWorkspaceFile, workspaceNameProblem } from '@shared/workspaceFiles'

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
  const [menuOpen, setMenuOpen] = useState(false)
  /** The name form "Save Workspace As…" shows when there is a workspace files folder to save in. */
  const [naming, setNaming] = useState(false)
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

  // A click anywhere else puts the name form away, as it does the menu. Keys do not: they are
  // what is typed into it.
  useEffect(() => {
    if (!naming) return
    const dismiss = (): void => setNaming(false)
    window.addEventListener('mousedown', dismiss)
    return () => window.removeEventListener('mousedown', dismiss)
  }, [naming])

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
   * Write the active workspace's folders out as a `.code-workspace` file, which is then the file
   * this workspace is — its name is the file's. True once written; false if the user cancelled or
   * it failed, having said why.
   */
  const writeWorkspaceFile = useCallback(
    async (name: string, location: 'named' | 'pick'): Promise<boolean> => {
      const s = useApp.getState()
      const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
      if (!ws || ws.folders.length === 0) return false
      try {
        const path = await rpc['workspace:saveWorkspaceFile']({
          name,
          folders: ws.folders.map((f) => ({ path: f.path, name: f.name })),
          location,
          current: ws.filePath ?? null
        })
        if (!path) return false
        const saved = (path.split(/[\\/]/).pop() ?? name).replace(/\.code-workspace$/i, '')
        // Read again: the save may have waited on a dialog, and the list may have changed meanwhile.
        const now = useApp.getState()
        now.setWorkspaces(now.workspaces.map((w) => (w.id === ws.id ? { ...w, name: saved, filePath: path } : w)))
        persist()
        setError(null)
        return true
      } catch (e) {
        // A folder that cannot be written to is the user's to fix, not a crash of ours.
        setError(e instanceof Error ? e.message : String(e))
        return false
      }
    },
    [persist]
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
  const saveWorkspaceAs = useCallback(() => {
    const s = useApp.getState()
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
    if (!ws || ws.folders.length === 0) return
    if (s.settings.workspaceFilesDir) setNaming(true)
    else void writeWorkspaceFile(ws.name, 'pick')
  }, [writeWorkspaceFile])

  const activeWorkspace = workspaces.find((w) => w.id === activeId)

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
          onSaveAs={() => { setMenuOpen(false); saveWorkspaceAs() }}
          canAddFolder={activeId !== null && activeId !== SCRATCH_WORKSPACE_ID}
          canSave={(activeWorkspace?.folders.length ?? 0) > 0}
        />
      )}

      {naming && activeWorkspace && workspaceFilesDir && (
        <SaveAsForm
          initialName={activeWorkspace.name}
          dir={workspaceFilesDir}
          onSave={async (name) => { if (await writeWorkspaceFile(name, 'named')) setNaming(false) }}
          onElsewhere={async (name) => { setNaming(false); await writeWorkspaceFile(name, 'pick') }}
          onCancel={() => setNaming(false)}
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
                      onClick={(e) => {
                        e.stopPropagation()
                        // Its tabs go with it, so its unsaved files are asked about first, exactly as
                        // closing those tabs one by one would ask.
                        const ids = allTabs(rowOf(useApp.getState(), w.id)).map((t) => t.id)
                        void closeTabsSafely(w.id, ids).then((closed) => {
                          if (!closed) return
                          remove(w.id)
                          persist()
                        })
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

/**
 * "Save Workspace As…" when Settings names a folder for workspace files: only the name is asked,
 * and the path it will be written to is shown as it is typed.
 *
 * In the side bar, where the menu it replaces was, rather than a dialog in the middle of the
 * window: the middle may be a browser page, which is a native view drawn over the document and
 * would cover the dialog. Nothing is ever drawn over the side bar.
 */
function SaveAsForm({
  initialName,
  dir,
  onSave,
  onElsewhere,
  onCancel
}: {
  initialName: string
  dir: string
  onSave: (name: string) => Promise<void>
  onElsewhere: (name: string) => Promise<void>
  onCancel: () => void
}): React.ReactElement {
  const [name, setName] = useState(initialName)
  // While a save is under way — it may be waiting on "replace it?" — a second press would race it.
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const problem = workspaceNameProblem(name)
  const target = namedWorkspaceFile(dir, name, platform() === 'win32' ? '\\' : '/')
  const run = (action: (name: string) => Promise<void>): void => {
    setBusy(true)
    void action(name).finally(() => setBusy(false))
  }

  return (
    <div className="menu menu--inline saveas" onMouseDown={(e) => e.stopPropagation()}>
      <div className="saveas__title">Save workspace as</div>
      <input
        ref={input}
        value={name}
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          // Enter mid-composition picks a candidate in the input method; it does not save.
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter' && !problem && !busy) {
            e.preventDefault()
            run(onSave)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      {problem ? (
        <div className="saveas__error">{problem}</div>
      ) : (
        <div className="saveas__path" title={target}>{target}</div>
      )}
      <div className="saveas__actions">
        <button
          className="saveas__elsewhere"
          title="Choose where to save it instead"
          disabled={busy}
          onClick={() => run(onElsewhere)}
        >
          Elsewhere…
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn btn--primary" disabled={!!problem || busy} onClick={() => run(onSave)}>
          Save
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
