import { useSyncExternalStore } from 'react'

/**
 * What the tree has picked out and what it is in the middle of: the selected rows, the one with
 * the keyboard, what was cut or copied, the folder a drag would drop into, and the name being typed.
 *
 * Outside React, for the reason the listings are. A click changes two rows, and a tree of five
 * thousand rows re-rendered for each click would be the whole frame; so each row asks for its own
 * few bits through `useRowFlags`, and re-renders when one of those changes rather than when
 * anything does.
 */

export const SELECTED = 1
/** The row the keyboard is on. Outlined while the tree has the keyboard. */
export const FOCUSED = 2
/** Cut and waiting for a Paste: drawn faded, as in VS Code. */
export const CUT = 4
/** Inside the folder a drag would drop into — the folder's own row included. */
export const DROP = 8
/** Its name is being edited. */
export const RENAMING = 16
/** A folder with a box at the top for a new file's name, or a new folder's. */
export const NEW_FILE = 32
export const NEW_FOLDER = 64

/** The name box: renaming an entry, or naming a new one at the top of a folder. */
export type Editing = { kind: 'rename'; path: string } | { kind: 'new'; dir: string; folder: boolean }

let selected: ReadonlySet<string> = new Set()
let focused: string | null = null
/** Where a Shift-click or Shift-arrow range starts from: the last row picked without Shift. */
let anchor: string | null = null
let clip: { paths: string[]; cut: boolean } | null = null
let cut: ReadonlySet<string> = new Set()
let dropTarget: string | null = null
let editing: Editing | null = null
/**
 * A row to scroll into view the next time it renders. It may not exist yet: a pasted file arrives
 * with the next listing, a frame or a disk read after the paste.
 */
let revealing: string | null = null
/** What is being dragged out of the tree, for the drop targets to judge — a drag's data is unreadable until the drop. */
let dragging: string[] | null = null
let workspace: string | null = null

const listeners = new Set<() => void>()
const changed = (): void => { for (const l of listeners) l() }
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** `path` is `folder`, or inside it — on either kind of separator. */
export const within = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(folder + '/') || path.startsWith(folder + '\\')

function flagsOf(path: string): number {
  let flags = 0
  if (selected.has(path)) flags |= SELECTED
  if (focused === path) flags |= FOCUSED
  if (cut.has(path)) flags |= CUT
  if (dropTarget !== null && within(path, dropTarget)) flags |= DROP
  if (editing?.kind === 'rename' && editing.path === path) flags |= RENAMING
  if (editing?.kind === 'new' && editing.dir === path) flags |= editing.folder ? NEW_FOLDER : NEW_FILE
  return flags
}

/** This row's bits. A hook: re-renders the row when one of them changes, and only then. */
export function useRowFlags(path: string): number {
  return useSyncExternalStore(subscribe, () => flagsOf(path))
}

export function selection(): { selected: ReadonlySet<string>; focused: string | null; anchor: string | null } {
  return { selected, focused, anchor }
}

/**
 * Select these rows. `focus` is the one the keyboard is on, and the anchor of the next Shift-range
 * unless one is given; `reveal` scrolls it into view, whenever it gets there.
 */
export function select(
  paths: readonly string[],
  focus: string | null = paths[paths.length - 1] ?? null,
  options: { anchor?: string | null; reveal?: boolean } = {}
): void {
  selected = new Set(paths)
  focused = focus
  anchor = options.anchor === undefined ? focus : options.anchor
  if (options.reveal) revealing = focus
  changed()
}

/** True once, for the row that was asked to be scrolled into view. */
export function takeReveal(path: string): boolean {
  if (revealing !== path) return false
  revealing = null
  return true
}

export const clipboard = (): { paths: string[]; cut: boolean } | null => clip

export function setClipboard(paths: readonly string[] | null, isCut = false): void {
  putClip(paths, isCut)
  changed()
}

function putClip(paths: readonly string[] | null, isCut: boolean): void {
  clip = paths && paths.length > 0 ? { paths: [...paths], cut: isCut } : null
  cut = new Set(clip?.cut ? clip.paths : [])
}

export function setDropTarget(path: string | null): void {
  if (dropTarget === path) return
  dropTarget = path
  changed()
}

export const dragged = (): string[] | null => dragging
export function setDragging(paths: string[] | null): void {
  dragging = paths
}

export const currentEditing = (): Editing | null => editing
export function setEditing(next: Editing | null): void {
  editing = next
  changed()
}

/** Entries that have been deleted: out of the selection and off the clipboard. */
export function forget(paths: readonly string[]): void {
  const gone = (p: string): boolean => paths.some((path) => within(p, path))
  selected = new Set([...selected].filter((p) => !gone(p)))
  if (focused && gone(focused)) focused = null
  if (anchor && gone(anchor)) anchor = null
  if (clip) putClip(clip.paths.filter((p) => !gone(p)), clip.cut)
  changed()
}

/** Entries that have moved: what was selected or copied stays so, under the new names. */
export function follow(moves: ReadonlyArray<{ from: string; to: string }>): void {
  const moved = (p: string): string => {
    const m = moves.find((move) => within(p, move.from))
    return m ? m.to + p.slice(m.from.length) : p
  }
  selected = new Set([...selected].map(moved))
  if (focused) focused = moved(focused)
  if (anchor) anchor = moved(anchor)
  if (clip) putClip(clip.paths.map(moved), clip.cut)
  changed()
}

/**
 * Another workspace is on screen, and the paths picked out in the last one mean nothing in it. The
 * clipboard stays: its paths are absolute, and copying from one workspace into another is fair.
 */
export function enterWorkspace(id: string | null): void {
  if (id === workspace) return
  workspace = id
  selected = new Set()
  focused = anchor = revealing = dropTarget = null
  editing = null
  changed()
}
