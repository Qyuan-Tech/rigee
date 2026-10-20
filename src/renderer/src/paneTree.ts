import type { PaneNode } from '@shared/types'

/**
 * Pure operations on a terminal tab's split tree.
 *
 * Splits nest, and a split with one child is meaningless, so removing a pane has to collapse its
 * parent back into the remaining sibling. Getting that wrong leaves invisible wrapper nodes that
 * accumulate and quietly break the size arithmetic, which is why this lives apart from the
 * component and is exercised directly by the tests.
 */

let seq = 0
export const nextNodeId = (): string => `n${++seq}_${Date.now().toString(36)}`

export function newLeaf(): PaneNode {
  return { kind: 'leaf', id: nextNodeId(), paneId: null }
}

export function leaves(node: PaneNode): Array<Extract<PaneNode, { kind: 'leaf' }>> {
  if (node.kind === 'leaf') return [node]
  return node.children.flatMap(leaves)
}

export function findLeaf(
  node: PaneNode,
  id: string
): Extract<PaneNode, { kind: 'leaf' }> | null {
  return leaves(node).find((l) => l.id === id) ?? null
}

/**
 * Split `leafId` in two, keeping the existing pane on the first side.
 *
 * When the leaf's parent already splits the same way, the new leaf joins it as another child
 * rather than nesting a second split inside it — three side-by-side panes should be one row of
 * three, not a row containing a row.
 *
 * `before` puts the new pane on the first side instead: Ghostty's `new_split:left` and `:up`.
 */
export function splitLeaf(
  root: PaneNode,
  leafId: string,
  direction: 'row' | 'column',
  created: PaneNode = newLeaf(),
  before = false
): { root: PaneNode; newLeafId: string } {
  const newLeafId = created.id

  const walk = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') {
      if (node.id !== leafId) return node
      return {
        kind: 'split',
        id: nextNodeId(),
        direction,
        children: before ? [created, node] : [node, created],
        sizes: [0.5, 0.5]
      }
    }

    // Absorb into this split when the direction matches and the target is a direct child.
    const idx = node.children.findIndex((c) => c.kind === 'leaf' && c.id === leafId)
    if (idx >= 0 && node.direction === direction) {
      const at = before ? idx : idx + 1
      const children = [...node.children]
      children.splice(at, 0, created)
      // Halve the split leaf's share and give the other half to the newcomer, leaving every
      // other pane exactly the size it already was.
      const sizes = [...node.sizes]
      const half = (sizes[idx] ?? 1 / node.children.length) / 2
      sizes[idx] = half
      sizes.splice(at, 0, half)
      return { ...node, children, sizes }
    }

    return { ...node, children: node.children.map(walk) }
  }

  return { root: walk(root), newLeafId }
}

/** Remove a leaf, collapsing any split left with a single child. Null when nothing remains. */
export function removeLeaf(root: PaneNode, leafId: string): PaneNode | null {
  if (root.kind === 'leaf') return root.id === leafId ? null : root

  const walk = (node: PaneNode): PaneNode | null => {
    if (node.kind === 'leaf') return node.id === leafId ? null : node

    const kept: PaneNode[] = []
    const sizes: number[] = []
    node.children.forEach((child, i) => {
      const next = walk(child)
      if (next === null) return
      kept.push(next)
      sizes.push(node.sizes[i] ?? 1 / node.children.length)
    })

    if (kept.length === 0) return null
    // A split of one is not a split.
    if (kept.length === 1) return kept[0]!
    return { ...node, children: kept, sizes: normalise(sizes) }
  }

  return walk(root)
}

/** Replace the size fractions of one split node. */
export function setSizes(root: PaneNode, splitId: string, sizes: number[]): PaneNode {
  const walk = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') return node
    if (node.id === splitId) return { ...node, sizes: normalise(sizes) }
    return { ...node, children: node.children.map(walk) }
  }
  return walk(root)
}

/** Set a leaf's pty id without rebuilding the rest of the tree's identities. */
export function bindPane(root: PaneNode, leafId: string, paneId: string): PaneNode {
  const walk = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') return node.id === leafId ? { ...node, paneId } : node
    return { ...node, children: node.children.map(walk) }
  }
  return walk(root)
}

/** The leaf to focus after `leafId` goes away: its next sibling, else the previous one. */
export function neighbourOf(root: PaneNode, leafId: string): string | null {
  const all = leaves(root).map((l) => l.id)
  const i = all.indexOf(leafId)
  if (i < 0) return all[0] ?? null
  return all[i + 1] ?? all[i - 1] ?? null
}

// ---------------------------------------------------------------------------
// Keyboard navigation — Ghostty's goto_split, resize_split and equalize_splits
// ---------------------------------------------------------------------------

/** The leaf `delta` places along in reading order, wrapping at both ends: `goto_split:next`. */
export function cycleLeaf(root: PaneNode, leafId: string, delta: 1 | -1): string | null {
  const all = leaves(root).map((l) => l.id)
  if (all.length < 2) return null
  const i = all.indexOf(leafId)
  if (i < 0) return all[0] ?? null
  return all[(i + delta + all.length) % all.length] ?? null
}

/** A box in the tab's own coordinates, where the whole tab is 0..1 on both axes. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Where every node sits, computed from the tree rather than measured from the DOM.
 *
 * From the tree because a zoomed tab has most of its panes unmounted, and a pane that is not in
 * the document has no rectangle to measure — yet "the pane to the left" still has an answer.
 */
export function nodeRects(root: PaneNode, box: Rect = { x: 0, y: 0, w: 1, h: 1 }): Map<string, Rect> {
  const out = new Map<string, Rect>()
  const walk = (node: PaneNode, r: Rect): void => {
    out.set(node.id, r)
    if (node.kind === 'leaf') return
    const total = node.sizes.reduce((a, b) => a + b, 0) || 1
    let offset = 0
    node.children.forEach((child, i) => {
      const f = (node.sizes[i] ?? 1 / node.children.length) / total
      walk(
        child,
        node.direction === 'row'
          ? { x: r.x + offset * r.w, y: r.y, w: f * r.w, h: r.h }
          : { x: r.x, y: r.y + offset * r.h, w: r.w, h: f * r.h }
      )
      offset += f
    })
  }
  walk(root, box)
  return out
}

export type Direction = 'up' | 'down' | 'left' | 'right'

/**
 * The pane in a direction, chosen the way Ghostty chooses it (SplitTree.swift): of the panes that
 * lie wholly beyond this one's edge on that side, the one whose top-left corner is nearest. No
 * wrapping — at the edge there is nothing, and nothing happens.
 */
export function leafInDirection(root: PaneNode, leafId: string, dir: Direction): string | null {
  const rects = nodeRects(root)
  const from = rects.get(leafId)
  if (!from) return null
  const eps = 1e-6
  let best: { id: string; d: number } | null = null
  for (const leaf of leaves(root)) {
    if (leaf.id === leafId) continue
    const r = rects.get(leaf.id)!
    const beyond =
      dir === 'left' ? r.x + r.w <= from.x + eps
      : dir === 'right' ? r.x >= from.x + from.w - eps
      : dir === 'up' ? r.y + r.h <= from.y + eps
      : r.y >= from.y + from.h - eps
    if (!beyond) continue
    const d = Math.hypot(r.x - from.x, r.y - from.y)
    if (!best || d < best.d) best = { id: leaf.id, d }
  }
  return best?.id ?? null
}

/**
 * Move a divider next to `leafId` by `px` pixels: Ghostty's `resize_split:<dir>,<px>`.
 *
 * The split moved is the nearest one around the leaf that runs the right way — left and right
 * move a vertical divider, up and down a horizontal one — and the divider is the one after the
 * leaf's branch, or the one before it when the branch is last. Like Ghostty, the direction is the
 * way the DIVIDER goes, not whether the focused pane grows.
 *
 * `box` is the tab's size in pixels, which is all that turns pixels into fractions. Null when no
 * split runs that way, so the caller can let the key through.
 */
export function resizeSplit(
  root: PaneNode,
  leafId: string,
  dir: Direction,
  px: number,
  box: { width: number; height: number }
): PaneNode | null {
  const want = dir === 'left' || dir === 'right' ? 'row' : 'column'
  const rects = nodeRects(root)

  // The path from the root down to the leaf; the last split on it running `want` is the one.
  const path: Array<Extract<PaneNode, { kind: 'split' }>> = []
  const find = (node: PaneNode): boolean => {
    if (node.kind === 'leaf') return node.id === leafId
    path.push(node)
    if (node.children.some(find)) return true
    path.pop()
    return false
  }
  if (!find(root)) return null
  const split = [...path].reverse().find((s) => s.direction === want)
  if (!split) return null

  const branch = split.children.findIndex((c) => c.id === leafId || leaves(c).some((l) => l.id === leafId))
  const a = branch < split.children.length - 1 ? branch : branch - 1
  if (a < 0) return null

  const r = rects.get(split.id)!
  const extent = want === 'row' ? r.w * box.width : r.h * box.height
  if (extent <= 0) return null
  const total = split.sizes.reduce((x, y) => x + y, 0) || 1
  const delta = ((dir === 'right' || dir === 'down' ? 1 : -1) * px * total) / extent

  const sizes = [...split.sizes]
  const pair = (sizes[a] ?? 0) + (sizes[a + 1] ?? 0)
  // The same floor as dragging the divider: a pane that can be squeezed to nothing is a pane that
  // can no longer be clicked on to be brought back.
  const next = Math.min(Math.max((sizes[a] ?? 0) + delta, pair * 0.08), pair * 0.92)
  if (Math.abs(next - (sizes[a] ?? 0)) < 1e-9) return root
  sizes[a] = next
  sizes[a + 1] = pair - next
  return setSizes(root, split.id, sizes)
}

/**
 * Every divider back to even, counting panes rather than branches: Ghostty's `equalize_splits`.
 *
 * Three columns where the right one is itself split in two again are three equal columns, not a
 * half and two quarters — a child that splits the same way counts for as many as it holds.
 */
export function equalize(root: PaneNode): PaneNode {
  const weight = (node: PaneNode, direction: 'row' | 'column'): number =>
    node.kind === 'split' && node.direction === direction
      ? node.children.reduce((a, c) => a + weight(c, direction), 0)
      : 1
  const walk = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') return node
    const weights = node.children.map((c) => weight(c, node.direction))
    return { ...node, children: node.children.map(walk), sizes: normalise(weights) }
  }
  return walk(root)
}

// ---------------------------------------------------------------------------
// A pane added to the tab rather than beside one — Open in Terminal Split
// ---------------------------------------------------------------------------

/**
 * Which pane to split, and which way, when nobody pointed at one: "Open in Terminal Split" on a
 * folder in the explorer.
 *
 * The biggest pane — of several the same size, the first reading across and then down — split
 * across the split it sits in. So the panes fill out a grid: two side by side, then the left one
 * over a new one, then the right one, then each of those four in half the other way. Splitting the
 * newest pane the same way every time makes a row of panes, each half as wide as the one before.
 *
 * A lone pane has no split to go across, and goes side by side whatever shape the tab is. Going the
 * long way instead would leave the first split to a few pixels: with both side panels open in a
 * window of the default size, the tab between them is nearly square.
 */
export function roomForPane(root: PaneNode): { leafId: string; direction: 'row' | 'column' } {
  const rects = nodeRects(root)
  const eps = 1e-6
  let best: { id: string; area: number; r: Rect } | null = null
  for (const leaf of leaves(root)) {
    const r = rects.get(leaf.id)!
    const area = r.w * r.h
    const bigger = !best || area > best.area + eps
    const tied = !!best && Math.abs(area - best.area) <= eps
    const earlier = !!best && (r.y < best.r.y - eps || (Math.abs(r.y - best.r.y) <= eps && r.x < best.r.x - eps))
    if (bigger || (tied && earlier)) best = { id: leaf.id, area, r }
  }
  const leafId = best!.id
  const parent = parentOf(root, leafId)
  return { leafId, direction: parent?.direction === 'row' ? 'column' : 'row' }
}

/** The split `id` sits directly in; null for the root. */
function parentOf(node: PaneNode, id: string): Extract<PaneNode, { kind: 'split' }> | null {
  if (node.kind === 'leaf') return null
  for (const child of node.children) {
    if (child.id === id) return node
    const found = parentOf(child, id)
    if (found) return found
  }
  return null
}

function normalise(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0)
  if (total <= 0) return sizes.map(() => 1 / sizes.length)
  return sizes.map((s) => s / total)
}
