import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
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
import {
  COLD_AFTER,
  activityClock,
  compareWarmth,
  heatOf,
  holdRanking,
  lastActiveAt,
  localDay,
  longAgo,
  shortAgo,
  temperatureOf,
  type Ranking,
  type Temperature,
  type Warmth
} from '../heat'
import { describePanes, terminalPanes } from '../paneWork'
import { revealPane } from '../terminals'
import { SaveAsForm } from './LazySaveWorkspace'
import {
  SCRATCH_WORKSPACE_ID,
  type Workspace,
  type WorkspaceActivity,
  type WorkspaceId
} from '@shared/types'

/**
 * The checklist of cold workspaces, fetched the first time it opens — and once startup is over, so
 * that it opens at once. Nothing of it is on screen at startup, and `pnpm perf:check` holds the
 * entry chunk to a budget that everything that is has to fit in.
 */
const loadColdReview = (): Promise<typeof import('./ColdReview')> => import('./ColdReview')
const ColdReview = lazy(() => loadColdReview().then((m) => ({ default: m.ColdReview })))
setTimeout(() => { void loadColdReview() }, 3000)

/**
 * The workspace list, and nothing else.
 *
 * The file tree that used to sit under it is a plugin now (plugins/explorer). What is left is
 * the workspace model's own UI — opening folders and `.code-workspace` files, switching between
 * them, saving one out — which is the shell's, because the workspace model is the shell's. It
 * stays pinned above the activity bar's panel rather than becoming one of the switchable views:
 * which project you are in is context for every view, not a view of its own.
 *
 * Ordered and coloured by heat (heat.ts): Scratch first, where it always was, then the workspaces
 * most in use lately, their icons amber when warm and orange when hot; then, faded and below a
 * divider, the cold ones — nothing in them for ten days of use — with a way to clear them out.
 * Each row also counts its terminals at work and those finished since the user last looked
 * (paneWork.ts), and each count goes to the terminal it counts.
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
  const activity = useApp((s) => s.activityByWorkspace)
  // Which terminal panes each workspace has, as one string: the list draws again when that changes,
  // and not with every tab switched or divider dragged, which change the rows but not this.
  const paneList = useApp((s) =>
    s.workspaces.map((w) => terminalPanes(rowOf(s, w.id)).map((p) => p.paneId).join(',')).join(';')
  )
  const workingPanes = useApp((s) => s.workingPanes)
  const unseenPanes = useApp((s) => s.unseenPanes)
  const now = useNow(30_000)
  const [menuOpen, setMenuOpen] = useState(false)
  /**
   * Which workspace the name form "Save Workspace As…" shows is for, when there is a workspace
   * files folder to save in. Not necessarily the active one: a right-clicked workspace saves as
   * itself without being switched to.
   */
  const [naming, setNaming] = useState<WorkspaceId | null>(null)
  /**
   * The order the list had when the pointer came over it, kept until the pointer leaves, so that
   * nothing moves under it. See `holdRanking`.
   */
  const [held, setHeld] = useState<Ranking | null>(null)
  /** Whether the checklist of cold workspaces is showing. */
  const [reviewing, setReviewing] = useState(false)

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

  // The checklist goes the same way, and with Escape: nothing in it is typed into.
  useEffect(() => {
    if (!reviewing) return
    const dismiss = (): void => setReviewing(false)
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') dismiss() }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [reviewing])

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

  /**
   * Its tabs go with it, so its unsaved files are asked about first, as closing those tabs would
   * ask. True once it has gone.
   */
  const removeWorkspace = useCallback(
    async (workspaceId: WorkspaceId): Promise<boolean> => {
      const ids = allTabs(rowOf(useApp.getState(), workspaceId)).map((t) => t.id)
      if (!(await closeTabsSafely(workspaceId, ids))) return false
      remove(workspaceId)
      persistWorkspaces()
      return true
    },
    [remove]
  )

  /**
   * The cold workspaces the checklist was left with, one at a time — each may stop to ask about
   * its unsaved files, and declining that keeps the one workspace without stopping the rest.
   */
  const removeCold = useCallback(
    async (ids: readonly WorkspaceId[]) => {
      for (const id of ids) await removeWorkspace(id)
      setReviewing(false)
    },
    [removeWorkspace]
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
      else if (choice === 'remove') void removeWorkspace(w.id)
    },
    [addFolder, saveWorkspaceAs, removeWorkspace]
  )

  const activeWorkspace = workspaces.find((w) => w.id === activeId)
  const namingWorkspace = workspaces.find((w) => w.id === naming)

  const warmth = useMemo(() => {
    const clock = activityClock(Object.values(activity), localDay(now))
    return new Map(workspaces.map((w) => [w.id, warmthOf(activity[w.id], clock)]))
  }, [workspaces, activity, now])
  const live = useMemo(() => rank(workspaces, warmth), [workspaces, warmth])
  const ranking = held ? holdRanking(held, live) : live
  const byId = new Map(workspaces.map((w) => [w.id, w]))
  const scratch = byId.get(SCRATCH_WORKSPACE_ID)
  // Counted from the rows themselves: one clicked while the order is held warms up where it is.
  const stillCold = ranking.cold.filter((id) => warmth.get(id)?.temperature === 'cold').length
  const panes = useMemo(() => {
    const lists = paneList.split(';')
    return new Map(workspaces.map((w, i) => [w.id, lists[i] ? lists[i].split(',') : []]))
  }, [paneList, workspaces])

  const renderRow = (w: Workspace | undefined): React.ReactNode =>
    w && (
      <WorkspaceRow
        key={w.id}
        workspace={w}
        warmth={warmth.get(w.id)!}
        activity={activity[w.id]}
        working={(panes.get(w.id) ?? []).filter((id) => id in workingPanes)}
        finished={(panes.get(w.id) ?? []).filter((id) => id in unseenPanes)}
        workingPanes={workingPanes}
        unseenPanes={unseenPanes}
        now={now}
        selected={w.id === activeId}
        onSelect={() => { setActive(w.id); persistWorkspaces() }}
        onMenu={() => void showWorkspaceMenu(w)}
        onRemove={() => void removeWorkspace(w.id)}
      />
    )

  return (
    <div
      className="workspace-list"
      style={{ flex: '0 0 auto', borderBottom: '1px solid var(--border)', position: 'relative' }}
    >
      <div className="section-header">
        <span className="section-header__title">Workspaces</span>
        {live.cold.length > 0 && (
          <button
            className="heat-hint"
            title={`Nothing has happened in ${live.cold.length === 1 ? 'one workspace' : `${live.cold.length} workspaces`} in your last ${COLD_AFTER} days with Rigee. Choose which to remove.`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setReviewing((r) => !r)}
          >
            {live.cold.length} cold
          </button>
        )}
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

      {reviewing && live.cold.length > 0 && (
        <Suspense fallback={null}>
          <ColdReview
            workspaces={live.cold.map((id) => byId.get(id)!)}
            activity={activity}
            now={now}
            onRemove={removeCold}
            onCancel={() => setReviewing(false)}
          />
        </Suspense>
      )}

      {error && (
        <div className="error-banner" onClick={() => setError(null)} title="Dismiss">
          {error}
        </div>
      )}

      <div
        style={{ maxHeight: 220, overflowY: 'auto', paddingBottom: 4 }}
        onMouseEnter={() => setHeld(live)}
        onMouseLeave={() => setHeld(null)}
      >
        {renderRow(scratch)}
        {ranking.recent.map((id) => renderRow(byId.get(id)))}
        {stillCold > 0 && (
          <div
            className="heat-divider"
            title={`Nothing has happened in these in your last ${COLD_AFTER} days with Rigee`}
          >
            <span>Cold · {stillCold}</span>
            <span className="heat-divider__rule" />
            <button
              className="heat-divider__review"
              title="Choose which to remove"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setReviewing((r) => !r)}
            >
              Review…
            </button>
          </div>
        )}
        {ranking.cold.map((id) => renderRow(byId.get(id)))}
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
// Heat

/**
 * One workspace in the list. Its icon carries its heat; on the right, how long since anything
 * happened in it — the reason for the colour, in a form that needs no legend — which gives way to
 * the remove button on hover. Before that, how many of its terminals are at work, with a light
 * running along the row while any is, and how many have finished unseen.
 */
function WorkspaceRow({
  workspace: w,
  warmth,
  activity,
  working,
  finished,
  workingPanes,
  unseenPanes,
  now,
  selected,
  onSelect,
  onMenu,
  onRemove
}: {
  workspace: Workspace
  warmth: Warmth
  activity: WorkspaceActivity | undefined
  /** Its terminal panes at work, and finished unseen, by pty pane id. */
  working: string[]
  finished: string[]
  /** What each is running, for the counts' tooltips. */
  workingPanes: Record<string, string>
  unseenPanes: Record<string, string>
  now: number
  selected: boolean
  onSelect: () => void
  onMenu: () => void
  onRemove: () => void
}): React.ReactElement {
  const scratch = w.id === SCRATCH_WORKSPACE_ID
  // Scratch cannot be removed, so it is never offered as cold; quiet is the most it gets.
  const temperature = scratch && warmth.temperature === 'cold' ? 'cool' : warmth.temperature
  return (
    <div
      className={`row row--clickable heat--${temperature}${selected ? ' row--selected' : ''}${working.length > 0 ? ' row--working' : ''}`}
      title={describe(w, temperature, activity, now)}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu()
      }}
    >
      <span className={scratch ? 'heat__icon' : 'heat__icon heat__icon--folder'}>
        {scratch ? <TerminalIcon size={13} /> : <FolderIcon size={13} />}
      </span>
      <span className="row__label">{w.name}</span>
      {working.length > 0 && (
        <button
          className="job-badge job-badge--working"
          title={`${describePanes(working.length, 'at work', working.map((id) => workingPanes[id] ?? ''))}. Click to go to it.`}
          onClick={(e) => {
            e.stopPropagation()
            revealPane(w.id, working[0]!)
          }}
        >
          <span className="spinner" />
          {working.length}
        </button>
      )}
      {finished.length > 0 && (
        <button
          className="job-badge job-badge--finished"
          title={`${describePanes(finished.length, 'finished since you last looked', finished.map((id) => unseenPanes[id] ?? ''))}. Click to go to it.`}
          onClick={(e) => {
            e.stopPropagation()
            revealPane(w.id, finished[0]!)
          }}
        >
          {finished.length}
        </button>
      )}
      <span className={scratch ? 'row__meta' : 'row__meta row__meta--hide-on-hover'}>
        {warmth.lastActive ? shortAgo(warmth.lastActive, now) : ''}
      </span>
      {!scratch && (
        <span className="row__actions">
          <button
            className="icon-button"
            title="Remove workspace"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
          >
            <CloseIcon size={11} />
          </button>
        </span>
      )}
    </div>
  )
}

function warmthOf(activity: WorkspaceActivity | undefined, clock: readonly string[]): Warmth {
  return {
    temperature: temperatureOf(activity, clock),
    heat: heatOf(activity, clock),
    lastActive: lastActiveAt(activity) ?? 0
  }
}

/** Every workspace but Scratch — which stays first, where it always was — hottest first, then the cold. */
function rank(workspaces: readonly Workspace[], warmth: ReadonlyMap<WorkspaceId, Warmth>): Ranking {
  const listed = workspaces
    .filter((w) => w.id !== SCRATCH_WORKSPACE_ID)
    .map((w) => ({ id: w.id, ...warmth.get(w.id)! }))
    .sort(compareWarmth)
  return {
    recent: listed.filter((w) => w.temperature !== 'cold').map((w) => w.id),
    cold: listed.filter((w) => w.temperature === 'cold').map((w) => w.id)
  }
}

const TEMPERATURE: Record<Temperature, string> = {
  hot: 'Hot — busy lately',
  warm: 'Warm — in use lately',
  cool: 'Cool — quiet lately',
  cold: `Cold — nothing in your last ${COLD_AFTER} days with Rigee`
}

/** A row's tooltip: what its colour means for it, and the times behind that. */
function describe(
  w: Workspace,
  temperature: Temperature,
  activity: WorkspaceActivity | undefined,
  now: number
): string {
  const lines = [w.name, TEMPERATURE[temperature]]
  if (activity?.usedAt) lines.push(`Last used ${longAgo(activity.usedAt, now)}`)
  if (activity?.outputAt) lines.push(`Terminal output ${longAgo(activity.outputAt, now)}`)
  if (!activity?.usedAt && !activity?.outputAt) lines.push('Nothing recorded yet')
  if (w.id === SCRATCH_WORKSPACE_ID) lines.push('Always available; no folders')
  else lines.push(w.folders.length === 1 ? '1 folder' : `${w.folders.length} folders`)
  return lines.join('\n')
}

/** The time, again every `ms`: so that "3m" becomes "4m", and a new day of use is noticed. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

// ---------------------------------------------------------------------------
