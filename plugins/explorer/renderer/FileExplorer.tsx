import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  addWorkspaceFolders,
  icons,
  listDir,
  openFile,
  openTerminal,
  popupMenu,
  setPluginState,
  useActiveWorkspace,
  useFileDecoration,
  usePluginState,
  workspaceDir
} from '@rigee/plugin-api'
import type { FileDecoration, FileStat, Workspace } from '@rigee/plugin-api'
import { invalidateAll, listings, useListingGeneration, watchFolders } from './listings'

/** This plugin's id, which is also the key its per-workspace state is filed under. */
const PLUGIN_ID = 'explorer'

/**
 * Which directories are open, for one workspace.
 *
 * Kept in the shell's per-plugin state rather than in component state because it has to outlive
 * the components: switching workspaces unmounts the whole tree, so local state went with it and
 * coming back re-expanded everything from defaults instead of showing it as you left it.
 *
 * UNDEFINED IS A REAL ANSWER and the code below depends on it: it means this workspace has never
 * been opened with the explorer, which is what triggers the one-time seeding of the root folders.
 * An empty array means the user collapsed everything and must be left alone.
 */
function readExpanded(state: Record<string, unknown> | undefined): string[] | undefined {
  const dirs = state?.expandedDirs
  return Array.isArray(dirs) ? (dirs as string[]) : undefined
}

/** A folder at the top level of the tree. */
interface Root {
  path: string
  name: string
  /** The workspace's own folder, which heads the tree and is drawn so it cannot be missed. */
  own: boolean
}

/**
 * The tree's top-level folders: the workspace's own folder first, once it has been saved to a
 * `.code-workspace` file, then the folders it lists.
 *
 * The own folder is the one the file is in, and where new terminals start — the workspace's rather
 * than any one repo's, so it is where an agent working across all of them keeps its notes. The tree
 * used to show every folder but that one. A file that lists its own folder too (`"path": "."`)
 * gets it once, at the top, rather than twice.
 */
function rootsOf(workspace: Workspace | null): Root[] {
  if (!workspace) return []
  const dir = workspaceDir(workspace)
  const listed = workspace.folders.map((f) => ({ path: f.path, name: f.name, own: f.path === dir }))
  if (!dir) return listed
  const own = listed.find((r) => r.own) ?? { path: dir, name: basename(dir), own: true }
  return [own, ...listed.filter((r) => !r.own)]
}

/** Empty segments dropped, so a folder at the root is called by its path rather than nothing. */
const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

export function FileExplorer(): React.ReactElement {
  const workspace = useActiveWorkspace()
  const [dropping, setDropping] = useState(false)
  const workspaceId = workspace?.id ?? null
  const expanded = readExpanded(usePluginState(PLUGIN_ID, workspaceId))
  const roots = useMemo(() => rootsOf(workspace), [workspace])

  const setExpandedDirs = useCallback((id: string, paths: string[]) => {
    setPluginState(PLUGIN_ID, id, { expandedDirs: [...new Set(paths)] })
  }, [])

  const open = useMemo(() => new Set(expanded ?? []), [expanded])

  /*
   * A workspace with no record yet starts with its root folders open, which is what you want on
   * first sight of a project. Once there is a record — even an empty one, meaning "everything
   * collapsed" — it is authoritative and must not be re-seeded, or collapsing everything would
   * undo itself on the next visit.
   */
  useEffect(() => {
    if (!workspaceId || expanded !== undefined || roots.length === 0) return
    setExpandedDirs(workspaceId, roots.map((r) => r.path))
  }, [workspaceId, expanded, roots, setExpandedDirs])

  const anyOpen = open.size > 0

  /*
   * Watch the folders on screen, and start from fresh listings whenever they change — including
   * on mount: while the tree was not showing, or another workspace was, nothing was keeping the
   * cache current for these folders.
   */
  const rootPaths = roots.map((r) => r.path).join('\n')
  useEffect(() => {
    invalidateAll()
    watchFolders(rootPaths ? rootPaths.split('\n') : [])
  }, [rootPaths])

  /**
   * Collapse everything, or put it back.
   *
   * "Expand all" walks the listings already read rather than fetching the whole tree: a real
   * checkout with node_modules in it is tens of thousands of directories, and a button that can
   * fire off that many reads is a trap. In practice it restores what a collapse just hid, because
   * those listings are all still cached, and reaches anything else the user has browsed to.
   */
  const toggleAll = useCallback(() => {
    if (!workspaceId) return
    if (anyOpen) { setExpandedDirs(workspaceId, []); return }

    const out: string[] = []
    const walk = (dir: string): void => {
      out.push(dir)
      for (const child of listings.get(dir) ?? []) if (child.isDir) walk(child.path)
    }
    for (const r of roots) walk(r.path)
    setExpandedDirs(workspaceId, out)
  }, [anyOpen, roots, workspaceId, setExpandedDirs])

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
          title="Refresh"
          disabled={roots.length === 0}
          onClick={invalidateAll}
        >
          <icons.Reload size={13} />
        </button>
        <button
          className="icon-button"
          title={anyOpen ? 'Collapse all folders' : 'Expand folders'}
          disabled={roots.length === 0}
          onClick={toggleAll}
        >
          {anyOpen ? <icons.CollapseAll size={14} /> : <icons.ExpandAll size={14} />}
        </button>
      </div>
      <div className={`explorer__body${dropping ? ' explorer__body--dropping' : ''}`}>
        {!workspace && <div className="muted">Open a workspace to browse files.</div>}
        {workspace && roots.length === 0 && (
          <div className="muted">
            No folders here. Terminals still work — drop a folder to make a workspace.
          </div>
        )}
        {roots.map((r) => (
          <Fragment key={r.path}>
            <DirNode path={r.path} name={r.name} depth={0} open={open} workspaceId={workspaceId} own={r.own} />
            {/* Below everything the own folder shows, so where the repos start is plain even with it open. */}
            {r.own && roots.length > 1 && <div className="explorer__divider" />}
          </Fragment>
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
  /** The workspace's own folder, at the head of the tree. */
  own?: boolean
}

/**
 * Lazily loaded directory node. Listings are cached by path in `listings` and kept afterwards, so
 * collapsing and re-expanding a large directory costs nothing and neither does leaving the
 * workspace and coming back.
 */
function DirNode({ path, name, depth, open, workspaceId, own }: DirNodeProps): React.ReactElement {
  const isOpen = open.has(path)
  const [children, setChildren] = useState<FileStat[] | null>(listings.get(path) ?? null)
  const [error, setError] = useState<string | null>(null)
  const decoration = useFileDecoration(path)
  const generation = useListingGeneration(path)

  // Read when opened with nothing cached, and again whenever the cached listing is forgotten — a
  // watcher saw it change, or Refresh was pressed. The old children stay up until the new arrive.
  useEffect(() => {
    if (!isOpen) return
    const cached = listings.get(path)
    if (cached) {
      setChildren(cached)
      return
    }
    let cancelled = false
    void listDir(path)
      .then((list) => {
        listings.set(path, list)
        if (!cancelled) { setChildren(list); setError(null) }
      })
      .catch((e: Error) => { if (!cancelled) setError(listingProblem(e)) })
    return () => { cancelled = true }
  }, [isOpen, path, generation])

  return (
    <>
      <div
        className={`row row--clickable${own ? ' explorer__own' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        title={own ? `${path}\nThe folder this workspace's .code-workspace file is in, where new terminals start.` : undefined}
        onClick={() => { if (workspaceId) toggleDir(workspaceId, open, path) }}
        onContextMenu={(e) => {
          e.preventDefault()
          void showDirMenu(path)
        }}
      >
        <span style={{ color: 'var(--fg-faint)', display: 'grid', placeItems: 'center', width: 13 }}>
          <icons.Chevron size={12} open={isOpen} />
        </span>
        {/* The icon the workspace list draws for a workspace, since this folder is the workspace's own. */}
        {own && (
          <span className="explorer__own-icon">
            <icons.Folder size={13} />
          </span>
        )}
        <Label name={name} decoration={decoration} tag={own ? 'Workspace' : undefined} />
      </div>
      {/* One line, like every row: wrapped, a long reason ran over the rows around it. */}
      {isOpen && error && (
        <div className="row" style={{ paddingLeft: 8 + (depth + 1) * 12 }} title={error}>
          <span className="row__label" style={{ color: 'var(--git-deleted)', fontSize: 11 }}>{error}</span>
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

/**
 * What the tree says under a folder it could not read: main's reason, without the IPC plumbing
 * Electron wraps round it, and in words for the usual one — a folder that has gone, which is most
 * often a workspace's own, its file moved or deleted since it was opened.
 */
function listingProblem(e: Error): string {
  const reason = e.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?(?:[\w-]+:[\w-]+: )?/, '')
  return reason.startsWith('ENOENT') ? 'This folder is no longer there.' : reason
}

function FileNode({ stat, depth }: { stat: FileStat; depth: number }): React.ReactElement {
  const decoration = useFileDecoration(stat.path)
  return (
    <div
      className="row row--clickable"
      style={{ paddingLeft: 8 + depth * 12 }}
      title={stat.path}
      // The shell picks the viewer, from the manifests alone — an array scan over a handful of
      // declarations, with no plugin loaded. A file tree has no business knowing that editors
      // have priorities, and this one used to: it read the registry, minted a tab id and called
      // the store, which is three shell internals in a click handler.
      onClick={() => { openFile({ path: stat.path, title: stat.name }) }}
    >
      <span style={{ color: 'var(--fg-faint)', display: 'grid', placeItems: 'center', width: 13 }}>
        <icons.File size={12} />
      </span>
      <Label name={stat.name} decoration={decoration} />
    </div>
  )
}

/**
 * A row's name, coloured as source control says — and its letter, for files that have one. A tag
 * goes between the two, so the letters still line up down the right edge.
 */
function Label({ name, decoration, tag }: {
  name: string
  decoration: FileDecoration | undefined
  tag?: string
}): React.ReactElement {
  return (
    <>
      <span className="row__label" style={decoration && { color: decoration.color }}>{name}</span>
      {tag && <span className="explorer__tag">{tag}</span>}
      {decoration && (
        <span className="explorer__badge" style={{ color: decoration.color }} title={decoration.tooltip}>
          {decoration.badge ?? '•'}
        </span>
      )}
    </>
  )
}

/**
 * A folder's menu, on right-click — a repo at the top of the tree or anything inside it. Both items
 * start a shell in that folder, whatever the workspace's terminals usually start in: picking the
 * folder is the whole point. A tab of its own, or a pane beside the terminal on screen.
 */
async function showDirMenu(path: string): Promise<void> {
  const choice = await popupMenu([
    { kind: 'item', id: 'terminal-tab', label: 'Open in Terminal Tab' },
    { kind: 'item', id: 'terminal-split', label: 'Open in Terminal Split' }
  ])
  if (choice === 'terminal-tab') openTerminal({ cwd: path, where: 'tab' })
  else if (choice === 'terminal-split') openTerminal({ cwd: path, where: 'split' })
}

/**
 * Flip one directory open or shut.
 *
 * Takes the current set rather than reading it back, because the caller already has it from its
 * own render and a second read could see a different one — the store is shared, and a workspace
 * switch between the two would move the toggle to the wrong project.
 */
function toggleDir(workspaceId: string, open: ReadonlySet<string>, path: string): void {
  const next = new Set(open)
  if (!next.delete(path)) next.add(path)
  setPluginState(PLUGIN_ID, workspaceId, { expandedDirs: [...next] })
}
