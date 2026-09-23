/**
 * Pure arithmetic for a row of editor groups.
 *
 * Extracted for the same reason `paneTree.ts` and `tabs.ts` were: every failure mode in here is a
 * quiet one. A split that forgets to renormalise leaves a row that does not fill the window; a
 * close that picks the wrong survivor moves the user to a group they were not looking at; a
 * cross-group drag that removes before it inserts loses the tab — and a lost terminal tab takes a
 * running process with it. None of that throws, and all of it is tedious to reproduce by hand once
 * three groups and a drag are in play.
 *
 * Deliberately a flat ROW rather than `paneTree`'s nested tree. Groups only ever sit side by side,
 * and a tree would buy nesting nobody asked for at the cost of every operation here becoming a
 * walk. Terminals keep the tree, because panes inside one terminal tab genuinely nest.
 *
 * INVARIANT, maintained by every function that returns a row: `sizes.length === groups.length`,
 * every size is positive, and they sum to 1. `activeGroupId` names a group that exists, and there
 * is always at least one group — an empty one shows the shell's "Nothing open" state, which is
 * where a file goes when you click it.
 */

import { nextActiveTab } from './tabs'
import type { Tab, TabId } from '@shared/types'

export type GroupId = string

export interface TabGroup {
  id: GroupId
  tabs: Tab[]
  /** Which tab this group shows. Null only while the group is empty. */
  activeTabId: TabId | null
}

export interface GroupRow {
  groups: TabGroup[]
  /** One fraction per group, left to right, summing to 1. */
  sizes: number[]
  activeGroupId: GroupId
}

/** The smallest fraction a group may be squeezed to, so a group can never become unclickable. */
const MIN_SIZE = 0.08

export function newGroup(id: GroupId, tabs: Tab[] = []): TabGroup {
  return { id, tabs, activeTabId: tabs[tabs.length - 1]?.id ?? null }
}

export function singleGroupRow(id: GroupId, tabs: Tab[] = []): GroupRow {
  return { groups: [newGroup(id, tabs)], sizes: [1], activeGroupId: id }
}

export const groupById = (row: GroupRow, id: GroupId): TabGroup | undefined =>
  row.groups.find((g) => g.id === id)

export const activeGroup = (row: GroupRow): TabGroup =>
  groupById(row, row.activeGroupId) ?? row.groups[0]!

/** Which group holds a tab, if any. Needed because a tab id is unique across the whole row. */
export const groupOfTab = (row: GroupRow, tabId: TabId): TabGroup | undefined =>
  row.groups.find((g) => g.tabs.some((t) => t.id === tabId))

export const allTabs = (row: GroupRow): Tab[] => row.groups.flatMap((g) => g.tabs)

/**
 * Renormalise a set of fractions.
 *
 * Every operation goes through this rather than trusting its own arithmetic, because the rounding
 * error from repeated halving is exactly the kind of thing that leaves a two-pixel gap down the
 * right-hand edge after a dozen splits.
 */
function normalise(sizes: number[]): number[] {
  const floored = sizes.map((s) => Math.max(MIN_SIZE, Number.isFinite(s) ? s : 0))
  const total = floored.reduce((a, b) => a + b, 0)
  return total > 0 ? floored.map((s) => s / total) : floored.map(() => 1 / floored.length)
}

/**
 * Put a new group immediately to the right of `groupId`, holding `tab`.
 *
 * The new group takes half of the source group's width rather than an equal share of the row:
 * splitting the left group should not shuffle the right one, which is what an equal redistribution
 * would do and what makes VS Code's split feel like it moves the wrong things.
 */
export function splitGroup(row: GroupRow, groupId: GroupId, newId: GroupId, tab: Tab): GroupRow {
  const index = row.groups.findIndex((g) => g.id === groupId)
  if (index < 0) return row

  const groups = [...row.groups]
  const sizes = [...row.sizes]
  groups.splice(index + 1, 0, newGroup(newId, [tab]))
  const half = (sizes[index] ?? 1) / 2
  sizes[index] = half
  sizes.splice(index + 1, 0, half)

  return { groups, sizes: normalise(sizes), activeGroupId: newId }
}

/**
 * Remove a group, giving its width back to the others in proportion.
 *
 * The last group is never removed — an empty row has nowhere to put the next file the user opens,
 * so an empty group survives and shows the "Nothing open" state instead.
 */
export function closeGroup(row: GroupRow, groupId: GroupId): GroupRow {
  const index = row.groups.findIndex((g) => g.id === groupId)
  if (index < 0 || row.groups.length === 1) return row

  const groups = row.groups.filter((_, i) => i !== index)
  const sizes = row.sizes.filter((_, i) => i !== index)
  // Selection lands on the neighbour to the right, falling back to the left — the same rule
  // `nextActiveTab` applies within a strip, for the same reason: it is where the eye already is.
  const survivor = groups[Math.min(index, groups.length - 1)]!

  return {
    groups,
    sizes: normalise(sizes),
    activeGroupId: row.activeGroupId === groupId ? survivor.id : row.activeGroupId
  }
}

/**
 * Open a tab in one group, or re-activate an equal one that is already there.
 *
 * De-duplication is PER GROUP and that is the point: the same file open in two groups side by side
 * is the entire feature. `sameTarget` decides what "equal" means; it is the shell's rule, passed in
 * so this module stays free of the store.
 */
export function openInGroup(
  row: GroupRow,
  groupId: GroupId,
  tab: Tab,
  sameTarget: (a: Tab, b: Tab) => boolean
): GroupRow {
  const index = row.groups.findIndex((g) => g.id === groupId)
  if (index < 0) return row

  const group = row.groups[index]!
  const dupe = group.tabs.find((t) => sameTarget(t, tab))
  const next: TabGroup = dupe
    ? { ...group, activeTabId: dupe.id }
    : { ...group, tabs: [...group.tabs, tab], activeTabId: tab.id }

  return { ...row, groups: replaceAt(row.groups, index, next), activeGroupId: groupId }
}

/**
 * Close tabs, wherever they are, and drop any group they empty.
 *
 * Takes ids rather than a group id because the callers that matter — the tab strip's bulk-close
 * commands, and the reaper that closes a tab whose shell exited — think in tabs, not groups.
 */
export function closeTabs(row: GroupRow, tabIds: readonly TabId[]): GroupRow {
  const doomed = new Set(tabIds)
  if (doomed.size === 0) return row

  let next: GroupRow = {
    ...row,
    groups: row.groups.map((group) => {
      const tabs = group.tabs.filter((t) => !doomed.has(t.id))
      if (tabs.length === group.tabs.length) return group
      return { ...group, tabs, activeTabId: nextActiveTab(group.tabs, group.activeTabId, doomed) }
    })
  }

  for (const empty of next.groups.filter((g) => g.tabs.length === 0)) {
    next = closeGroup(next, empty.id)
  }
  return next
}

/**
 * Move a tab into `toGroupId` at `toIndex`, which is what a cross-group drag does.
 *
 * Insert-then-remove order matters only for readability here — the row is rebuilt from scratch —
 * but the guard against dropping a tab onto its own position does not: without it, dragging a tab
 * a few pixels would renumber the strip and make the drag feel like it did something.
 */
export function moveTab(
  row: GroupRow,
  tabId: TabId,
  toGroupId: GroupId,
  toIndex: number
): GroupRow {
  const from = groupOfTab(row, tabId)
  const to = groupById(row, toGroupId)
  if (!from || !to) return row

  const tab = from.tabs.find((t) => t.id === tabId)!
  const fromIndex = from.tabs.indexOf(tab)
  if (from.id === to.id) {
    const clamped = Math.max(0, Math.min(toIndex, from.tabs.length - 1))
    if (clamped === fromIndex) return row
    const tabs = [...from.tabs]
    tabs.splice(fromIndex, 1)
    tabs.splice(clamped, 0, tab)
    const index = row.groups.indexOf(from)
    return { ...row, groups: replaceAt(row.groups, index, { ...from, tabs }) }
  }

  const sourceTabs = from.tabs.filter((t) => t.id !== tabId)
  const targetTabs = [...to.tabs]
  targetTabs.splice(Math.max(0, Math.min(toIndex, targetTabs.length)), 0, tab)

  let next: GroupRow = {
    ...row,
    groups: row.groups.map((g) => {
      if (g.id === from.id) {
        return { ...g, tabs: sourceTabs, activeTabId: nextActiveTab(g.tabs, g.activeTabId, new Set([tabId])) }
      }
      if (g.id === to.id) return { ...g, tabs: targetTabs, activeTabId: tabId }
      return g
    }),
    // The tab you just dragged is the one you are looking at, so its new group takes focus.
    activeGroupId: toGroupId
  }

  if (sourceTabs.length === 0) next = closeGroup(next, from.id)
  return next
}

/** Drag a tab out past the right-hand edge: it gets a group of its own. */
export function moveTabToNewGroup(row: GroupRow, tabId: TabId, newId: GroupId): GroupRow {
  const from = groupOfTab(row, tabId)
  const tab = from?.tabs.find((t) => t.id === tabId)
  if (!from || !tab) return row
  // A lone tab already has a group to itself; moving it would close one group and open an
  // identical one, which looks to the user like the drag did nothing except renumber things.
  if (from.tabs.length === 1) return row

  const split = splitGroup(row, from.id, newId, tab)
  const sourceIndex = split.groups.findIndex((g) => g.id === from.id)
  return {
    ...split,
    groups: replaceAt(split.groups, sourceIndex, stripTab(split.groups[sourceIndex]!, tabId))
  }
}

/** Make a group active without changing anything else. */
export function focusGroup(row: GroupRow, groupId: GroupId): GroupRow {
  return groupById(row, groupId) ? { ...row, activeGroupId: groupId } : row
}

/** Show a tab, and make its group the active one — clicking a tab does both. */
export function activateTab(row: GroupRow, tabId: TabId): GroupRow {
  const group = groupOfTab(row, tabId)
  if (!group) return row
  const index = row.groups.indexOf(group)
  return {
    ...row,
    groups: replaceAt(row.groups, index, { ...group, activeTabId: tabId }),
    activeGroupId: group.id
  }
}

/**
 * Resize the boundary between group `index` and the one after it by a fraction of the row.
 *
 * Only the two groups either side move; everything further out keeps its width, which is what a
 * splitter is expected to do and what stops a drag on the left from shuffling the right-hand edge.
 */
export function setBoundary(row: GroupRow, index: number, leftFraction: number): GroupRow {
  if (index < 0 || index >= row.sizes.length - 1) return row
  const pair = row.sizes[index]! + row.sizes[index + 1]!
  const left = Math.max(MIN_SIZE, Math.min(pair - MIN_SIZE, leftFraction))

  const sizes = [...row.sizes]
  sizes[index] = left
  sizes[index + 1] = pair - left
  return { ...row, sizes: normalise(sizes) }
}

/**
 * The same boundary, moved by a delta instead of set outright.
 *
 * Both forms exist because the two callers genuinely differ: `Splitter` reports the CUMULATIVE
 * pixel offset since pointer-down plus the value it captured then, so it needs the absolute form —
 * feeding its delta to this one would integrate the same movement on every pointermove and the
 * divider would accelerate away from the cursor. A keyboard nudge, if one is ever added, wants
 * this one.
 */
export function resizeAt(row: GroupRow, index: number, delta: number): GroupRow {
  if (index < 0 || index >= row.sizes.length - 1) return row
  const left = row.sizes[index]!
  const right = row.sizes[index + 1]!
  const pair = left + right
  const nextLeft = Math.max(MIN_SIZE, Math.min(pair - MIN_SIZE, left + delta))

  const sizes = [...row.sizes]
  sizes[index] = nextLeft
  sizes[index + 1] = pair - nextLeft
  return { ...row, sizes: normalise(sizes) }
}

/**
 * Whether this tab can exist twice, which is what the split button needs to know.
 *
 * Fails closed. A terminal never can — its ptys are keyed by `<tabId>:<leafId>`, so a copy sharing
 * the source's pane ids would put two xterms on one shell: only one would show output, both would
 * resize it, and closing either would kill it under the other. A plugin tab answers through its
 * manifest, and a view type that has not said it survives cloning is assumed not to, because the
 * failure mode on the other side is a leaked native view or a second pdf.js worker.
 */
export function canDuplicate(tab: Tab, isDuplicable: (viewType: string) => boolean): boolean {
  if (tab.kind === 'terminal') return false
  if (tab.kind === 'custom') return isDuplicable(tab.viewType)
  return true
}

/**
 * A copy of a tab for the group next door.
 *
 * The new id is not a detail: three module-level maps outside the store are keyed by tab id — the
 * pty handles, the browser plugin's native views, and the PDF plugin's reading positions — and a
 * copy that reused the id would alias two live panes in all three.
 *
 * `pinned` is deliberately not inherited: nothing sets it yet, and a copy that arrived pinned
 * would be immune to "Close Other Files" in the group it was just dropped into. The dedup `key` IS
 * inherited, because de-duplication is per group now: two diffs of the same file in two groups both
 * survive, and keeping the key is what lets a second click in the source control panel re-activate
 * the copy rather than pile up a third tab.
 */
export function duplicateTab(tab: Tab, id: TabId, cloneState: (s: Record<string, unknown>) => Record<string, unknown>): Tab | null {
  if (tab.kind === 'terminal') return null
  if (tab.kind === 'editor') return { ...tab, id, pinned: false }
  return { ...tab, id, pinned: false, state: cloneState(tab.state) }
}

function replaceAt<T>(items: T[], index: number, value: T): T[] {
  const next = [...items]
  next[index] = value
  return next
}

function stripTab(group: TabGroup, tabId: TabId): TabGroup {
  if (!group.tabs.some((t) => t.id === tabId)) return group
  const tabs = group.tabs.filter((t) => t.id !== tabId)
  return { ...group, tabs, activeTabId: nextActiveTab(group.tabs, group.activeTabId, new Set([tabId])) }
}
