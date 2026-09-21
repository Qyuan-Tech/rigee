/**
 * Unit tests for the pure logic on both sides of the process boundary: the terminal split tree,
 * key chords, the tab strip and .code-workspace parsing.
 *
 *   pnpm panes:selftest
 *
 * Pure functions, no Electron and no filesystem. Worth testing on their own because the failure
 * modes are invisible: a split that nests instead of absorbing, or a removal that leaves a
 * one-child split behind, both still render — they just accumulate wrapper nodes and make the
 * size arithmetic drift. A bulk tab close that sweeps up a terminal is worse than invisible, it
 * takes a running process with it.
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
import {
  chordBytes,
  clipboardAction,
  formatChord,
  matchesChord,
  parseChord,
  resolvePrefixKey
} from '../src/renderer/src/keys.ts'
import { isFileTab, nextActiveTab, tabsToClose } from '../src/renderer/src/tabs.ts'
import { parseWorkspaceFile, serializeWorkspaceFile } from '../src/main/workspaceFile.ts'
import type { PaneNode, Tab } from '../src/shared/types.ts'

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

console.log('\nkey chords')
{
  const ctrlA = parseChord('ctrl+a')
  check('ctrl+a parses', ctrlA !== null && ctrlA.ctrl && ctrlA.key === 'a', JSON.stringify(ctrlA))
  eq('ctrl+a sends 0x01', chordBytes(ctrlA!), String.fromCharCode(1))
  eq('ctrl+b sends 0x02', chordBytes(parseChord('ctrl+b')!), String.fromCharCode(2))

  const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
    ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: '', ...init }) as KeyboardEvent

  check('ctrl+a matches', matchesChord(ev({ ctrlKey: true, key: 'a' }), ctrlA!))
  check('plain a does not match', !matchesChord(ev({ key: 'a' }), ctrlA!))
  check('cmd+a does not match ctrl+a', !matchesChord(ev({ metaKey: true, key: 'a' }), ctrlA!))
  check('ctrl+shift+a still matches ctrl+a',
    matchesChord(ev({ ctrlKey: true, shiftKey: true, key: 'A' }), ctrlA!))

  const cmdShiftP = parseChord('cmd+shift+p')
  check('multi-modifier chord parses',
    cmdShiftP !== null && cmdShiftP.meta && cmdShiftP.shift && cmdShiftP.key === 'p')
  check('it requires every modifier',
    !matchesChord(ev({ metaKey: true, key: 'p' }), cmdShiftP!))

  eq('garbage does not parse', parseChord('++'), null)
  eq('a chord renders for menus', formatChord('ctrl+a', true), '⌃A')
  eq('and spells out on other platforms', formatChord('ctrl+a', false), 'Ctrl+A')
}

console.log('\nprefix state machine')
{
  const B = { prefix: 'ctrl+a', splitRight: '|', splitDown: '-', closePane: 'x' }
  const k = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key, ...mods }) as KeyboardEvent

  eq('an ordinary key passes through',
    resolvePrefixKey(k('a'), B, false).kind, 'passthrough')
  eq('the prefix arms', resolvePrefixKey(k('a', { ctrlKey: true }), B, false).kind, 'arm')

  // The reported bug: `|` needs Shift, and Shift arrives as its own keydown first. Treating it
  // as "the key after the prefix" disarmed the machine and made every shifted binding dead.
  eq('Shift while armed holds, it does not consume the prefix',
    resolvePrefixKey(k('Shift', { shiftKey: true }), B, true).kind, 'hold')
  const shifted = resolvePrefixKey(k('|', { shiftKey: true }), B, true)
  eq('then the shifted key runs its command',
    shifted.kind === 'command' ? shifted.command : shifted.kind, 'splitRight')

  // Every modifier, since any of them could be in the way of a binding.
  for (const m of ['Control', 'Alt', 'Meta', 'CapsLock']) {
    eq(`${m} while armed holds`, resolvePrefixKey(k(m), B, true).kind, 'hold')
  }

  const down = resolvePrefixKey(k('-'), B, true)
  eq('unshifted punctuation still works',
    down.kind === 'command' ? down.command : down.kind, 'splitDown')

  const close = resolvePrefixKey(k('x'), B, true)
  eq('a letter binding works', close.kind === 'command' ? close.command : close.kind, 'closePane')
  const closeShifted = resolvePrefixKey(k('X', { shiftKey: true }), B, true)
  eq('and still works with Shift held',
    closeShifted.kind === 'command' ? closeShifted.command : closeShifted.kind, 'closePane')

  const literal = resolvePrefixKey(k('a', { ctrlKey: true }), B, true)
  eq('the prefix twice sends a literal', literal.kind, 'literal')
  eq('and it is the right byte',
    literal.kind === 'literal' ? literal.bytes : '', String.fromCharCode(1))

  eq('an unbound key after the prefix is swallowed',
    resolvePrefixKey(k('q'), B, true).kind, 'swallow')

  // Punctuation must stay exact: `|` and `\\` live on the same physical key.
  eq('backslash does not trigger the pipe binding',
    resolvePrefixKey(k('\\'), B, true).kind, 'swallow')

  eq('a broken prefix setting disables the machine rather than trapping keys',
    resolvePrefixKey(k('a'), { ...B, prefix: '' }, true).kind, 'passthrough')
}

console.log('\n.code-workspace files')
{
  const file = '/projects/group/jira-migrate.code-workspace'

  const basic = parseWorkspaceFile(
    JSON.stringify({ folders: [{ path: 'repo-a' }, { path: '/elsewhere/repo-b', name: 'B' }] }),
    file
  )
  eq('the workspace is named after the file', basic.name, 'jira-migrate')
  eq('relative paths resolve against the file', basic.folders[0]?.path, '/projects/group/repo-a')
  eq('absolute paths are left alone', basic.folders[1]?.path, '/elsewhere/repo-b')
  eq('an explicit name is kept', basic.folders[1]?.name, 'B')
  eq('no name means no name', basic.folders[0]?.name, undefined)

  eq('.. resolves rather than being pasted together',
    parseWorkspaceFile('{"folders":[{"path":"../sibling"}]}', file).folders[0]?.path,
    '/projects/sibling')

  eq('duplicate folders collapse',
    parseWorkspaceFile('{"folders":[{"path":"a"},{"path":"a"},{"path":"./a"}]}', file).folders.length, 1)
  eq('entries without a usable path are skipped',
    parseWorkspaceFile('{"folders":[{"name":"x"},{"path":""},{"path":"ok"}]}', file).folders.length, 1)

  // VS Code writes plain JSON but reads JSONC, and these files get hand-edited.
  const commented = parseWorkspaceFile(`{
    // the api, checked out from gerrit
    "folders": [
      { "path": "api" }, /* inline */
      { "path": "web" },
    ],
    "settings": {}
  }`, file)
  eq('comments and a trailing comma are tolerated', commented.folders.length, 2)

  // The hard case for any comment stripper: these are not comments.
  const slashes = parseWorkspaceFile(
    '{"folders":[{"path":"/srv//double","name":"a // b"}]}', file)
  eq('a // inside a string is not a comment', slashes.folders[0]?.name, 'a // b')
  eq('and neither is one in a path', slashes.folders[0]?.path, '/srv/double')
  eq('an escaped quote does not end the string',
    parseWorkspaceFile('{"folders":[{"path":"p","name":"say \\"hi\\" // x"}]}', file).folders[0]?.name,
    'say "hi" // x')

  let threw = ''
  try { parseWorkspaceFile('{ not json', file) } catch (e) { threw = (e as Error).message }
  check('bad JSON throws with the file named', threw.includes('jira-migrate.code-workspace'), threw)
  threw = ''
  try { parseWorkspaceFile('{"settings":{}}', file) } catch (e) { threw = (e as Error).message }
  check('a file with no folders array is rejected', threw.includes('folders'), threw)

  // Round trip: folders under the file's directory are written relative, so the file stays
  // portable when it is committed beside the repos it groups.
  const written = serializeWorkspaceFile(
    [{ path: '/projects/group/api' }, { path: '/elsewhere/web', name: 'Web' }], file)
  check('nearby folders are written relative', written.includes('"path": "api"'), written)
  check('distant folders stay absolute', written.includes('"path": "/elsewhere/web"'), written)
  check('a custom name survives', written.includes('"name": "Web"'), written)
  eq('what is written parses back to the same paths',
    parseWorkspaceFile(written, file).folders.map((f) => f.path).join(','),
    '/projects/group/api,/elsewhere/web')
}

console.log('\nterminal clipboard')
{
  const k = (key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key, ...mods }) as KeyboardEvent

  eq('mac: cmd+c copies', clipboardAction(k('c', { metaKey: true }), true), 'copy')
  eq('mac: cmd+v pastes', clipboardAction(k('v', { metaKey: true }), true), 'paste')

  // The whole reason these bindings are not the usual ones. Stealing either would break the
  // shell: one would stop interrupting, the other would stop quoting.
  eq('ctrl+c stays SIGINT on mac', clipboardAction(k('c', { ctrlKey: true }), true), null)
  eq('ctrl+c stays SIGINT elsewhere', clipboardAction(k('c', { ctrlKey: true }), false), null)
  eq('ctrl+v stays literal-quote elsewhere', clipboardAction(k('v', { ctrlKey: true }), false), null)

  eq('linux/win: ctrl+shift+c copies',
    clipboardAction(k('C', { ctrlKey: true, shiftKey: true }), false), 'copy')
  eq('linux/win: ctrl+shift+v pastes',
    clipboardAction(k('V', { ctrlKey: true, shiftKey: true }), false), 'paste')

  eq('cmd+c does nothing off mac', clipboardAction(k('c', { metaKey: true }), false), null)
  eq('a bare c is just a c', clipboardAction(k('c'), true), null)
  eq('other keys are not clipboard keys', clipboardAction(k('x', { metaKey: true }), true), null)
  eq('extra modifiers disqualify', clipboardAction(k('c', { metaKey: true, altKey: true }), true), null)
}

console.log('\ntab strip')
{
  const editor = (id: string, pinned = false): Tab =>
    ({ id, kind: 'editor', title: id, pinned, filePath: `/${id}.ts`, repoId: null, readOnly: false })
  const diff = (id: string): Tab =>
    ({ id, kind: 'diff', title: id, pinned: false, filePath: `/${id}.ts`, repoId: 'r',
       against: { kind: 'worktree-vs-index' } })
  const terminal = (id: string): Tab =>
    ({ id, kind: 'terminal', title: id, pinned: false,
       root: { kind: 'leaf', id: `${id}-leaf`, paneId: null }, activeLeafId: `${id}-leaf` })
  const browser = (id: string): Tab =>
    ({ id, kind: 'browser', title: id, pinned: false, url: 'https://example.com', viewId: '',
       canGoBack: false, canGoForward: false, loading: false, faviconDataUrl: null })

  check('an editor is a file tab', isFileTab(editor('a')))
  check('a diff is a file tab', isFileTab(diff('d')))
  check('a terminal is not', !isFileTab(terminal('t')))
  check('a browser is not', !isFileTab(browser('b')))

  // The whole point of the feature: terminals and browsers share the strip and must come through
  // every bulk close untouched. A swept-up terminal takes a running process with it.
  const mixed = [terminal('t1'), editor('e1'), browser('b1'), editor('e2'), diff('d1'), terminal('t2')]

  eq('close others spares terminals and browsers',
    tabsToClose(mixed, 'e1', 'others').join(','), 'e2,d1')
  eq('close to the right spares them too',
    tabsToClose(mixed, 'e1', 'right').join(','), 'e2,d1')
  eq('close all means all FILES',
    tabsToClose(mixed, 'e1', 'all').join(','), 'e1,e2,d1')

  eq('close to the right of the last file tab is empty',
    tabsToClose(mixed, 'd1', 'right').length, 0)
  eq('close others excludes the target',
    tabsToClose(mixed, 'e2', 'others').join(','), 'e1,d1')

  // A terminal between two editors is skipped, not treated as the right-hand boundary.
  eq('a terminal in the middle does not stop the sweep',
    tabsToClose([editor('a'), terminal('t'), editor('b')], 'a', 'right').join(','), 'b')

  eq('an unknown tab closes nothing', tabsToClose(mixed, 'nope', 'all').length, 0)

  // Pinned: TabBase says pinned tabs survive "close others", so they must also survive the
  // narrower sweep, but not an explicit close-all. Matches VSCode.
  const withPinned = [editor('p', true), editor('x'), editor('y')]
  eq('a pinned tab survives close others',
    tabsToClose(withPinned, 'x', 'others').join(','), 'y')
  eq('and survives close to the right',
    tabsToClose([editor('a'), editor('p', true), editor('z')], 'a', 'right').join(','), 'z')
  eq('but close all takes it',
    tabsToClose(withPinned, 'x', 'all').join(','), 'p,x,y')

  // Selection after a bulk close. Computed once, so it cannot walk through doomed tabs.
  const ids = (...xs: string[]): Set<string> => new Set(xs)
  eq('an untouched selection stays put',
    nextActiveTab(mixed, 't1', ids('e1', 'e2')), 't1')
  eq('closing the selected tab moves right',
    nextActiveTab(mixed, 'e1', ids('e1')), 'b1')
  eq('it skips tabs that are also closing',
    nextActiveTab(mixed, 'e1', ids('e1', 'b1', 'e2')), 'd1')
  eq('with nothing to the right it falls back to the left',
    nextActiveTab(mixed, 't2', ids('t2', 'd1')), 'e2')
  eq('closing everything leaves no selection',
    nextActiveTab(mixed, 'e1', ids(...mixed.map((t) => t.id))), null)
  eq('no selection stays no selection', nextActiveTab(mixed, null, ids('e1')), null)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
