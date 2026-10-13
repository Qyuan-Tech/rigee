/**
 * Pure arithmetic for the centre pane's editor groups.
 *
 * Extracted for the same reason `paneTree.ts` and `tabs.ts` were: every failure mode in here is a
 * quiet one. A split that forgets to renormalise leaves a row that does not fill the window; a
 * close that picks the wrong survivor moves the user to a group they were not looking at; a
 * cross-group drag that removes before it inserts loses the tab — and a lost terminal tab takes a
 * running process with it. None of that throws, and all of it is tedious to reproduce by hand once
 * three groups and a drag are in play.
 *
 * Two halves, kept apart on purpose. `groups` is a flat list — the tabs, and which one each group
 * shows — and `layout` is a tree like a terminal tab's split tree that only says where each group
 * is drawn: side by side, stacked, or any nesting of the two. Everything that wants the tabs, which
 * is most of the shell, reads the list and never walks the tree; only splitting, closing a group
 * and dragging a divider touch the layout.
 *
 * INVARIANT, maintained by every function that returns a row: the layout's groups are exactly
 * `groups`, in the same order — reading order, which is what goto_group counts in. Every split has
 * two children or more, none of them a split running the same way as itself, and one positive size
 * per child summing to 1. `activeGroupId` names a group that exists, and there is always at least
 * one group — an empty one shows the shell's "Nothing open" state, which is where a file goes when
 * you click it.
 */

import { nextNodeId } from './paneTree'
import { nextActiveTab } from './tabs'
import type { GroupLayout, Tab, TabId } from '@shared/types'

export type GroupId = string

export interface TabGroup {
  id: GroupId
  tabs: Tab[]
  /** Which tab this group shows. Null only while the group is empty. */
  activeTabId: TabId | null
}

/**
 * The centre pane of one workspace. Still called a row — as are `rowsByWorkspace` and `rowOf` —
 * after what it was before groups could be stacked.
 */
export interface GroupRow {
  /** Every group, in reading order: left to right, and top to bottom where they are stacked. */
  groups: TabGroup[]
  /** Where each group is drawn. Its groups are exactly `groups`, in the same order. */
  layout: GroupLayout
  activeGroupId: GroupId
}

/** Where a split puts the new group: VS Code's Split Right and Split Down. */
export type SplitDirection = 'right' | 'down'

/** The smallest fraction a group may be squeezed to, so a group can never become unclickable. */
const MIN_SIZE = 0.08

export function newGroup(id: GroupId, tabs: Tab[] = []): TabGroup {
  return { id, tabs, activeTabId: tabs[tabs.length - 1]?.id ?? null }
}

export function singleGroupRow(id: GroupId, tabs: Tab[] = []): GroupRow {
  return { groups: [newGroup(id, tabs)], layout: { kind: 'group', id }, activeGroupId: id }
}

export const groupById = (row: GroupRow, id: GroupId): TabGroup | undefined =>
  row.groups.find((g) => g.id === id)

export const activeGroup = (row: GroupRow): TabGroup =>
  groupById(row, row.activeGroupId) ?? row.groups[0]!

/** Which group holds a tab, if any. Needed because a tab id is unique across the whole row. */
export const groupOfTab = (row: GroupRow, tabId: TabId): TabGroup | undefined =>
  row.groups.find((g) => g.tabs.some((t) => t.id === tabId))

export const allTabs = (row: GroupRow): Tab[] => row.groups.flatMap((g) => g.tabs)

/** The groups in the order the layout visits them, which is reading order. */
export function layoutOrder(layout: GroupLayout): GroupId[] {
  return layout.kind === 'group' ? [layout.id] : layout.children.flatMap(layoutOrder)
}

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
 * Put a new group holding `tab` immediately to the right of `groupId`, or below it.
 *
 * The new group takes half of the source group's share rather than an equal share of its row:
 * splitting the left group should not shuffle the right one, which is what an equal redistribution
 * would do and what makes VS Code's split feel like it moves the wrong things.
 */
export function splitGroup(
  row: GroupRow,
  groupId: GroupId,
  newId: GroupId,
  tab: Tab,
  direction: SplitDirection = 'right'
): GroupRow {
  if (!groupById(row, groupId)) return row
  const layout = splitLayout(row.layout, groupId, newId, direction === 'right' ? 'row' : 'column')
  return { groups: inLayoutOrder([...row.groups, newGroup(newId, [tab])], layout), layout, activeGroupId: newId }
}

/**
 * The layout with `newId` put after `groupId`, taking half of its share.
 *
 * Joins the split the group is already in when that runs the same way, rather than nesting one
 * inside it: three groups across are one row of three, not a row inside a row, and only then does
 * every divider sit between the two groups it looks as if it sits between.
 */
function splitLayout(node: GroupLayout, groupId: GroupId, newId: GroupId, direction: 'row' | 'column'): GroupLayout {
  const created: GroupLayout = { kind: 'group', id: newId }
  if (node.kind === 'group') {
    if (node.id !== groupId) return node
    return { kind: 'split', id: nextNodeId(), direction, children: [node, created], sizes: [0.5, 0.5] }
  }

  const index = node.children.findIndex((c) => c.kind === 'group' && c.id === groupId)
  if (index >= 0 && node.direction === direction) {
    const children = [...node.children]
    const sizes = [...node.sizes]
    children.splice(index + 1, 0, created)
    const half = (sizes[index] ?? 1) / 2
    sizes[index] = half
    sizes.splice(index + 1, 0, half)
    return { ...node, children, sizes: normalise(sizes) }
  }
  return { ...node, children: node.children.map((c) => splitLayout(c, groupId, newId, direction)) }
}

/**
 * Remove a group, giving its space back to the groups beside it, in proportion.
 *
 * The last group is never removed — an empty row has nowhere to put the next file the user opens,
 * so an empty group survives and shows the "Nothing open" state instead.
 */
export function closeGroup(row: GroupRow, groupId: GroupId): GroupRow {
  if (!groupById(row, groupId) || row.groups.length === 1) return row

  const layout = pruneLayout(row.layout, (id) => id !== groupId)!
  // Selection lands on the neighbour after it, to the right or below, falling back to the one
  // before — the same rule `nextActiveTab` applies within a strip, for the same reason: it is where
  // the eye already is.
  const survivor = neighbourOf(row.layout, groupId) ?? layoutOrder(layout)[0]!

  return {
    groups: row.groups.filter((g) => g.id !== groupId),
    layout,
    activeGroupId: row.activeGroupId === groupId ? survivor : row.activeGroupId
  }
}

/**
 * The layout with only the groups `keep` accepts, or null when that is none of them.
 *
 * A split left with one child is replaced by it, and a split left inside one running the same way
 * is merged into it, its children sharing out its slot: closing the lower of two stacked groups
 * beside a third must leave one row of two, not a row with another row in it.
 */
function pruneLayout(node: GroupLayout, keep: (id: GroupId) => boolean): GroupLayout | null {
  if (node.kind === 'group') return keep(node.id) ? node : null

  const children: GroupLayout[] = []
  const sizes: number[] = []
  node.children.forEach((child, i) => {
    const kept = pruneLayout(child, keep)
    if (!kept) return
    const share = node.sizes[i] ?? 1 / node.children.length
    if (kept.kind === 'split' && kept.direction === node.direction) {
      kept.children.forEach((c, j) => {
        children.push(c)
        sizes.push(share * (kept.sizes[j] ?? 1 / kept.children.length))
      })
    } else {
      children.push(kept)
      sizes.push(share)
    }
  })

  if (children.length === 0) return null
  // A split of one is not a split.
  if (children.length === 1) return children[0]!
  return { ...node, children, sizes: normalise(sizes) }
}

/** The group after `groupId` in its split — the first of it, if that is a split — else the last before. */
function neighbourOf(node: GroupLayout, groupId: GroupId): GroupId | null {
  if (node.kind === 'group') return null
  const index = node.children.findIndex((c) => c.kind === 'group' && c.id === groupId)
  if (index < 0) {
    for (const child of node.children) {
      const found = neighbourOf(child, groupId)
      if (found) return found
    }
    return null
  }
  const after = node.children[index + 1]
  if (after) return layoutOrder(after)[0] ?? null
  const before = node.children[index - 1]
  const order = before ? layoutOrder(before) : []
  return order[order.length - 1] ?? null
}

/** `groups` in the order `layout` visits them, which is the order a row keeps them in. */
function inLayoutOrder(groups: TabGroup[], layout: GroupLayout): TabGroup[] {
  const byId = new Map(groups.map((g) => [g.id, g]))
  return layoutOrder(layout).flatMap((id) => byId.get(id) ?? [])
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

/** Move a tab out into a group of its own, to the right of the one it is in or below it. */
export function moveTabToNewGroup(
  row: GroupRow,
  tabId: TabId,
  newId: GroupId,
  direction: SplitDirection = 'right'
): GroupRow {
  const from = groupOfTab(row, tabId)
  const tab = from?.tabs.find((t) => t.id === tabId)
  if (!from || !tab) return row
  // A lone tab already has a group to itself; moving it would close one group and open an
  // identical one, which looks to the user like the drag did nothing except renumber things.
  if (from.tabs.length === 1) return row

  const split = splitGroup(row, from.id, newId, tab, direction)
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
 * Resize the boundary between child `index` of split `splitId` and the one after it, as a fraction
 * of that split.
 *
 * Only the two either side move; everything further out keeps its size, which is what a splitter
 * is expected to do and what stops a drag on the left from shuffling the right-hand edge.
 */
export function setBoundary(row: GroupRow, splitId: string, index: number, fraction: number): GroupRow {
  return moveBoundary(row, splitId, index, () => fraction)
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
export function resizeAt(row: GroupRow, splitId: string, index: number, delta: number): GroupRow {
  return moveBoundary(row, splitId, index, (before) => before + delta)
}

/** One boundary moved to wherever `place` puts it, given where it is; the same row when it is not there. */
function moveBoundary(row: GroupRow, splitId: string, index: number, place: (before: number) => number): GroupRow {
  const walk = (node: GroupLayout): GroupLayout => {
    if (node.kind === 'group') return node
    if (node.id !== splitId) {
      const children = node.children.map(walk)
      return children.every((c, i) => c === node.children[i]) ? node : { ...node, children }
    }
    if (index < 0 || index >= node.sizes.length - 1) return node
    const pair = node.sizes[index]! + node.sizes[index + 1]!
    const before = Math.max(MIN_SIZE, Math.min(pair - MIN_SIZE, place(node.sizes[index]!)))

    const sizes = [...node.sizes]
    sizes[index] = before
    sizes[index + 1] = pair - before
    return { ...node, sizes: normalise(sizes) }
  }
  const layout = walk(row.layout)
  return layout === row.layout ? row : { ...row, layout }
}

/**
 * Each group's share of the width, in reading order: what `groupSizes` holds on disk.
 *
 * For a build from before groups could be stacked, which reads a row and nothing else. A row comes
 * back exactly; stacked groups come back side by side, in proportion to how wide each one was.
 */
export function widthShares(row: GroupRow): number[] {
  const widths = new Map<GroupId, number>()
  const walk = (node: GroupLayout, width: number): void => {
    if (node.kind === 'group') {
      widths.set(node.id, width)
      return
    }
    node.children.forEach((child, i) => walk(child, node.direction === 'row' ? width * (node.sizes[i] ?? 0) : width))
  }
  walk(row.layout, 1)
  return normalise(row.groups.map((g) => widths.get(g.id) ?? 0))
}

/**
 * A layout read back from disk, made to fit the groups that survived the read.
 *
 * Trusted only as far as it can be checked. A group that is gone — dropped for having no tabs —
 * comes out of it as if it had been closed, and a group named twice keeps its first place. A layout
 * that cannot be read, or that leaves a group out, gives way to a row of every group sized by
 * `sizes`, which is also what every document written before groups could be stacked describes.
 */
export function restoreLayout(raw: unknown, ids: readonly GroupId[], sizes: unknown): GroupLayout {
  const known = new Set(ids)
  const placed = new Set<GroupId>()
  const parsed = parseLayout(raw)
  const pruned =
    parsed &&
    pruneLayout(parsed, (id) => {
      if (!known.has(id) || placed.has(id)) return false
      placed.add(id)
      return true
    })
  if (pruned && placed.size === known.size) return pruned

  if (ids.length === 1) return { kind: 'group', id: ids[0]! }
  const fractions = Array.isArray(sizes) && sizes.length === ids.length ? sizes.map(Number) : ids.map(() => 1)
  return {
    kind: 'split',
    id: nextNodeId(),
    direction: 'row',
    children: ids.map((id) => ({ kind: 'group', id })),
    sizes: normalise(fractions)
  }
}

/**
 * A layout as written to disk, or null if any part of it is not one.
 *
 * Split ids are minted afresh. They only ever have to be unique among the splits on screen, and two
 * from a hand-edited document might not be.
 */
function parseLayout(raw: unknown): GroupLayout | null {
  if (!raw || typeof raw !== 'object') return null
  const node = raw as Record<string, unknown>
  if (node.kind === 'group') return typeof node.id === 'string' ? { kind: 'group', id: node.id } : null
  if (node.kind !== 'split' || (node.direction !== 'row' && node.direction !== 'column')) return null
  if (!Array.isArray(node.children) || node.children.length === 0) return null

  const children = node.children.map(parseLayout)
  if (children.some((c) => c === null)) return null
  const sizes = Array.isArray(node.sizes) && node.sizes.length === children.length ? node.sizes.map(Number) : children.map(() => 1)
  return { kind: 'split', id: nextNodeId(), direction: node.direction, children: children as GroupLayout[], sizes }
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
