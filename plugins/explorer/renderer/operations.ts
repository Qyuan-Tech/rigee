import {
  addWorkspaceFolders,
  editorsOnRequest,
  filesDeleted,
  filesMoved,
  isMac,
  openFile,
  openTerminal,
  pluginState,
  popupMenu,
  removeWorkspaceFolders,
  setPluginState,
  unsavedFiles
} from '@rigee/plugin-api'
import type { MenuItem } from '@rigee/plugin-api'
import { invalidate, invalidateUnder, listings, request } from './listings'
import {
  clipboard,
  follow,
  forget,
  select,
  selection,
  setClipboard,
  setEditing,
  within
} from './treeState'
import { nameProblem, type TransferResult } from '../protocol'

/**
 * What the tree does to files, VS Code's way: New File and New Folder, Rename, Cut, Copy and
 * Paste, Delete, Copy Path, Reveal — from the right-click menu, from the keyboard, and by dragging.
 *
 * The disk work and the questions it raises are the main half's (`main/files.ts`). This side keeps
 * everything else in step afterwards: the listings read again, the open folders, the selection and
 * the clipboard following what moved, and the shell told, so the tabs of a renamed file follow it
 * and those of a deleted one close.
 */

/** This plugin's id, which is also the key its per-workspace state is filed under. */
export const PLUGIN_ID = 'explorer'

/** A folder at the top of the tree. */
export interface Root {
  path: string
  name: string
  /** The workspace's own folder, which heads the tree and is drawn so it cannot be missed. */
  own: boolean
}

/** One row on screen. */
export interface Row {
  path: string
  dir: boolean
  /** One of the workspace's folders: never cut, renamed, deleted or dragged from the tree. */
  root: boolean
}

/** The tree an operation was asked from, as it is at that moment. */
export interface Tree {
  workspaceId: string | null
  roots: readonly Root[]
  /** The rows on screen, top to bottom: what the arrows walk and a Shift-range spans. */
  rows: () => Row[]
  /** Give the tree the keyboard back, once a name box closes. */
  refocus: () => void
}

const windows = (): boolean => window.rigee.platform === 'win32'

export const nameOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** The folder a path is in, on either kind of separator, with a disk's root kept whole: `/`, `C:\`. */
export function parentOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (i <= 0) return path.slice(0, i + 1) || path
  if (i === 2 && path[1] === ':') return path.slice(0, 3)
  return path.slice(0, i)
}

const isRoot = (tree: Tree, path: string): boolean => tree.roots.some((r) => r.path === path)

/**
 * A folder the workspace lists, which Remove Folder from Workspace can take out of it: any root but
 * the workspace's own folder, which heads the tree for as long as the workspace has its file.
 */
const isListed = (tree: Tree, path: string): boolean => tree.roots.some((r) => r.path === path && !r.own)

/** A row's folder: itself, or the one the file is in. Where a paste, a drop or a New File lands. */
export const folderOf = (row: Row): string => (row.dir ? row.path : parentOf(row.path))

/**
 * What a command's rejection says, without the plumbing Electron and the shell wrap round it —
 * `Error invoking remote method 'plugin:invoke': Error: plugin:invoke: explorer:rename: …`.
 */
export function problemIn(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '').replace(/^(?:[\w-]+:[\w-]+: )+/, '')
}

/**
 * Start an operation from a key or a click, which has nobody to hand a failure to. What the user
 * needs to know, main has already said in a dialog; anything that reaches here is a fault, and goes
 * to the console rather than into an unhandled rejection.
 */
export function run(operation: Promise<unknown>): void {
  operation.catch((e: unknown) => console.warn(`[explorer] ${problemIn(e)}`))
}

// --- which folders are open ------------------------------------------------------

/**
 * Which directories are open, for one workspace.
 *
 * Kept in the shell's per-plugin state rather than in component state because it has to outlive
 * the components: switching workspaces unmounts the whole tree, so local state went with it and
 * coming back re-expanded everything from defaults instead of showing it as you left it.
 *
 * UNDEFINED IS A REAL ANSWER and the tree depends on it: it means this workspace has never been
 * opened with the explorer, which is what triggers the one-time seeding of the root folders. An
 * empty array means the user collapsed everything and must be left alone.
 */
export function readExpanded(state: Record<string, unknown> | undefined): string[] | undefined {
  const dirs = state?.expandedDirs
  return Array.isArray(dirs) ? (dirs as string[]) : undefined
}

/**
 * Read at the moment of writing, never from a render: an operation finishes after a round trip to
 * main, and the user may have opened or shut a folder meanwhile.
 */
function changeExpanded(tree: Tree, change: (dirs: string[]) => string[]): void {
  if (!tree.workspaceId) return
  const dirs = readExpanded(pluginState(PLUGIN_ID, tree.workspaceId)) ?? []
  setPluginState(PLUGIN_ID, tree.workspaceId, { expandedDirs: [...new Set(change(dirs))] })
}

export const expand = (tree: Tree, dirs: readonly string[]): void => changeExpanded(tree, (open) => [...open, ...dirs])

/** Flip one folder open or shut. */
export function toggleOpen(tree: Tree, dir: string): void {
  changeExpanded(tree, (open) => (open.includes(dir) ? open.filter((d) => d !== dir) : [...open, dir]))
}

/** Shut one folder, and what is open inside it stays remembered for when it opens again. */
const collapse = (tree: Tree, dir: string): void => changeExpanded(tree, (open) => open.filter((d) => d !== dir))

const isOpen = (tree: Tree, dir: string): boolean =>
  !!tree.workspaceId && (readExpanded(pluginState(PLUGIN_ID, tree.workspaceId)) ?? []).includes(dir)

// --- after the disk has changed ----------------------------------------------------

/** Entries renamed or moved: everything that named them by their old paths follows them. */
function moved(tree: Tree, moves: Array<{ from: string; to: string }>): void {
  invalidate(moves.flatMap((m) => [parentOf(m.from), parentOf(m.to)]))
  invalidateUnder(moves.map((m) => m.from))
  changeExpanded(tree, (open) =>
    open.map((dir) => {
      const m = moves.find((move) => within(dir, move.from))
      return m ? m.to + dir.slice(m.from.length) : dir
    })
  )
  follow(moves)
  filesMoved(moves)
}

/** What a paste or a drop did: the folder opens and what landed in it is selected, in view. */
function landed(tree: Tree, into: string, mode: 'copy' | 'move', result: TransferResult): void {
  if (result.addToWorkspace) run(addWorkspaceFolders(result.addToWorkspace))
  if (result.done.length === 0) return
  if (mode === 'move') moved(tree, result.done)
  else invalidate([into])
  expand(tree, [into])
  const at = result.done.map((d) => d.to)
  select(at, at[at.length - 1] ?? null, { reveal: true })
}

// --- the operations ------------------------------------------------------------------

/** Rows that can be cut, copied, renamed or deleted: everything but the workspace's own folders. */
const movable = (tree: Tree, paths: readonly string[]): string[] => paths.filter((p) => !isRoot(tree, p))

export function copyEntries(tree: Tree, paths: readonly string[], cut: boolean): void {
  const entries = movable(tree, paths)
  if (entries.length > 0) setClipboard(entries, cut)
}

/** Paste into a folder. A cut is used up by its paste; a copy can be pasted again. */
export async function paste(tree: Tree, into: string): Promise<void> {
  const clip = clipboard()
  if (!clip) return
  const mode = clip.cut ? 'move' : 'copy'
  const result = await request('explorer:transfer', {
    sources: clip.paths,
    target: into,
    mode,
    ...(clip.cut ? { unsaved: unsavedFiles(clip.paths) } : {})
  })
  if (clip.cut && result.done.length > 0) setClipboard(null)
  landed(tree, into, mode, result)
}

/** Entries dragged within the tree: moved, or copied with the copy modifier held. */
export async function dropEntries(tree: Tree, into: string, paths: string[], copy: boolean): Promise<void> {
  const mode = copy ? 'copy' : 'move'
  const result = await request('explorer:transfer', {
    sources: paths,
    target: into,
    mode,
    ...(copy ? {} : { unsaved: unsavedFiles(paths) })
  })
  landed(tree, into, mode, result)
}

/** Files and folders dragged in from Finder, Explorer or a file manager: copied in. */
export async function dropFromOutside(tree: Tree, into: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const result = await request('explorer:transfer', {
    sources: paths,
    target: into,
    mode: 'copy',
    external: true,
    intoRoot: isRoot(tree, into)
  })
  landed(tree, into, 'copy', result)
}

/**
 * Whether entries dragged within the tree may drop here. Never into themselves or below; and a
 * move that would leave everything where it is offers no drop at all, which is how the pointer
 * says so before the button is let go.
 */
export function canDrop(paths: readonly string[], into: string, copy: boolean): boolean {
  if (paths.length === 0 || paths.some((p) => within(into, p))) return false
  return copy || paths.some((p) => parentOf(p) !== into)
}

/** The row the keyboard goes to once these are gone: the next that survives, or else the one before. */
function survivor(rows: readonly Row[], gone: readonly string[]): string | null {
  const lost = (row: Row): boolean => gone.some((path) => within(row.path, path))
  const last = rows.reduce((at, row, i) => (lost(row) ? i : at), -1)
  for (let i = last + 1; i < rows.length; i++) if (!lost(rows[i]!)) return rows[i]!.path
  for (let i = last - 1; i >= 0; i--) if (!lost(rows[i]!)) return rows[i]!.path
  return null
}

/** Delete, after main has asked — to the Trash unless `permanently`. */
export async function deleteEntries(tree: Tree, paths: readonly string[], permanently: boolean): Promise<void> {
  const targets = movable(tree, paths)
  if (targets.length === 0) return
  const next = survivor(tree.rows(), targets)
  const deleted = await request('explorer:delete', { paths: targets, permanently, unsaved: unsavedFiles(targets) })
  if (deleted.length === 0) return
  invalidate(deleted.map(parentOf))
  invalidateUnder(deleted)
  changeExpanded(tree, (open) => open.filter((dir) => !deleted.some((path) => within(dir, path))))
  forget(deleted)
  filesDeleted(deleted)
  if (next) select([next], next, { reveal: true })
  tree.refocus()
}

/**
 * Remove Folder from Workspace, for the workspace's folders among `paths`. The rules are the shell's:
 * the workspace stops listing them, and so does its file when it has one; nothing else on disk is
 * touched. The keyboard goes to the row after them, as after a Delete — never left on a row that has
 * gone, where the next Delete would reach for a whole repo.
 */
export async function removeFromWorkspace(tree: Tree, paths: readonly string[]): Promise<void> {
  const folders = paths.filter((p) => isListed(tree, p))
  if (folders.length === 0) return
  const next = survivor(tree.rows(), folders)
  // Out of the workspace as soon as this is called; the file is written after.
  const removing = removeWorkspaceFolders(folders)
  select(next ? [next] : [], next, { reveal: true })
  tree.refocus()
  await removing
}

export function startRename(tree: Tree, path: string): void {
  if (isRoot(tree, path)) return
  select([path], path)
  setEditing({ kind: 'rename', path })
}

/** Rename to what was typed. Rejects with the reason, which the name box shows under itself. */
export async function rename(tree: Tree, path: string, name: string): Promise<void> {
  if (name === nameOf(path)) {
    setEditing(null)
    return
  }
  const unsaved = unsavedFiles([path])
  if (unsaved.length > 0) {
    throw new Error(
      unsaved[0] === path ? 'It has unsaved changes. Save or undo them first.' : `“${nameOf(unsaved[0]!)}” in it has unsaved changes. Save or undo them first.`
    )
  }
  const to = await request('explorer:rename', { path, name })
  setEditing(null)
  moved(tree, [{ from: path, to }])
  select([to], to, { reveal: true })
}

/** New File… and New Folder…: a name box at the top of the folder, opened first if it was shut. */
export function startNew(tree: Tree, dir: string, folder: boolean): void {
  expand(tree, [dir])
  setEditing({ kind: 'new', dir, folder })
}

/**
 * Make what was typed. A new file opens, ready to type into, as it does in VS Code; folders a
 * nested name made on the way open too, so the new entry is in sight.
 */
export async function create(tree: Tree, dir: string, name: string, folder: boolean): Promise<void> {
  const path = await request('explorer:create', { dir, name, folder })
  setEditing(null)
  const between: string[] = []
  for (let p = parentOf(path); p.length > dir.length && within(p, dir); p = parentOf(p)) between.push(p)
  invalidate([dir, ...between])
  expand(tree, [dir, ...between])
  select([path], path, { reveal: true })
  if (!folder) openFile({ path, title: nameOf(path) })
}

/** The name box's verdict as you type: refused, or allowed with a warning. */
export interface NameIssue {
  message: string
  blocking: boolean
}

/**
 * What is wrong with a name typed for `dir`, checked against the folder's listing as the tree has
 * it; main checks the disk itself before anything is made. `self` is the entry being renamed, so
 * its own name — or the same name in another case — is not "taken".
 */
export function nameIssue(name: string, dir: string, self: string | null, nested: boolean): NameIssue | null {
  const problem = nameProblem(name, { nested, windows: windows() })
  if (problem) return { message: problem, blocking: true }
  const first = name.split(windows() ? /[\\/]/ : '/')[0]!
  const same = (a: string, b: string): boolean =>
    window.rigee.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase()
  const clash = listings.get(dir)?.find((entry) => same(entry.name, first) && entry.path !== self)
  // A nested name may go through a folder that is already there; it cannot go through a file.
  if (clash && (first === name || !clash.isDir)) {
    return { message: `“${first}” already exists here. Choose a different name.`, blocking: true }
  }
  if (name !== name.trim()) return { message: 'The name starts or ends with a space.', blocking: false }
  return null
}

/** Copy Path, and Copy Relative Path — relative to the workspace folder it is in, as VS Code's is. */
export function copyPaths(tree: Tree, paths: readonly string[], relative: boolean): void {
  const relativeOf = (path: string): string => {
    const root = tree.roots.filter((r) => within(path, r.path)).sort((a, b) => b.path.length - a.path.length)[0]
    return root && root.path !== path ? path.slice(root.path.length + 1) : nameOf(path)
  }
  run(request('explorer:copyText', { text: paths.map((p) => (relative ? relativeOf(p) : p)).join('\n') }))
}

// --- the menu --------------------------------------------------------------------------

const revealLabel = (): string =>
  isMac() ? 'Reveal in Finder' : windows() ? 'Reveal in File Explorer' : 'Open Containing Folder'

/**
 * A row's right-click menu, VS Code's for a file or a folder. Right-clicking a row outside the
 * selection selects it alone first, as Finder and VS Code do; inside it, the menu is for all the
 * selected rows, and offers only what makes sense for several.
 *
 * The workspace's own folders offer no Cut, Rename or Delete: removing one of those is a change to
 * the workspace, not to a file, and Remove Folder from Workspace is what a folder it lists offers
 * instead — in its own group after the terminals, where VS Code has it.
 */
export async function showMenu(tree: Tree, row: Row): Promise<void> {
  const before = selection()
  const targets = before.selected.has(row.path) ? [...before.selected] : [row.path]
  if (!before.selected.has(row.path)) select([row.path], row.path)
  const many = targets.length > 1
  const entries = movable(tree, targets)
  const mac = isMac()
  const item = (id: string, label: string, accelerator?: string, enabled = true): MenuItem => ({
    kind: 'item',
    id,
    label,
    enabled,
    ...(accelerator ? { accelerator } : {})
  })
  const separator: MenuItem = { kind: 'separator' }

  const items: MenuItem[] = []
  // The editors that open a file only when asked — a Markdown file's Open Preview — first, where VS
  // Code puts them. Which those are is the shell's to say, from the manifests, so the tree knows
  // nothing about Markdown.
  const offers = !many && !row.dir ? editorsOnRequest(row.path) : []
  if (offers.length > 0) items.push(...offers.map((o) => item(o.viewType, o.label)), separator)
  if (!many && row.dir) items.push(item('new-file', 'New File…'), item('new-folder', 'New Folder…'), separator)
  if (!many) {
    items.push(
      item('reveal', revealLabel(), mac ? 'Alt+Cmd+R' : 'Shift+Alt+R'),
      item('terminal-tab', 'Open in Terminal Tab'),
      item('terminal-split', 'Open in Terminal Split'),
      separator
    )
  }
  if (isListed(tree, row.path)) items.push(item('remove-folder', 'Remove Folder from Workspace'), separator)
  if (entries.length > 0) items.push(item('cut', 'Cut', 'CmdOrCtrl+X'), item('copy', 'Copy', 'CmdOrCtrl+C'))
  items.push(item('paste', 'Paste', 'CmdOrCtrl+V', clipboard() !== null))
  items.push(separator, item('copy-path', 'Copy Path', mac ? 'Alt+Cmd+C' : 'Shift+Alt+C'))
  if (many || !row.root) items.push(item('copy-relative-path', 'Copy Relative Path', mac ? 'Alt+Shift+Cmd+C' : 'Ctrl+Shift+Alt+C'))
  if (entries.length > 0) {
    items.push(separator)
    if (!many) items.push(item('rename', 'Rename…', mac ? 'Enter' : 'F2'))
    items.push(item('delete', 'Delete', mac ? 'Cmd+Backspace' : 'Delete'))
  }

  const choice = await popupMenu(items)
  // An offer is named by its view type, which has a dot in it, so no command below can be mistaken for one.
  const offer = offers.find((o) => o.viewType === choice)
  if (offer) {
    openFile({ path: row.path, viewType: offer.viewType })
    return
  }
  const into = folderOf(row)
  switch (choice) {
    case 'new-file': startNew(tree, row.path, false); break
    case 'new-folder': startNew(tree, row.path, true); break
    case 'reveal': run(request('explorer:reveal', { path: row.path })); break
    // A shell started where the user is pointing: in the folder, or in the folder the file is in.
    case 'terminal-tab': openTerminal({ cwd: into, where: 'tab' }); break
    case 'terminal-split': openTerminal({ cwd: into, where: 'split' }); break
    case 'remove-folder': await removeFromWorkspace(tree, targets); break
    case 'cut': copyEntries(tree, targets, true); break
    case 'copy': copyEntries(tree, targets, false); break
    case 'paste': await paste(tree, into); break
    case 'copy-path': copyPaths(tree, targets, false); break
    case 'copy-relative-path': copyPaths(tree, targets, true); break
    case 'rename': startRename(tree, row.path); break
    case 'delete': await deleteEntries(tree, targets, false); break
  }
}

// --- the mouse ---------------------------------------------------------------------------

/**
 * A click on a row. Plain, it selects the row and opens it — a folder opens or shuts; a file opens
 * in its viewer, which leaves the keyboard here, so the arrows and Delete go on acting on the tree.
 * With Cmd (Ctrl elsewhere) it adds the row to the selection or takes it out; with Shift it selects
 * everything from the last row picked.
 */
export function clickRow(tree: Tree, row: Row, e: React.MouseEvent): void {
  const { selected, anchor } = selection()
  if (e.shiftKey && anchor) {
    selectRange(tree.rows(), anchor, row.path)
    return
  }
  if (isMac() ? e.metaKey : e.ctrlKey) {
    const next = new Set(selected)
    if (!next.delete(row.path)) next.add(row.path)
    select([...next], row.path)
    return
  }
  select([row.path], row.path)
  if (row.dir) toggleOpen(tree, row.path)
  else openFile({ path: row.path, title: nameOf(row.path), preserveFocus: true })
}

/** A double click opens a file and gives its viewer the keyboard, to start typing. */
export function doubleClickRow(row: Row): void {
  if (!row.dir) openFile({ path: row.path, title: nameOf(row.path) })
}

function selectRange(rows: readonly Row[], from: string, to: string): void {
  const a = rows.findIndex((r) => r.path === from)
  const b = rows.findIndex((r) => r.path === to)
  if (a < 0 || b < 0) {
    select([to], to)
    return
  }
  select(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.path), to, { anchor: from, reveal: true })
}

// --- the keyboard -------------------------------------------------------------------------

/**
 * A key pressed while the tree has the keyboard: true if it was the tree's, and the caller cancels
 * it so neither the shell's shortcuts nor the app menu act on it too.
 *
 * VS Code's keys. On a Mac Delete is ⌘⌫, and ⌫ alone as well, which is the key a Mac keyboard calls
 * delete; ⌥⌘⌫ deletes for good. Elsewhere it is Delete, and Shift+Delete for good. Every one of them
 * asks first. Enter renames on a Mac, as in Finder, and opens elsewhere.
 */
export function treeKey(tree: Tree, e: React.KeyboardEvent): boolean {
  if (e.nativeEvent.isComposing) return false
  const mac = isMac()
  const mod = mac ? e.metaKey : e.ctrlKey
  const rows = tree.rows()
  if (rows.length === 0) return false
  const { selected, focused, anchor } = selection()
  const at = rows.findIndex((r) => r.path === focused)
  const row = at >= 0 ? rows[at]! : null
  const targets = selected.size > 0 ? [...selected] : row ? [row.path] : []
  const go = (index: number, extend: boolean): void => {
    const to = rows[Math.max(0, Math.min(rows.length - 1, index))]!
    if (extend && anchor) selectRange(rows, anchor, to.path)
    else select([to.path], to.path, { reveal: true })
  }
  const letter = (code: string): boolean => e.code === code

  switch (e.key) {
    case 'ArrowDown':
      if (mac && e.metaKey) {
        if (row && !row.dir) openFile({ path: row.path, title: nameOf(row.path) })
        return !!row
      }
      go(at + 1, e.shiftKey)
      return true
    case 'ArrowUp':
      go(at < 0 ? rows.length - 1 : at - 1, e.shiftKey)
      return true
    case 'Home':
      go(0, e.shiftKey)
      return true
    case 'End':
      go(rows.length - 1, e.shiftKey)
      return true
    case 'ArrowRight':
      if (!row?.dir) return !!row
      if (!isOpen(tree, row.path)) toggleOpen(tree, row.path)
      else if (rows[at + 1] && within(rows[at + 1]!.path, row.path)) go(at + 1, false)
      return true
    case 'ArrowLeft': {
      if (!row) return false
      if (row.dir && isOpen(tree, row.path)) {
        collapse(tree, row.path)
        return true
      }
      const parent = rows.findIndex((r) => r.path === parentOf(row.path))
      if (parent >= 0) go(parent, false)
      return true
    }
    case ' ':
      if (!row) return false
      if (row.dir) toggleOpen(tree, row.path)
      else openFile({ path: row.path, title: nameOf(row.path), preserveFocus: true })
      return true
    case 'Enter':
      if (!row) return false
      if (mac) startRename(tree, row.path)
      else if (row.dir) toggleOpen(tree, row.path)
      else openFile({ path: row.path, title: nameOf(row.path) })
      return true
    case 'F2':
      if (row) startRename(tree, row.path)
      return !!row
    case 'Delete':
      run(deleteEntries(tree, targets, e.shiftKey))
      return true
    case 'Backspace':
      if (!mac) return false
      run(deleteEntries(tree, targets, e.metaKey && e.altKey))
      return true
    case 'Escape':
      if (clipboard()?.cut) setClipboard(null)
      else if (selected.size > 1 && row) select([row.path], row.path)
      else return false
      return true
  }

  if (letter('KeyC') && (mac ? e.metaKey && e.altKey : e.altKey && e.shiftKey)) {
    // ⌥⌘C and ⌥⇧⌘C on a Mac; Shift+Alt+C and Ctrl+Shift+Alt+C elsewhere.
    const relative = mac ? e.shiftKey : e.ctrlKey
    copyPaths(tree, targets, relative)
    return true
  }
  if (letter('KeyR') && (mac ? e.metaKey && e.altKey : e.altKey && e.shiftKey) && row) {
    run(request('explorer:reveal', { path: row.path }))
    return true
  }
  if (!mod || e.altKey || e.shiftKey) return false
  switch (e.key.toLowerCase()) {
    case 'c':
      copyEntries(tree, targets, false)
      return true
    case 'x':
      copyEntries(tree, targets, true)
      return true
    case 'v': {
      const into = row ? folderOf(row) : tree.roots[0]?.path
      if (!into) return false
      run(paste(tree, into))
      return true
    }
    case 'a':
      select(rows.map((r) => r.path), row?.path ?? rows[0]!.path)
      return true
  }
  return false
}
