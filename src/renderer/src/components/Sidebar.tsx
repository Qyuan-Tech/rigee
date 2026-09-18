import { useCallback, useEffect, useState } from 'react'
import { rpc } from '../ipc'
import { AddFolderIcon, ChevronIcon, CloseIcon, FileIcon, FolderIcon, PlusIcon, TerminalIcon } from '../icons'
import { nextTabId, nextWorkspaceId, useActiveWorkspace, useApp } from '../store'
import { SCRATCH_WORKSPACE_ID, type FileStat, type Workspace, type WorkspaceFolder } from '@shared/types'

export function Sidebar(): React.ReactElement {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <WorkspaceList />
      <FileExplorer />
    </div>
  )
}

// ---------------------------------------------------------------------------

function WorkspaceList(): React.ReactElement {
  const workspaces = useApp((s) => s.workspaces)
  const activeId = useApp((s) => s.activeWorkspaceId)
  const setActive = useApp((s) => s.setActiveWorkspace)
  const add = useApp((s) => s.addWorkspace)
  const remove = useApp((s) => s.removeWorkspace)

  const persist = useCallback(() => {
    const s = useApp.getState()
    void rpc['state:saveWorkspaces']({
      // Scratch is rebuilt at boot; persisting it would let a stale copy outlive the code.
      workspaces: s.workspaces.filter((w) => w.id !== SCRATCH_WORKSPACE_ID),
      activeWorkspaceId: s.activeWorkspaceId
    })
  }, [])

  const createWorkspace = useCallback(async () => {
    const path = await rpc['workspace:pickFolder']()
    if (!path) return
    const probe = await rpc['workspace:probeFolder'](path)
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
    const ws: Workspace = {
      id: nextWorkspaceId(),
      name,
      folders: [{ path, name, isGitRepo: probe.isGitRepo, repoRoot: probe.repoRoot }],
      tmuxSessionName: name.replace(/[^\w.-]/g, '-'),
      createdAt: Date.now(),
      lastOpenedAt: Date.now()
    }
    add(ws)
    persist()
  }, [add, persist])

  const addFolder = useCallback(async () => {
    const s = useApp.getState()
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
    if (!ws) return
    const path = await rpc['workspace:pickFolder']()
    if (!path) return
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
  }, [persist])

  return (
    <div style={{ flex: '0 0 auto', borderBottom: '1px solid var(--border)' }}>
      <div className="section-header">
        <span className="section-header__title">Workspaces</span>
        <button className="icon-button" title="New workspace from folder…" onClick={() => void createWorkspace()}>
          <PlusIcon size={14} />
        </button>
        <button className="icon-button" title="Add folder to active workspace…" onClick={() => void addFolder()}>
          <AddFolderIcon size={14} />
        </button>
      </div>

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

// ---------------------------------------------------------------------------

function FileExplorer(): React.ReactElement {
  const workspace = useActiveWorkspace()

  return (
    <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="section-header">
        <span className="section-header__title">Explorer</span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', paddingBottom: 10 }}>
        {!workspace && <div className="muted">Open a workspace to browse files.</div>}
        {workspace && workspace.folders.length === 0 && (
          <div className="muted">No folders here. Terminals still work.</div>
        )}
        {workspace?.folders.map((f) => (
          <DirNode key={f.path} path={f.path} name={f.name} depth={0} defaultOpen />
        ))}
      </div>
    </div>
  )
}

interface DirNodeProps {
  path: string
  name: string
  depth: number
  defaultOpen?: boolean
}

/**
 * Lazily loaded directory node. Children are fetched on first expand and kept afterwards, so
 * collapsing and re-expanding a large directory costs nothing.
 */
function DirNode({ path, name, depth, defaultOpen = false }: DirNodeProps): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen)
  const [children, setChildren] = useState<FileStat[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || children !== null) return
    let cancelled = false
    void rpc['fs:list'](path)
      .then((list) => { if (!cancelled) setChildren(list) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [open, children, path])

  return (
    <>
      <div
        className="row row--clickable"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ color: 'var(--fg-faint)', display: 'grid', placeItems: 'center', width: 13 }}>
          <ChevronIcon size={12} open={open} />
        </span>
        <span className="row__label">{name}</span>
      </div>
      {open && error && (
        <div className="row" style={{ paddingLeft: 8 + (depth + 1) * 12 }}>
          <span style={{ color: 'var(--git-deleted)', fontSize: 11 }}>{error}</span>
        </div>
      )}
      {open &&
        children?.map((c) =>
          c.isDir ? (
            <DirNode key={c.path} path={c.path} name={c.name} depth={depth + 1} />
          ) : (
            <FileNode key={c.path} stat={c} depth={depth + 1} />
          )
        )}
    </>
  )
}

function FileNode({ stat, depth }: { stat: FileStat; depth: number }): React.ReactElement {
  const openTab = useApp((s) => s.openTab)
  const workspaceId = useApp((s) => s.activeWorkspaceId)

  return (
    <div
      className="row row--clickable"
      style={{ paddingLeft: 8 + depth * 12 }}
      title={stat.path}
      onClick={() => {
        if (!workspaceId) return
        openTab(workspaceId, {
          id: nextTabId(), kind: 'editor', title: stat.name, pinned: false,
          filePath: stat.path, repoId: null, readOnly: false
        })
      }}
    >
      <span style={{ color: 'var(--fg-faint)', display: 'grid', placeItems: 'center', width: 13 }}>
        <FileIcon size={12} />
      </span>
      <span className="row__label">{stat.name}</span>
    </div>
  )
}
