import { useCallback, useEffect, useState } from 'react'
import { rpc } from '../ipc'
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
    s.setWorkspaces(
      s.workspaces.map((w) => (w.id === ws.id ? { ...w, folders: [...w.folders, folder] } : w))
    )
    persist()
  }, [persist])

  return (
    <div style={{ flex: '0 0 auto', borderBottom: '1px solid var(--border)' }}>
      <SectionHeader
        label="Workspaces"
        actions={[
          { icon: '+', title: 'New workspace from folder…', onClick: () => void createWorkspace() },
          { icon: '⊞', title: 'Add folder to active workspace…', onClick: () => void addFolder() }
        ]}
      />
      <div style={{ maxHeight: 200, overflowY: 'auto' }}>
        {workspaces.length <= 1 && (
          <div style={{ padding: '6px 12px', fontSize: 11, color: 'var(--fg-muted)' }}>
            Scratch is always here for terminals. Press + to add a folder as a workspace.
          </div>
        )}
        {workspaces.map((w) => (
          <div
            key={w.id}
            onClick={() => { setActive(w.id); persist() }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              fontSize: 12,
              background: w.id === activeId ? 'var(--bg-selected)' : 'transparent',
              color: w.id === activeId ? 'var(--fg-bright)' : 'var(--fg)',
              cursor: 'pointer'
            }}
          >
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {w.name}
            </span>
            {w.id === SCRATCH_WORKSPACE_ID ? (
              <span style={{ fontSize: 10, color: 'var(--fg-muted)' }} title="Always available; no folders">
                ❯
              </span>
            ) : (
              <>
                <span style={{ fontSize: 10, color: 'var(--fg-muted)' }}>{w.folders.length}</span>
                <button
                  title="Remove workspace"
                  onClick={(e) => { e.stopPropagation(); remove(w.id); persist() }}
                  style={{ opacity: 0.5, cursor: 'pointer' }}
                >
                  ×
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function FileExplorer(): React.ReactElement {
  const workspace = useActiveWorkspace()

  return (
    <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <SectionHeader label="Explorer" />
      <div style={{ flex: 1, overflow: 'auto', paddingBottom: 8 }}>
        {!workspace && <Empty>Open a workspace to browse files.</Empty>}
        {workspace && workspace.folders.length === 0 && (
          <Empty>No folders in this workspace. Terminals still work.</Empty>
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
      <Row depth={depth} onClick={() => setOpen((o) => !o)}>
        <span style={{ width: 12, opacity: 0.7 }}>{open ? '▾' : '▸'}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      </Row>
      {open && error && (
        <Row depth={depth + 1}>
          <span style={{ color: 'var(--git-deleted)', fontSize: 11 }}>{error}</span>
        </Row>
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
    <Row
      depth={depth}
      onClick={() => {
        if (!workspaceId) return
        openTab(workspaceId, {
          id: nextTabId(),
          kind: 'editor',
          title: stat.name,
          pinned: false,
          filePath: stat.path,
          repoId: null,
          readOnly: false
        })
      }}
    >
      <span style={{ width: 12 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stat.name}</span>
    </Row>
  )
}

// ---------------------------------------------------------------------------

function Row({
  depth,
  onClick,
  children
}: {
  depth: number
  onClick?: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        paddingLeft: 8 + depth * 12,
        paddingRight: 8,
        height: 22,
        fontSize: 12,
        cursor: onClick ? 'pointer' : 'default'
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      {children}
    </div>
  )
}

function SectionHeader({
  label,
  actions = []
}: {
  label: string
  actions?: Array<{ icon: string; title: string; onClick: () => void }>
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 26,
        padding: '0 8px',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        color: 'var(--fg-muted)'
      }}
    >
      <span style={{ flex: 1 }}>{label}</span>
      {actions.map((a) => (
        <button key={a.icon} title={a.title} onClick={a.onClick} style={{ padding: '0 4px', cursor: 'pointer' }}>
          {a.icon}
        </button>
      ))}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--fg-muted)' }}>{children}</div>
}
