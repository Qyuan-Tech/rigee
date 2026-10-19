import { allTabs } from './groups'
import { onEvent, rpc } from './ipc'
import { leaves } from './paneTree'
import { editorTabTitle, holdsEdits, resolveViewType, viewsIn } from './plugins/registry'
import { rowOf, useApp } from './store'
import type { TabId, WorkspaceId } from '@shared/types'
import type { FileHandlers, FileMove, TextSelection } from '@rigee/plugin-api'

/**
 * What the shell knows about files being edited: which have unsaved changes, how to save them, and
 * where a newly opened one should put its cursor.
 *
 * The shell owns none of the editing — Monaco is a plugin's — but it owns the TABS and the WINDOW,
 * and those are what close. So the editor reports "this file has changes, and here is how to save
 * or drop them", and the shell asks before a tab or the app goes away with them. The same split
 * as everything else here: the plugin knows what a document is, the shell knows what closing is.
 */

// --- unsaved changes ---------------------------------------------------------

/** How to save or drop each dirty file. Functions, so kept out of the store. */
const handlers = new Map<string, FileHandlers>()

/** Called by an editor whenever a file's unsaved state changes. */
export function setFileDirty(path: string, dirty: boolean, fileHandlers?: FileHandlers): void {
  if (dirty && fileHandlers) handlers.set(path, fileHandlers)
  if (!dirty) handlers.delete(path)
  const current = useApp.getState().dirtyFiles
  if (!!current[path] === dirty) return
  const next = { ...current }
  if (dirty) next[path] = true
  else delete next[path]
  useApp.setState({ dirtyFiles: next })
}

export const dirtyPaths = (): string[] => Object.keys(useApp.getState().dirtyFiles)

/**
 * Save each file. False, after saying why, when one could not be saved — a read-only volume, a
 * file locked by another program, the user declining to overwrite a change made on disk. The
 * close or quit that asked for the save then does not happen, and a prompt that simply failed to
 * close with no word of explanation reads as a broken app.
 */
async function saveAll(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    try {
      await handlers.get(path)?.save()
    } catch (err) {
      window.alert(`Not saved: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }
  return true
}

async function discardAll(paths: readonly string[]): Promise<void> {
  for (const path of paths) await handlers.get(path)?.discard().catch(() => undefined)
}

interface CloseOptions {
  /**
   * The tab a bulk close was aimed at: "Close Others" on this one. Any OTHER tab it would take with
   * a program still running in its terminal is asked about first. The tab aimed at is not: it was
   * chosen, exactly as pressing its × chooses it.
   */
  sweptFrom?: TabId
}

/**
 * Close tabs, asking first about any unsaved file that would go with them — and, for a sweep,
 * about any program still running in a terminal it would stop.
 *
 * Only files that would really be gone: a file still open in another tab — the same document in
 * two columns — keeps its changes there, and asking about it would be asking about nothing. A
 * preview of it does not count either way: it shows the file as it is on disk, so it neither keeps
 * the changes nor loses them. Save saves them and closes; Don't Save drops the changes and closes;
 * Cancel closes nothing.
 */
export async function closeTabsSafely(
  workspaceId: WorkspaceId,
  tabIds: readonly TabId[],
  options: CloseOptions = {}
): Promise<boolean> {
  if (options.sweptFrom !== undefined) {
    const collateral = tabIds.filter((id) => id !== options.sweptFrom)
    if (!(await confirmRunning(workspaceId, collateral, tabIds.length))) return false
  }

  const s = useApp.getState()
  const closing = new Set(tabIds)
  const remaining = Object.values(s.rowsByWorkspace).flatMap((row) => allTabs(row)).filter((t) => !closing.has(t.id))
  const stillOpen = new Set(
    remaining.flatMap((t) => (t.kind === 'editor' && holdsEdits(t.viewType) ? [t.filePath] : []))
  )
  const lost = [
    ...new Set(
      allTabs(rowOf(s, workspaceId))
        .filter(
          (t) =>
            closing.has(t.id) && t.kind === 'editor' && holdsEdits(t.viewType) &&
            s.dirtyFiles[t.filePath] && !stillOpen.has(t.filePath)
        )
        .map((t) => (t.kind === 'editor' ? t.filePath : ''))
    )
  ]

  if (lost.length > 0) {
    const choice = await rpc['dialog:unsaved']({ files: lost, quitting: false })
    if (choice === 'cancel') return false
    if (choice === 'save' && !(await saveAll(lost))) return false
    if (choice === 'discard') await discardAll(lost)
  }
  useApp.getState().closeTabs(workspaceId, [...tabIds])
  return true
}

/**
 * Ask before stopping programs still running in the terminals among `tabIds`. True means go ahead:
 * nothing there is running, the platform cannot tell, or the user said close them anyway.
 *
 * A shell idling at its prompt is not asked about — closing one loses nothing — which keeps the
 * question rare enough to be read when it does come: an agent mid-task, a build, a server.
 */
async function confirmRunning(workspaceId: WorkspaceId, tabIds: readonly TabId[], closing: number): Promise<boolean> {
  const ids = new Set(tabIds)
  const paneIds = allTabs(rowOf(useApp.getState(), workspaceId)).flatMap((t) =>
    t.kind === 'terminal' && ids.has(t.id) ? leaves(t.root).flatMap((l) => (l.paneId ? [l.paneId] : [])) : []
  )
  if (paneIds.length === 0) return true
  // A question that cannot be answered does not stop the close: the user asked for it.
  const running = await rpc['terminal:running']({ paneIds }).catch(() => [])
  if (running.length === 0) return true
  return rpc['dialog:closeRunning']({ processes: running.map((r) => r.process), tabs: closing })
}

/**
 * Keep main told which files are unsaved, so quitting or closing the window can ask before
 * anything is torn down — main kills every shell the moment a quit begins, and a question asked
 * by the page on its way out would come after that. And answer main when it asks for everything
 * to be saved on the way out.
 */
export function installUnsavedBridge(): () => void {
  // Said once now, whatever it is: main may have reset its copy since the last time it was told.
  let last = dirtyPaths().sort().join('\n')
  void rpc['app:setDirtyFiles']({ files: dirtyPaths().sort() })
  const unsubscribe = useApp.subscribe(
    (s) => s.dirtyFiles,
    (dirty) => {
      const files = Object.keys(dirty).sort()
      const key = files.join('\n')
      if (key === last) return
      last = key
      void rpc['app:setDirtyFiles']({ files })
    }
  )
  const off = onEvent('app:saveAll', ({ id }) => {
    void saveAll(dirtyPaths()).then((ok) => rpc['app:saveAllDone']({ id, ok }))
  })
  return () => { unsubscribe(); off() }
}

// --- files a plugin moved or deleted ---------------------------------------------

/** `file` is `path`, or inside it when `path` is a folder — on either kind of separator. */
const covers = (path: string, file: string): boolean =>
  file === path || file.startsWith(path + '/') || file.startsWith(path + '\\')

/** Unsaved files at these paths or inside them: what deleting or moving them would lose. */
export function unsavedFiles(paths: readonly string[]): string[] {
  return dirtyPaths().filter((file) => paths.some((path) => covers(path, file)))
}

/** Where `path` is after these moves: by the first that covers it, or where it was. */
export function movedPath(moves: readonly FileMove[], path: string): string {
  const move = moves.find((m) => covers(m.from, path))
  return move ? move.to + path.slice(move.from.length) : path
}

/**
 * The file tree renamed or moved these, so every tab showing one follows it, in every workspace.
 * Its title is the new name, and its viewer is picked again: a file renamed to `.pdf` is a PDF. A
 * preview stays one: the reader asked to see the document that way, and a new name does not change
 * that — its tab keeps the prefix that tells it from the file's own.
 *
 * Unsaved files are not moved: the tree refuses, because their changes live in the editor's
 * document for the OLD path, and a tab that followed would show the file without them.
 */
export function filesMoved(moves: readonly FileMove[]): void {
  const s = useApp.getState()
  for (const [workspaceId, row] of Object.entries(s.rowsByWorkspace)) {
    for (const tab of allTabs(row)) {
      if (tab.kind !== 'editor') continue
      const filePath = movedPath(moves, tab.filePath)
      if (filePath === tab.filePath) continue
      const viewType = holdsEdits(tab.viewType) ? (resolveViewType(filePath) ?? undefined) : tab.viewType
      s.updateTab(workspaceId, tab.id, { filePath, title: editorTabTitle(filePath, viewType), viewType })
    }
  }
}

/**
 * The file tree deleted these: their tabs close, in every workspace, without asking — the user
 * just said yes to the deletion, which named any unsaved changes it would lose. Those are dropped
 * first, or quitting would offer to save a file that is no longer there, and saving it would bring
 * it back.
 */
export function filesDeleted(paths: readonly string[]): void {
  void discardAll(unsavedFiles(paths)).then(() => {
    const s = useApp.getState()
    for (const [workspaceId, row] of Object.entries(s.rowsByWorkspace)) {
      const gone = allTabs(row)
        .filter((t) => t.kind === 'editor' && paths.some((path) => covers(path, t.filePath)))
        .map((t) => t.id)
      if (gone.length > 0) s.closeTabs(workspaceId, gone)
    }
  })
}

// --- where a file opens ----------------------------------------------------------

/**
 * The tab an `openFile({ preserveFocus })` is about to mount, until its viewer asks whether to take
 * the keyboard. One tab rather than a set: only the latest click is about to mount anything, and a
 * viewer that never asks — an image — leaves nothing behind to clear up.
 */
let backgroundTab: TabId | null = null

export function openInBackground(tabId: TabId | null): void {
  backgroundTab = tabId
}

/** True once, for the tab opened in the background: its viewer leaves the keyboard alone. */
export function openedInBackground(tabId: TabId): boolean {
  if (backgroundTab !== tabId) return false
  backgroundTab = null
  return true
}

/**
 * Selections waiting for their editor. A search result opens a file and asks for line 812 before
 * the editor exists — it mounts, lazily, a frame or a network fetch later — so the request is
 * parked until the editor for that tab subscribes, and delivered the moment it does.
 */
const pendingReveal = new Map<TabId, TextSelection>()
const revealListeners = new Map<TabId, Set<(selection: TextSelection) => void>>()

export function requestReveal(tabId: TabId, selection: TextSelection): void {
  const listeners = revealListeners.get(tabId)
  if (listeners && listeners.size > 0) listeners.forEach((cb) => cb(selection))
  else pendingReveal.set(tabId, selection)
}

export function onRevealInFile(tabId: TabId, cb: (selection: TextSelection) => void): () => void {
  let set = revealListeners.get(tabId)
  if (!set) revealListeners.set(tabId, (set = new Set()))
  set.add(cb)
  const pending = pendingReveal.get(tabId)
  if (pending) {
    pendingReveal.delete(tabId)
    cb(pending)
  }
  return () => {
    set.delete(cb)
    if (set.size === 0) revealListeners.delete(tabId)
  }
}

// --- side panels -------------------------------------------------------------------

const viewListeners = new Map<string, Set<() => void>>()
let pendingView: string | null = null

/**
 * Show a side panel and hand it the keyboard: what the workspace-search shortcut does.
 *
 * The panel may not be mounted yet — it mounts when it becomes the left panel's view, and its
 * plugin may still be loading — so the "take the keyboard" part waits for it to subscribe.
 */
export function revealView(viewId: string): boolean {
  const s = useApp.getState()
  const left = viewsIn('left').some((v) => v.id === viewId)
  const right = !left && viewsIn('right').some((v) => v.id === viewId)
  if (!left && !right) return false
  s.setLayout(left ? { leftView: viewId, leftCollapsed: false } : { rightCollapsed: false })
  const listeners = viewListeners.get(viewId)
  if (listeners && listeners.size > 0) listeners.forEach((cb) => cb())
  else pendingView = viewId
  return true
}

export function onViewRevealed(viewId: string, cb: () => void): () => void {
  let set = viewListeners.get(viewId)
  if (!set) viewListeners.set(viewId, (set = new Set()))
  set.add(cb)
  if (pendingView === viewId) {
    pendingView = null
    cb()
  }
  return () => {
    set.delete(cb)
    if (set.size === 0) viewListeners.delete(viewId)
  }
}
