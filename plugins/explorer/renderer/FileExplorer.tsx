import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronIcon, CollapseAllIcon, ExpandAllIcon, FileIcon } from '@renderer/icons'
import { rpc } from '@renderer/ipc'
import { addWorkspaceFolders, useActiveWorkspace } from '@renderer/plugins/api'
import { resolveViewType } from '@renderer/plugins/registry'
import { nextTabId, useApp } from '@renderer/store'
import type { FileStat } from '@shared/types'

/**
 * Directory listings, cached by absolute path outside React.
 *
 * Shared rather than per-node so that (a) switching workspaces and coming back does not re-read
 * every directory, and (b) "expand all" knows what the tree looks like without issuing a storm of
 * reads. Paths are absolute, so two workspaces containing the same folder share the entry.
 */
const listings = new Map<string, FileStat[]>()

export function FileExplorer(): React.ReactElement {
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
  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDropping(false)

    const paths = [...e.dataTransfer.files]
      .map((f) => window.rigee.pathForFile(f))
      .filter(Boolean)
    // The rules for what a dropped folder DOES — join this workspace, or become one because you
    // are on Scratch — belong to the workspace model, which is the shell's. The tree only knows
    // that something was dropped on it.
    if (paths.length > 0) await addWorkspaceFolders(paths)
  }, [])

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
