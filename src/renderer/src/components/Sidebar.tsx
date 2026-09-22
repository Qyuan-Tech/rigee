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

export function Sidebar({ onCollapse }: { onCollapse: () => void }): React.ReactElement {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <WorkspaceList onCollapse={onCollapse} />
      <FileExplorer />
    </div>
  )
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

/**
 * Directory listings, cached by absolute path outside React.
 *
 * Shared rather than per-node so that (a) switching workspaces and coming back does not re-read
 * every directory, and (b) "expand all" knows what the tree looks like without issuing a storm of
 * reads. Paths are absolute, so two workspaces containing the same folder share the entry.
 */
const listings = new Map<string, FileStat[]>()

function FileExplorer(): React.ReactElement {
  const workspace = useActiveWorkspace()
  const [dropping, setDropping] = useState(false)
  const workspaceId = workspace?.id ?? null
  const expanded = useApp((s) => (workspaceId ? s.expandedDirs[workspaceId] : undefined))
  const setExpandedDirs = useApp((s) => s.setExpandedDirs)

  const open = useMemo(() => new Set(expanded ?? []), [expanded])

  /*
   * A workspace with no record yet starts with its root folders open, which is what you want on
   * first sight of a project. Once there is a record — even an empty one, meaning "everything
   * collapsed" — it is authoritative and must not be re-seeded, or collapsing everything would
   * undo itself on the next visit.
   */
  useEffect(() => {
    if (!workspaceId || expanded !== undefined) return
    if (!workspace || workspace.folders.length === 0) return
    setExpandedDirs(workspaceId, workspace.folders.map((f) => f.path))
  }, [workspaceId, expanded, workspace, setExpandedDirs])

  const anyOpen = open.size > 0

  /**
   * Collapse everything, or put it back.
   *
   * "Expand all" walks the listings already read rather than fetching the whole tree: a real
   * checkout with node_modules in it is tens of thousands of directories, and a button that can
   * fire off that many reads is a trap. In practice it restores what a collapse just hid, because
   * those listings are all still cached, and reaches anything else the user has browsed to.
   */
  const toggleAll = useCallback(() => {
    if (!workspaceId || !workspace) return
    if (anyOpen) { setExpandedDirs(workspaceId, []); return }

    const out: string[] = []
    const walk = (dir: string): void => {
      out.push(dir)
      for (const child of listings.get(dir) ?? []) if (child.isDir) walk(child.path)
    }
    for (const f of workspace.folders) walk(f.path)
    setExpandedDirs(workspaceId, out)
  }, [anyOpen, workspace, workspaceId, setExpandedDirs])

  /**
   * Dropping folders here collects them, which is the input side of "Save Workspace As".
   *
   * Dropped onto Scratch — which has no folders by definition and is never persisted — the first
   * folder becomes a workspace instead, and the rest join it.
   */
  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setDropping(false)

      const paths = [...e.dataTransfer.files]
        .map((f) => window.onestop.pathForFile(f))
        .filter(Boolean)
      if (paths.length === 0) return

      const s = useApp.getState()
      const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
      const scratch = !ws || ws.id === SCRATCH_WORKSPACE_ID

      const probed = await Promise.all(
        paths.map(async (path) => {
          const probe = await rpc['workspace:probeFolder'](path)
          return {
            path,
            name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
            isGitRepo: probe.isGitRepo,
            repoRoot: probe.repoRoot
          } satisfies WorkspaceFolder
        })
      )

      const after = useApp.getState()
      if (scratch) {
        const [first, ...rest] = probed
        if (!first) return
        after.addWorkspace({
          id: nextWorkspaceId(),
          name: first.name,
          folders: [first, ...rest],
          createdAt: Date.now(),
          lastOpenedAt: Date.now()
        } satisfies Workspace)
      } else {
        const known = new Set(ws.folders.map((f) => f.path))
        const added = probed.filter((f) => !known.has(f.path))
        if (added.length === 0) return
        after.setWorkspaces(
          after.workspaces.map((w) =>
            w.id === ws.id ? { ...w, folders: [...w.folders, ...added] } : w
          )
        )
      }
      void rpc['state:saveWorkspaces']({
        workspaces: useApp.getState().workspaces.filter((w) => w.id !== SCRATCH_WORKSPACE_ID),
        activeWorkspaceId: useApp.getState().activeWorkspaceId
      })
    },
    []
  )

  return (
    <div
      style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}
      onDragOver={(e) => { e.preventDefault(); setDropping(true) }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="section-header">
        <span className="section-header__title">Explorer</span>
        <button
          className="icon-button"
          title={anyOpen ? 'Collapse all folders' : 'Expand folders'}
          disabled={!workspace || workspace.folders.length === 0}
          onClick={toggleAll}
        >
          {anyOpen ? <CollapseAllIcon size={14} /> : <ExpandAllIcon size={14} />}
        </button>
      </div>
      <div className={`explorer__body${dropping ? ' explorer__body--dropping' : ''}`}>
        {!workspace && <div className="muted">Open a workspace to browse files.</div>}
        {workspace && workspace.folders.length === 0 && (
          <div className="muted">
            No folders here. Terminals still work — drop a folder to make a workspace.
          </div>
        )}
        {workspace?.folders.map((f) => (
          <DirNode key={f.path} path={f.path} name={f.name} depth={0}
            open={open} workspaceId={workspaceId} />
        ))}
      </div>
    </div>
  )
}

interface DirNodeProps {
  path: string
  name: string
  depth: number
  /** Expanded paths for the active workspace. Held in the store so it survives a switch. */
  open: ReadonlySet<string>
  workspaceId: string | null
}

/**
 * Lazily loaded directory node. Listings are cached by path in `listings` and kept afterwards, so
 * collapsing and re-expanding a large directory costs nothing and neither does leaving the
 * workspace and coming back.
 */
function DirNode({ path, name, depth, open, workspaceId }: DirNodeProps): React.ReactElement {
  const toggleDir = useApp((s) => s.toggleDir)
  const isOpen = open.has(path)
  const [children, setChildren] = useState<FileStat[] | null>(listings.get(path) ?? null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen || children !== null) return
    let cancelled = false
    void rpc['fs:list'](path)
      .then((list) => {
        listings.set(path, list)
        if (!cancelled) setChildren(list)
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [isOpen, children, path])

  return (
    <>
      <div
        className="row row--clickable"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => { if (workspaceId) toggleDir(workspaceId, path) }}
      >
        <span style={{ color: 'var(--fg-faint)', display: 'grid', placeItems: 'center', width: 13 }}>
          <ChevronIcon size={12} open={isOpen} />
        </span>
        <span className="row__label">{name}</span>
      </div>
      {isOpen && error && (
        <div className="row" style={{ paddingLeft: 8 + (depth + 1) * 12 }}>
          <span style={{ color: 'var(--git-deleted)', fontSize: 11 }}>{error}</span>
        </div>
      )}
      {isOpen &&
        children?.map((c) =>
          c.isDir ? (
            <DirNode key={c.path} path={c.path} name={c.name} depth={depth + 1}
              open={open} workspaceId={workspaceId} />
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
          filePath: stat.path, repoId: null, readOnly: false,
          // Resolved once, here, from the manifests alone: an array scan over a handful of
          // declarations, and no plugin loaded. Doing it in the pane instead would either scan on
          // every render or force the viewer to load before the user has committed to the file.
          viewType: resolveViewType(stat.path) ?? undefined
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
