/**
 * Unit tests for the terminal split tree.
 *
 *   pnpm panes:selftest
 *
 * Pure functions, no Electron and no filesystem. Worth testing on their own because the failure
 * modes are invisible: a split that nests instead of absorbing, or a removal that leaves a
 * one-child split behind, both still render — they just accumulate wrapper nodes and make the
 * size arithmetic drift.
 */

import {
  bindPane,
  findLeaf,
  leaves,
  neighbourOf,
  newLeaf,
  removeLeaf,
  setSizes,
  splitLeaf
} from '../src/renderer/src/paneTree.ts'
import type { PaneNode } from '../src/shared/types.ts'

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (ok) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
function eq<T>(label: string, actual: T, expected: T): void {
  check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

/** Compact shape, for asserting structure without caring about generated ids. */
function shape(node: PaneNode): string {
  if (node.kind === 'leaf') return 'L'
  return `${node.direction === 'row' ? 'R' : 'C'}(${node.children.map(shape).join(' ')})`
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

console.log('\npane tree')

// One pane.
{
  const root = newLeaf()
  eq('a new tab is a single leaf', shape(root), 'L')
  eq('one leaf', leaves(root).length, 1)
  eq('removing the only leaf empties the tab', removeLeaf(root, root.id), null)
}

// Splitting.
{
  const a = newLeaf()
  const { root, newLeafId } = splitLeaf(a, a.id, 'row')
  eq('splitting a leaf makes a row of two', shape(root), 'R(L L)')
  eq('two leaves', leaves(root).length, 2)
  check('the new leaf is reported', findLeaf(root, newLeafId) !== null)
  check('sizes start even', root.kind === 'split' && root.sizes.every((s) => s === 0.5))

  // Same direction again: three across, not a row inside a row.
  const again = splitLeaf(root, newLeafId, 'row')
  eq('same-direction split absorbs into the parent', shape(again.root), 'R(L L L)')
  check('sizes still sum to 1',
    again.root.kind === 'split' && Math.abs(sum(again.root.sizes) - 1) < 1e-9,
    again.root.kind === 'split' ? JSON.stringify(again.root.sizes) : '')

  // The untouched pane keeps its share; only the split one gives up half.
  const sizes = again.root.kind === 'split' ? again.root.sizes : []
  eq('the untouched sibling keeps its size', sizes[0], 0.5)
  eq('the split pane halves', sizes[1], 0.25)
  eq('the newcomer takes the other half', sizes[2], 0.25)

  // Cross direction nests, which is the whole point of a tree.
  const nested = splitLeaf(root, newLeafId, 'column')
  eq('cross-direction split nests', shape(nested.root), 'R(L C(L L))')
}

// Removal and collapsing.
{
  const a = newLeaf()
  const two = splitLeaf(a, a.id, 'row')
  const three = splitLeaf(two.root, two.newLeafId, 'column')
  eq('starting shape', shape(three.root), 'R(L C(L L))')

  const afterOne = removeLeaf(three.root, three.newLeafId)
  check('removing a nested leaf collapses the one-child split',
    afterOne !== null && shape(afterOne) === 'R(L L)', afterOne ? shape(afterOne) : 'null')

  const afterTwo = afterOne ? removeLeaf(afterOne, a.id) : null
  eq('removing down to one leaf collapses the row too', afterTwo ? shape(afterTwo) : 'null', 'L')

  const empty = afterTwo ? removeLeaf(afterTwo, leaves(afterTwo)[0]!.id) : 'x'
  eq('removing the last leaf yields nothing', empty, null)
}

// Removing from a three-way split renormalises rather than leaving a gap.
{
  const a = newLeaf()
  const two = splitLeaf(a, a.id, 'row')
  const three = splitLeaf(two.root, two.newLeafId, 'row')
  const removed = removeLeaf(three.root, two.newLeafId)
  check('three-way removal keeps a row of two',
    removed !== null && shape(removed) === 'R(L L)', removed ? shape(removed) : 'null')
  check('sizes renormalise to 1',
    removed !== null && removed.kind === 'split' && Math.abs(sum(removed.sizes) - 1) < 1e-9,
    removed && removed.kind === 'split' ? JSON.stringify(removed.sizes) : '')
}

// Focus target after a close.
{
  const a = newLeaf()
  const two = splitLeaf(a, a.id, 'row')
  eq('closing the first focuses the next', neighbourOf(two.root, a.id), two.newLeafId)
  eq('closing the last focuses the previous', neighbourOf(two.root, two.newLeafId), a.id)
}

// Binding and sizing leave the rest of the tree alone.
{
  const a = newLeaf()
  const two = splitLeaf(a, a.id, 'row')
  const bound = bindPane(two.root, a.id, 'pane7')
  eq('bindPane sets only the target', findLeaf(bound, a.id)?.paneId, 'pane7')
  eq('bindPane leaves the sibling unbound', findLeaf(bound, two.newLeafId)?.paneId, null)

  const splitId = bound.kind === 'split' ? bound.id : ''
  const resized = setSizes(bound, splitId, [3, 1])
  check('setSizes normalises',
    resized.kind === 'split' && Math.abs(resized.sizes[0]! - 0.75) < 1e-9,
    resized.kind === 'split' ? JSON.stringify(resized.sizes) : '')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
