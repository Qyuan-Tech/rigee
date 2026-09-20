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
 */
export function splitLeaf(
  root: PaneNode,
  leafId: string,
  direction: 'row' | 'column',
  created: PaneNode = newLeaf()
): { root: PaneNode; newLeafId: string } {
  const newLeafId = created.id

  const walk = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') {
      if (node.id !== leafId) return node
      return {
        kind: 'split',
        id: nextNodeId(),
        direction,
        children: [node, created],
        sizes: [0.5, 0.5]
      }
    }

    // Absorb into this split when the direction matches and the target is a direct child.
    const idx = node.children.findIndex((c) => c.kind === 'leaf' && c.id === leafId)
    if (idx >= 0 && node.direction === direction) {
      const children = [...node.children]
      children.splice(idx + 1, 0, created)
      // Halve the split leaf's share and give the other half to the newcomer, leaving every
      // other pane exactly the size it already was.
      const sizes = [...node.sizes]
      const half = (sizes[idx] ?? 1 / node.children.length) / 2
      sizes[idx] = half
      sizes.splice(idx + 1, 0, half)
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

function normalise(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0)
  if (total <= 0) return sizes.map(() => 1 / sizes.length)
  return sizes.map((s) => s / total)
}
