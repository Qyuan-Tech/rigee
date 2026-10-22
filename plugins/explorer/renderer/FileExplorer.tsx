import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  addWorkspaceFolders,
  icons,
  isMac,
  listDir,
  setPluginState,
  useActiveWorkspace,
  useFileDecoration,
  usePluginState,
  workspaceDir
} from '@rigee/plugin-api'
import type { FileDecoration, FileStat, Translator, Workspace } from '@rigee/plugin-api'
import { useT } from './l10n'
import { invalidateAll, listings, useListingGeneration, watchFolders } from './listings'
import {
  canDrop,
  clickRow,
  create,
  doubleClickRow,
  dropEntries,
  dropFromOutside,
  folderOf,
  nameIssue,
  nameOf,
  parentOf,
  PLUGIN_ID,
  problemIn,
  readExpanded,
  rename,
  run,
  showMenu,
  startNew,
  treeKey,
  type NameIssue,
  type Root,
  type Row,
  type Tree
} from './operations'
import {
  CUT,
  DROP,
  dragged,
  enterWorkspace,
  FOCUSED,
  NEW_FILE,
  NEW_FOLDER,
  RENAMING,
  select,
  selection,
  SELECTED,
  setDragging,
  setDropTarget,
  setEditing,
  takeReveal,
  useRowFlags
} from './treeState'

/** What the tree puts on a drag of its own rows, so a drop can tell them from files from outside. */
const DRAG_TYPE = 'application/x-rigee-explorer'

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
  const own = listed.find((r) => r.own) ?? { path: dir, name: nameOf(dir), own: true }
  return [own, ...listed.filter((r) => !r.own)]
}

/** The row an event happened on, read back from the attributes every row carries. */
function rowAt(target: EventTarget | null): Row | null {
  const el = target instanceof Element ? target.closest<HTMLElement>('[data-path]') : null
  return el ? { path: el.dataset.path!, dir: 'dir' in el.dataset, root: 'root' in el.dataset } : null
}

/** The copy modifier for a drag inside the tree: Option on a Mac, Ctrl elsewhere — VS Code's. */
const copying = (e: React.DragEvent): boolean => (isMac() ? e.altKey : e.ctrlKey)

/** Indentation, the same for a row and for the name box standing in for one. */
const indent = (depth: number): number => 8 + depth * 12

export function FileExplorer(): React.ReactElement {
  const { t } = useT()
  const workspace = useActiveWorkspace()
  const [dropping, setDropping] = useState(false)
  const workspaceId = workspace?.id ?? null
  const expanded = readExpanded(usePluginState(PLUGIN_ID, workspaceId))
  const roots = useMemo(() => rootsOf(workspace), [workspace])
  const body = useRef<HTMLDivElement>(null)

  const setExpandedDirs = useCallback((id: string, paths: string[]) => {
    setPluginState(PLUGIN_ID, id, { expandedDirs: [...new Set(paths)] })
  }, [])

  const open = useMemo(() => new Set(expanded ?? []), [expanded])

  /*
   * What every operation is handed: the tree as it is when the key or the click happens. A ref the
   * rows share rather than a prop that changes, so that opening a folder re-renders the folders,
   * as it always has, and not every file row besides.
   */
  const tree = useRef<Tree>({
    workspaceId,
    roots,
    rows: () => [...(body.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])].map((el) => rowAt(el)!),
    refocus: () => body.current?.focus()
  })
  useLayoutEffect(() => {
    tree.current = { ...tree.current, workspaceId, roots }
  }, [workspaceId, roots])

  useEffect(() => { enterWorkspace(workspaceId) }, [workspaceId])

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

  /** The header's New File and New Folder: in the folder of the row the keyboard is on, else the first. */
  const newEntry = (folder: boolean): void => {
    const { focused } = selection()
    const row = focused ? tree.current.rows().find((r) => r.path === focused) : undefined
    const dir = row ? folderOf(row) : roots[0]?.path
    if (dir) startNew(tree.current, dir, folder)
  }

  /*
   * Dragging. Over a row, a drag drops into that row's folder — the folder itself, or the one a file
   * is in — and lights up everything shown inside it, as VS Code does. Rows from this tree move, or
   * copy with Option (Ctrl elsewhere) held; files from another application are copied in.
   *
   * Over the empty space below the rows, folders from outside join the workspace, which is how a
   * multi-root workspace has always been put together here. Dropped onto Scratch — which has no
   * folders by definition and is never persisted — the first folder becomes a workspace instead, and
   * the rest join it. The rules for what a dropped folder DOES belong to the workspace model, which
   * is the shell's; the tree only knows that something was dropped on it.
   */
  const onDragStart = (e: React.DragEvent): void => {
    const row = rowAt(e.target)
    if (!row || row.root) return
    // The whole selection when the row is part of it; otherwise just the row, now selected alone.
    const { selected } = selection()
    const paths = selected.has(row.path) ? [...selected].filter((p) => !roots.some((r) => r.path === p)) : [row.path]
    if (!selected.has(row.path)) select([row.path], row.path)
    setDragging(paths)
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths))
    e.dataTransfer.effectAllowed = 'copyMove'
  }

  const endDrag = (): void => {
    setDragging(null)
    setDropTarget(null)
    setDropping(false)
  }

  const onDragOver = (e: React.DragEvent): void => {
    const ours = e.dataTransfer.types.includes(DRAG_TYPE)
    if (!ours && !e.dataTransfer.types.includes('Files')) return
    const row = rowAt(e.target)
    if (!row) {
      setDropTarget(null)
      // Rows from the tree have nowhere to go in the empty space: no drop.
      if (ours) return
      e.preventDefault()
      setDropping(true)
      return
    }
    setDropping(false)
    const into = folderOf(row)
    if (ours) {
      const copy = copying(e)
      if (!canDrop(dragged() ?? [], into, copy)) {
        setDropTarget(null)
        return
      }
      e.dataTransfer.dropEffect = copy ? 'copy' : 'move'
    } else {
      e.dataTransfer.dropEffect = 'copy'
    }
    e.preventDefault()
    setDropTarget(into)
  }

  const onDragLeave = (e: React.DragEvent): void => {
    // Leaving one row for the next is a leave too; only leaving the panel ends the highlight.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDropTarget(null)
      setDropping(false)
    }
  }

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    const ours = e.dataTransfer.getData(DRAG_TYPE)
    const copy = copying(e)
    const row = rowAt(e.target)
    endDrag()
    if (ours) {
      if (row) await dropEntries(tree.current, folderOf(row), JSON.parse(ours) as string[], copy)
      return
    }
    const paths = [...e.dataTransfer.files].map((f) => window.rigee.pathForFile(f)).filter(Boolean)
    if (row) await dropFromOutside(tree.current, folderOf(row), paths)
    else if (paths.length > 0) await addWorkspaceFolders(paths)
  }

  return (
    <div
      style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}
      onDragStart={onDragStart}
      onDragEnd={endDrag}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => run(onDrop(e))}
    >
      <div className="section-header">
        <span className="section-header__title">{t('Explorer')}</span>
        <button className="icon-button" title={t('New File…')} disabled={roots.length === 0} onClick={() => newEntry(false)}>
          <icons.NewFile size={14} />
        </button>
        <button className="icon-button" title={t('New Folder…')} disabled={roots.length === 0} onClick={() => newEntry(true)}>
          <icons.AddFolder size={14} />
        </button>
        <button
          className="icon-button"
          title={t('Refresh')}
          disabled={roots.length === 0}
          onClick={invalidateAll}
        >
          <icons.Reload size={13} />
        </button>
        <button
          className="icon-button"
          title={anyOpen ? t('Collapse all folders') : t('Expand folders')}
          disabled={roots.length === 0}
          onClick={toggleAll}
        >
          {anyOpen ? <icons.CollapseAll size={14} /> : <icons.ExpandAll size={14} />}
        </button>
      </div>
      <div
        ref={body}
        className={`explorer__body${dropping ? ' explorer__body--dropping' : ''}`}
        // The tree takes the keyboard when a row is clicked, so its keys work as they do in VS Code.
        tabIndex={0}
        onKeyDown={(e) => {
          // Only keys pressed on the tree itself: a name box answers its own.
          if (e.target !== e.currentTarget || !treeKey(tree.current, e)) return
          e.preventDefault()
          e.stopPropagation()
        }}
        // A click in the empty space below the rows lets go of the selection, as in VS Code.
        onMouseDown={(e) => { if (!rowAt(e.target) && e.target === e.currentTarget) select([], null) }}
      >
        {!workspace && <div className="muted">{t('Open a workspace to browse files.')}</div>}
        {workspace && roots.length === 0 && (
          <div className="muted">
            {t('No folders here. Terminals still work — drop a folder to make a workspace.')}
          </div>
        )}
        {roots.map((r) => (
          <Fragment key={r.path}>
            <DirNode path={r.path} name={r.name} depth={0} open={open} tree={tree} root own={r.own} />
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
  tree: { readonly current: Tree }
  /** One of the workspace's folders, at the top of the tree. */
  root?: boolean
  /** The workspace's own folder, at the head of the tree. */
  own?: boolean
}

/** A row's classes: the shared row, and what the tree has picked out on it. */
function rowClass(flags: number, extra = ''): string {
  return (
    `row row--clickable explorer__row${extra}` +
    (flags & SELECTED ? ' explorer__row--selected' : '') +
    (flags & FOCUSED ? ' explorer__row--focused' : '') +
    (flags & CUT ? ' explorer__row--cut' : '') +
    (flags & DROP ? ' explorer__row--drop' : '')
  )
}

/** Scroll the row into view when it was asked to be — once it exists, which may be only now. */
function useReveal(row: React.RefObject<HTMLDivElement | null>, path: string, flags: number): void {
  useLayoutEffect(() => {
    if (flags & FOCUSED && takeReveal(path)) row.current?.scrollIntoView({ block: 'nearest' })
  }, [flags, path, row])
}

/**
 * Lazily loaded directory node. Listings are cached by path in `listings` and kept afterwards, so
 * collapsing and re-expanding a large directory costs nothing and neither does leaving the
 * workspace and coming back.
 */
function DirNode({ path, name, depth, open, tree, root = false, own = false }: DirNodeProps): React.ReactElement {
  const { t } = useT()
  const isOpen = open.has(path)
  const [children, setChildren] = useState<FileStat[] | null>(listings.get(path) ?? null)
  const [error, setError] = useState<Error | null>(null)
  const decoration = useFileDecoration(path)
  const generation = useListingGeneration(path)
  const flags = useRowFlags(path)
  const ref = useRef<HTMLDivElement>(null)
  useReveal(ref, path, flags)

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
      .catch((e: Error) => { if (!cancelled) setError(e) })
    return () => { cancelled = true }
  }, [isOpen, path, generation])

  const row: Row = { path, dir: true, root }
  const problem = error && listingProblem(error, t)
  return (
    <>
      {flags & RENAMING ? (
        <NameBox
          depth={depth}
          folder
          initial={name}
          issue={(value) => nameIssue(value, parentOf(path), path, false)}
          commit={(value) => rename(tree.current, path, value)}
          tree={tree}
        />
      ) : (
        <div
          ref={ref}
          className={rowClass(flags, own ? ' explorer__own' : '')}
          style={{ paddingLeft: indent(depth) }}
          title={own ? `${path}\n${t("The folder this workspace's .code-workspace file is in, where new terminals start.")}` : undefined}
          data-path={path}
          data-dir=""
          data-root={root ? '' : undefined}
          draggable={!root}
          onClick={(e) => clickRow(tree.current, row, e)}
          onContextMenu={(e) => {
            e.preventDefault()
            run(showMenu(tree.current, row))
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
          <Label name={name} decoration={decoration} tag={own ? t('Workspace') : undefined} />
        </div>
      )}
      {/* One line, like every row: wrapped, a long reason ran over the rows around it. */}
      {isOpen && problem && (
        <div className="row" style={{ paddingLeft: indent(depth + 1) }} title={problem}>
          <span className="row__label" style={{ color: 'var(--git-deleted)', fontSize: 11 }}>{problem}</span>
        </div>
      )}
      {isOpen && flags & (NEW_FILE | NEW_FOLDER) ? (
        <NameBox
          depth={depth + 1}
          folder={!!(flags & NEW_FOLDER)}
          initial=""
          issue={(value) => nameIssue(value, path, null, true)}
          commit={(value) => create(tree.current, path, value, !!(flags & NEW_FOLDER))}
          tree={tree}
        />
      ) : null}
      {isOpen &&
        children?.map((c) =>
          c.isDir ? (
            <DirNode key={c.path} path={c.path} name={c.name} depth={depth + 1} open={open} tree={tree} />
          ) : (
            <FileNode key={c.path} stat={c} depth={depth + 1} tree={tree} />
          )
        )}
    </>
  )
}

/**
 * What the tree says under a folder it could not read: main's reason, without the IPC plumbing
 * Electron wraps round it, and in words for the usual one — a folder that has gone, which is most
 * often a workspace's own, its file moved or deleted since it was opened. Worked out as the row is
 * drawn rather than when the read failed, so that it follows a change of language.
 */
function listingProblem(e: Error, t: Translator['t']): string {
  const reason = e.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?(?:[\w-]+:[\w-]+: )?/, '')
  return reason.startsWith('ENOENT') ? t('This folder is no longer there.') : reason
}

function FileNode({ stat, depth, tree }: { stat: FileStat; depth: number; tree: { readonly current: Tree } }): React.ReactElement {
  const decoration = useFileDecoration(stat.path)
  const flags = useRowFlags(stat.path)
  const ref = useRef<HTMLDivElement>(null)
  useReveal(ref, stat.path, flags)
  const row: Row = { path: stat.path, dir: false, root: false }

  if (flags & RENAMING) {
    return (
      <NameBox
        depth={depth}
        folder={false}
        initial={stat.name}
        issue={(value) => nameIssue(value, parentOf(stat.path), stat.path, false)}
        commit={(value) => rename(tree.current, stat.path, value)}
        tree={tree}
      />
    )
  }
  return (
    <div
      ref={ref}
      className={rowClass(flags)}
      style={{ paddingLeft: indent(depth) }}
      title={stat.path}
      data-path={stat.path}
      draggable
      // The shell picks the viewer, from the manifests alone — an array scan over a handful of
      // declarations, with no plugin loaded. A file tree has no business knowing that editors
      // have priorities, and this one used to: it read the registry, minted a tab id and called
      // the store, which is three shell internals in a click handler.
      onClick={(e) => clickRow(tree.current, row, e)}
      onDoubleClick={() => doubleClickRow(row)}
      onContextMenu={(e) => {
        e.preventDefault()
        run(showMenu(tree.current, row))
      }}
    >
      <span style={{ color: 'var(--fg-faint)', display: 'grid', placeItems: 'center', width: 13 }}>
        <icons.File size={12} />
      </span>
      <Label name={stat.name} decoration={decoration} />
    </div>
  )
}

/**
 * The name box: a row's name being edited in place, or a new entry's being typed at the top of its
 * folder — VS Code's inline input.
 *
 * Enter makes it so and Escape leaves everything as it was. Clicking away makes it so too, when the
 * name is good, and drops it when not; switching to another application does neither, and the box
 * is still there on the way back. What is wrong with the name is said under the box as it is
 * typed, and a refusal from the disk is said in the same place, with the box left open to fix it.
 */
function NameBox({ depth, folder, initial, issue, commit, tree }: {
  depth: number
  folder: boolean
  initial: string
  issue: (value: string) => NameIssue | null
  commit: (value: string) => Promise<void>
  tree: { readonly current: Tree }
}): React.ReactElement {
  const { t } = useT()
  const input = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initial)
  const [refusal, setRefusal] = useState<string | null>(null)
  const busy = useRef(false)
  // Nothing to say until something has been typed: an empty box that has just opened is not a mistake.
  const problem = value === initial ? null : issue(value)

  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    // A file's name is selected up to its extension, as in Finder and VS Code: a rename usually keeps the type.
    const dot = folder ? -1 : initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [folder, initial])

  const close = (): void => {
    setEditing(null)
    tree.current.refocus()
  }

  const finish = async (): Promise<void> => {
    if (busy.current || problem?.blocking) return
    if (value === initial) { close(); return }
    busy.current = true
    try {
      await commit(value)
      tree.current.refocus()
    } catch (e) {
      busy.current = false
      setRefusal(problemIn(e))
      input.current?.focus()
    }
  }

  const message = refusal ?? problem?.message
  return (
    <>
      <div className="row explorer__editing" style={{ paddingLeft: indent(depth) }}>
        <span style={{ color: 'var(--fg-faint)', display: 'grid', placeItems: 'center', width: 13 }}>
          {folder ? <icons.Folder size={12} /> : <icons.File size={12} />}
        </span>
        <input
          ref={input}
          className={`explorer__input${message ? (refusal || problem?.blocking ? ' explorer__input--error' : ' explorer__input--warning') : ''}`}
          value={value}
          spellCheck={false}
          aria-label={initial ? t('Rename {name}', { name: initial }) : folder ? t('New folder name') : t('New file name')}
          onChange={(e) => {
            setValue(e.target.value)
            setRefusal(null)
          }}
          onKeyDown={(e) => {
            // A Chinese or Japanese name is still being composed: Enter there commits the characters.
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') {
              e.preventDefault()
              run(finish())
            } else if (e.key === 'Escape') {
              e.preventDefault()
              close()
            }
          }}
          onBlur={() => {
            if (busy.current || !document.hasFocus()) return
            if (value.trim() === '' || problem?.blocking) setEditing(null)
            else run(finish())
          }}
        />
      </div>
      {message && (
        <div
          className={`explorer__problem${refusal || problem?.blocking ? '' : ' explorer__problem--warning'}`}
          style={{ marginLeft: indent(depth) + 19 }}
        >
          {message}
        </div>
      )}
    </>
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
