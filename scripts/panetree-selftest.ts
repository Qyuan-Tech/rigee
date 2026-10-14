/**
 * Unit tests for the pure logic on both sides of the process boundary: the terminal split tree,
 * key chords, the tab strip, .code-workspace parsing, workspace heat, and whether a terminal is at
 * work.
 *
 *   pnpm panes:selftest
 *
 * Pure functions, no Electron and no filesystem. Worth testing on their own because the failure
 * modes are invisible: a split that nests instead of absorbing, or a removal that leaves a
 * one-child split behind, both still render — they just accumulate wrapper nodes and make the
 * size arithmetic drift. A bulk tab close that sweeps up the wrong tabs is worse than invisible:
 * it takes a running process or a page with it. And a workspace name that climbs out of its folder
 * writes a file somewhere nobody asked for. Heat that ages on the calendar comes back from a holiday
 * offering to remove every workspace the user has; a terminal whose own keystrokes count as work
 * says an agent is busy every time somebody types to it.
 */

import {
  bindPane,
  cycleLeaf,
  equalize,
  findLeaf,
  leafInDirection,
  leaves,
  neighbourOf,
  newLeaf,
  nodeRects,
  removeLeaf,
  resizeSplit,
  setSizes,
  splitLeaf
} from '../src/renderer/src/paneTree.ts'
import {
  chordBytes,
  formatChord,
  matchesChord,
  parseChord,
  resolvePrefixKey
} from '../src/renderer/src/keys.ts'
import {
  bindingToString,
  buildKeymap,
  decodeText,
  defaultBinds,
  diffKeymap,
  formatTrigger,
  isTextEditingTrigger,
  lookupBinding,
  parseBindLine,
  parseTrigger,
  triggerAliases,
  triggerFromEvent,
  triggerId,
  type KeyEventLike,
  type Keymap
} from '../src/shared/keymap.ts'
import { isCloseCommand, isFileTab, nextActiveTab, tabsToClose } from '../src/renderer/src/tabs.ts'
import {
  activateTab,
  allTabs,
  closeGroup,
  closeTabs as closeTabsInRow,
  focusGroup,
  groupOfTab,
  layoutOrder,
  moveTab,
  moveTabToNewGroup,
  openInGroup,
  resizeAt,
  restoreLayout,
  setBoundary,
  singleGroupRow,
  splitGroup,
  widthShares,
  type GroupRow
} from '../src/renderer/src/groups.ts'
import {
  addFoldersToWorkspaceFile,
  parseWorkspaceFile,
  removeFoldersFromWorkspaceFile,
  resolveWorkspaceFilesDir,
  serializeWorkspaceFile
} from '../src/main/workspaceFile.ts'
import {
  namedWorkspaceFile,
  workspaceFileDir,
  workspaceFilesDirProblem,
  workspaceNameProblem
} from '../src/shared/workspaceFiles.ts'
import { parseByteRange } from '../src/main/byteRange.ts'
import {
  COLD_AFTER,
  HOT,
  KEEP_DAYS,
  OUTPUT_CEILING,
  WARM,
  activityClock,
  ageOf,
  compareWarmth,
  freshActivity,
  heatOf,
  holdRanking,
  lastActiveAt,
  localDay,
  longAgo,
  recordMinute,
  sanitizeActivity,
  shortAgo,
  temperatureOf,
  type Warmth
} from '../src/renderer/src/heat.ts'
import {
  QUIET_MS,
  WORK_MIN_MS,
  describePanes,
  freshWatch,
  hasFinished,
  isLive,
  notWork,
  printingLikeWork,
  sawInput,
  sawOutput,
  terminalPanes,
  wantsCheck
} from '../src/renderer/src/paneWork.ts'
import type { GroupLayout, PaneNode, Tab, WorkspaceActivity } from '../src/shared/types.ts'

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
  // Ctrl+Shift+A is Ghostty's select-all on Windows and Linux; a Ctrl+A prefix must leave it be.
  check('ctrl+shift+a does not match ctrl+a',
    !matchesChord(ev({ ctrlKey: true, shiftKey: true, key: 'A' }), ctrlA!))
  check('ctrl+shift+| still matches ctrl+|, where Shift makes the character',
    matchesChord(ev({ ctrlKey: true, shiftKey: true, key: '|' }), parseChord('ctrl+|')!))

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

  // The dialog records Option+A as alt+a — what the key types unshifted — and macOS composes å.
  const us = (code: string): string | undefined => ({ KeyA: 'a', Backslash: '\\' } as Record<string, string>)[code]
  const optA = { ...k('å', { altKey: true }), code: 'KeyA' }
  eq('an Option prefix recorded unshifted arms', resolvePrefixKey(optA, { ...B, prefix: 'alt+a' }, false, us).kind, 'arm')
  eq('one recorded the old way still does', resolvePrefixKey(optA, { ...B, prefix: 'alt+å' }, false, us).kind, 'arm')
  const pipe = { ...k('|', { ctrlKey: true, shiftKey: true }), code: 'Backslash' }
  eq('so does Ctrl+Shift+\\, which types |', resolvePrefixKey(pipe, { ...B, prefix: 'ctrl+shift+\\' }, false, us).kind, 'arm')
  eq('a Space prefix parses and arms', resolvePrefixKey(k(' ', { ctrlKey: true }), { ...B, prefix: 'ctrl+space' }, false).kind, 'arm')
  eq('and twice sends NUL', chordBytes(parseChord('ctrl+space')!), '\x00')
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

console.log('\nadding folders to a .code-workspace file')
{
  const file = '/projects/group/g.code-workspace'
  const paths = (text: string): string => parseWorkspaceFile(text, file).folders.map((f) => f.path).join(',')

  // What Save Workspace As… writes.
  const ours = serializeWorkspaceFile([{ path: '/projects/group/api' }], file)
  const grown = addFoldersToWorkspaceFile(ours, file, [{ path: '/projects/group/web' }])
  eq('a folder joins the list', paths(grown), '/projects/group/api,/projects/group/web')
  eq('laid out like the entry before it, relative because it is nearby', grown,
    '{\n  "folders": [\n    {\n      "path": "api"\n    },\n    {\n      "path": "web"\n    }\n  ],\n  "settings": {}\n}\n')

  // VS Code writes tabs, and people add comments and settings.
  const vscode = [
    '{',
    '\t// the api, checked out from gerrit',
    '\t"folders": [',
    '\t\t{',
    '\t\t\t"path": "api"',
    '\t\t} // keep first',
    '\t],',
    '\t"settings": { "editor.tabSize": 2 }',
    '}'
  ].join('\n')
  const added = addFoldersToWorkspaceFile(vscode, file, [{ path: '/elsewhere/web', name: 'Web' }])
  eq('beside a hand-edited file it still joins', paths(added), '/projects/group/api,/elsewhere/web')
  check('the comments are kept, the one on the last entry still beside it',
    added.includes('// the api, checked out from gerrit') && added.includes('\t\t}, // keep first\n'), added)
  check('the settings are kept', added.includes('"settings": { "editor.tabSize": 2 }'), added)
  check('in the file\'s own tabs, with the name it was given',
    added.includes('\n\t\t{\n\t\t\t"path": "/elsewhere/web",\n\t\t\t"name": "Web"\n\t\t}\n\t],'), added)

  eq('a folder the file already names, however it spells it, changes nothing',
    addFoldersToWorkspaceFile('{"folders":[{"path":"./api"}]}', file, [{ path: '/projects/group/api' }]),
    '{"folders":[{"path":"./api"}]}')
  eq('a name that is only the folder\'s name is not written',
    addFoldersToWorkspaceFile('{"folders":[]}', file, [{ path: '/x/web', name: 'web' }]).includes('"name"'), false)

  eq('an empty list gets one entry per line',
    addFoldersToWorkspaceFile('{\n  "folders": [],\n  "settings": {}\n}\n', file, [{ path: '/x/a' }, { path: '/x/b' }]),
    '{\n  "folders": [\n    {\n      "path": "/x/a"\n    },\n    {\n      "path": "/x/b"\n    }\n  ],\n  "settings": {}\n}\n')
  eq('a list on one line stays on one line',
    addFoldersToWorkspaceFile('{"folders":[{"path":"api"}],"settings":{}}', file, [{ path: '/x/b' }]),
    '{"folders":[{"path":"api"}, {"path":"/x/b"}],"settings":{}}')
  eq('a trailing comma is kept where it was, and written after the new entry too',
    addFoldersToWorkspaceFile('{\n  "folders": [\n    { "path": "api" },\n  ],\n}\n', file, [{ path: '/x/b' }]),
    '{\n  "folders": [\n    { "path": "api" },\n    { "path": "/x/b" },\n  ],\n}\n')

  const crlf = addFoldersToWorkspaceFile('{\r\n  "folders": [\r\n    {\r\n      "path": "api"\r\n    }\r\n  ]\r\n}\r\n', file, [{ path: '/x/b' }])
  check('a CRLF file gets no bare line feeds', !/[^\r]\n/.test(crlf), JSON.stringify(crlf))
  eq('and still lists both', paths(crlf), '/projects/group/api,/x/b')

  const nested = addFoldersToWorkspaceFile(
    '{"settings":{"folders":["not these"]},"folders":[{"path":"api"}]}', file, [{ path: '/x/b' }])
  check('only the top-level list is touched', nested.includes('{"folders":["not these"]}'), nested)
  eq('which gets the folder', paths(nested), '/projects/group/api,/x/b')

  const twice = addFoldersToWorkspaceFile('{"folders":[{"path":"old"}],"folders":[{"path":"api"}]}', file, [{ path: '/x/b' }])
  eq('of a key written twice, the one JSON.parse reads', paths(twice), '/projects/group/api,/x/b')

  const slashes = addFoldersToWorkspaceFile('{"folders":[{"path":"/srv//x","name":"a // b"}]}', file, [{ path: '/x/b' }])
  eq('a // inside a string is not mistaken for a comment', paths(slashes), '/srv/x,/x/b')

  let threw = ''
  try { addFoldersToWorkspaceFile('{"settings":{}}', file, [{ path: '/x/b' }]) } catch (e) { threw = (e as Error).message }
  check('a file that is not a workspace file is refused, not repaired', threw.includes('folders'), threw)

  eq('a workspace file\'s folder', workspaceFileDir('/w/my/my.code-workspace'), '/w/my')
  eq('at the root, the root', workspaceFileDir('/my.code-workspace'), '/')
  eq('on Windows', workspaceFileDir('C:\\ws\\my\\my.code-workspace'), 'C:\\ws\\my')
  eq('at a drive\'s root, the root and not just the drive', workspaceFileDir('C:\\my.code-workspace'), 'C:\\')
}

console.log('\nremoving folders from a .code-workspace file')
{
  const file = '/projects/group/g.code-workspace'
  const paths = (text: string): string => parseWorkspaceFile(text, file).folders.map((f) => f.path).join(',')
  const remove = (text: string, ...folders: string[]): string => removeFoldersFromWorkspaceFile(text, file, folders)

  // What Save Workspace As… writes: what is left is what it would have written for the rest.
  const ours = serializeWorkspaceFile([{ path: '/projects/group/api' }, { path: '/projects/group/web' }], file)
  eq('the last folder out leaves the file Save would have written',
    remove(ours, '/projects/group/web'), serializeWorkspaceFile([{ path: '/projects/group/api' }], file))
  eq('and so does the first', remove(ours, '/projects/group/api'), serializeWorkspaceFile([{ path: '/projects/group/web' }], file))
  eq('and the two, the list closing up as an empty one is written',
    remove(ours, '/projects/group/api', '/projects/group/web'), serializeWorkspaceFile([], file))
  eq('a folder the file does not name changes nothing', remove(ours, '/projects/group/other'), ours)

  // VS Code writes tabs, and people add comments and settings.
  const vscode = [
    '{',
    '\t// the api, checked out from gerrit',
    '\t"folders": [',
    '\t\t{',
    '\t\t\t"path": "api"',
    '\t\t}, // keep first',
    '\t\t// on a line of its own',
    '\t\t{',
    '\t\t\t"path": "/elsewhere/web",',
    '\t\t\t"name": "Web"',
    '\t\t}',
    '\t],',
    '\t"settings": { "editor.tabSize": 2 }',
    '}'
  ]
  const without = (...drop: number[]): string => vscode.filter((_, i) => !drop.includes(i)).join('\n')
  eq('the last out of a hand-edited file: its lines go, the comma before it, and nothing else',
    remove(vscode.join('\n'), '/elsewhere/web'), without(7, 8, 9, 10).replace('}, // keep first', '} // keep first'))
  eq('the first out: its lines go, the comment beside it with them, the one on a line of its own staying',
    remove(vscode.join('\n'), '/projects/group/api'), without(3, 4, 5))
  eq('both out, the list does not close up over a comment', remove(vscode.join('\n'), '/projects/group/api', '/elsewhere/web'),
    without(3, 4, 5, 7, 8, 9, 10))

  eq('a folder however the file spells it, and every time it does',
    remove('{"folders":[{"path":"./api"},{"path":"web"},{"path":"api/"}]}', '/projects/group/api'), '{"folders":[{"path":"web"}]}')
  const line = '{"folders":[{"path":"a"}, {"path":"b"}, {"path":"c"}],"settings":{}}'
  eq('from a list on one line, one from the middle', remove(line, '/projects/group/b'), '{"folders":[{"path":"a"}, {"path":"c"}],"settings":{}}')
  eq('the last, with the comma before it', remove(line, '/projects/group/c'), '{"folders":[{"path":"a"}, {"path":"b"}],"settings":{}}')
  eq('the first two, with the comma after them', remove(line, '/projects/group/a', '/projects/group/b'), '{"folders":[{"path":"c"}],"settings":{}}')
  eq('the first and the last', remove(line, '/projects/group/a', '/projects/group/c'), '{"folders":[{"path":"b"}],"settings":{}}')
  eq('all of them', remove(line, '/projects/group/a', '/projects/group/b', '/projects/group/c'), '{"folders":[],"settings":{}}')

  const trailing = '{\n  "folders": [\n    { "path": "api" },\n    { "path": "/x/b" },\n  ],\n}\n'
  eq('a trailing comma stays where the file writes them', remove(trailing, '/x/b'), '{\n  "folders": [\n    { "path": "api" },\n  ],\n}\n')
  eq('and from the front', remove(trailing, '/projects/group/api'), '{\n  "folders": [\n    { "path": "/x/b" },\n  ],\n}\n')
  eq('and with nothing left, the list closes up', remove(trailing, '/projects/group/api', '/x/b'), '{\n  "folders": [],\n}\n')
  const commaFirst = '{\n  "folders": [\n    { "path": "api" }\n    , { "path": "web" }\n  ]\n}\n'
  eq('a comma at the head of the line goes with the entry after it', remove(commaFirst, '/projects/group/web'),
    '{\n  "folders": [\n    { "path": "api" }\n  ]\n}\n')
  eq('and the entry before it goes without it', remove(commaFirst, '/projects/group/api'),
    '{\n  "folders": [\n    { "path": "web" }\n  ]\n}\n')

  const crlf = remove('{\r\n  "folders": [\r\n    {\r\n      "path": "api"\r\n    },\r\n    {\r\n      "path": "/x/b"\r\n    }\r\n  ]\r\n}\r\n', '/x/b')
  eq('a CRLF file loses its lines whole', crlf, '{\r\n  "folders": [\r\n    {\r\n      "path": "api"\r\n    }\r\n  ]\r\n}\r\n')

  const nested = remove('{"settings":{"folders":["not these"]},"folders":[{"path":"api"},{"path":"/x/b"}]}', '/projects/group/api')
  eq('only the top-level list is touched', nested, '{"settings":{"folders":["not these"]},"folders":[{"path":"/x/b"}]}')
  const twice = remove('{"folders":[{"path":"old"}],"folders":[{"path":"api"},{"path":"/x/b"}]}', '/projects/group/api')
  eq('of a key written twice, the one JSON.parse reads', twice, '{"folders":[{"path":"old"}],"folders":[{"path":"/x/b"}]}')
  eq('a folder only the other names is not a folder of the workspace',
    remove('{"folders":[{"path":"old"}],"folders":[{"path":"api"}]}', '/projects/group/old'), '{"folders":[{"path":"old"}],"folders":[{"path":"api"}]}')
  eq('a // inside a string is not mistaken for a comment',
    paths(remove('{"folders":[{"path":"/srv//x","name":"a // b"},{"path":"/x/b"}]}', '/x/b')), '/srv/x')

  let threw = ''
  try { remove('{"settings":{}}', '/x/b') } catch (e) { threw = (e as Error).message }
  check('a file that is not a workspace file is refused, not repaired', threw.includes('folders'), threw)
}

console.log('\nbyte ranges, as a video element asks for them')
{
  const r = (header: string | null, size = 1000): string => JSON.stringify(parseByteRange(header, size))
  eq('no header is the whole file', r(null), 'null')
  eq('the opening request, bytes=0-', r('bytes=0-'), '{"start":0,"end":999}')
  eq('a closed range', r('bytes=100-199'), '{"start":100,"end":199}')
  eq('an end past the file is clamped to it', r('bytes=900-5000'), '{"start":900,"end":999}')
  eq('from the middle to the end, which is what a seek asks', r('bytes=500-'), '{"start":500,"end":999}')
  eq('the last N bytes, where some containers keep their index', r('bytes=-100'), '{"start":900,"end":999}')
  eq('more last bytes than there are is all of them', r('bytes=-5000'), '{"start":0,"end":999}')
  eq('the last byte exactly', r('bytes=999-999'), '{"start":999,"end":999}')
  eq('spaces and case are forgiven', r(' Bytes = 10 - 20 '), '{"start":10,"end":20}')
  eq('a start past the end cannot be satisfied', r('bytes=1000-'), '"unsatisfiable"')
  eq('nor an end before the start', r('bytes=50-10'), '"unsatisfiable"')
  eq('nor a zero-length suffix', r('bytes=-0'), '"unsatisfiable"')
  eq('nor any range of an empty file', r('bytes=0-', 0), '"unsatisfiable"')
  eq('several ranges at once get the whole file, not a multipart body', r('bytes=0-1,5-6'), 'null')
  eq('another unit gets the whole file', r('items=0-5'), 'null')
  eq('so does nonsense', r('bytes=abc'), 'null')
  eq('and a range with neither end', r('bytes=-'), 'null')
}

console.log('\nnamed workspace files')
{
  eq('a plain name is fine', workspaceNameProblem('myworkspace'), null)
  eq('so is one with spaces and dots inside', workspaceNameProblem('jira migrate v2.1'), null)
  eq('and one in another script', workspaceNameProblem('我的工作区'), null)
  check('an empty name is not', workspaceNameProblem('') !== null)
  check('nor only spaces', workspaceNameProblem('   ') !== null)
  check('nor a leading or trailing space', workspaceNameProblem(' a') !== null && workspaceNameProblem('a ') !== null)
  // The checks that keep a name from climbing out of the folder it is filed under.
  check('nor ..', workspaceNameProblem('..') !== null)
  check('nor a separator either way', workspaceNameProblem('a/b') !== null && workspaceNameProblem('a\\b') !== null)
  check('nor ../escape', workspaceNameProblem('../escape') !== null)
  check('nor what Windows refuses', [':', '*', '?', '"', '<', '>', '|'].every((c) => workspaceNameProblem(`a${c}b`) !== null))
  check('nor a control character', workspaceNameProblem('a\u0007b') !== null)
  check('nor a trailing dot', workspaceNameProblem('name.') !== null)

  eq('filed in a folder of its own', namedWorkspaceFile('/w', 'my', '/'), '/w/my/my.code-workspace')
  eq('a trailing separator is not doubled', namedWorkspaceFile('/w/', 'my', '/'), '/w/my/my.code-workspace')
  eq('the root works', namedWorkspaceFile('/', 'my', '/'), '/my/my.code-workspace')
  eq('Windows separators', namedWorkspaceFile('C:\\ws', 'my', '\\'), 'C:\\ws\\my\\my.code-workspace')
  eq('a drive root', namedWorkspaceFile('C:\\', 'my', '\\'), 'C:\\my\\my.code-workspace')

  eq('no folder is fine', workspaceFilesDirProblem(''), null)
  eq('an absolute one is', workspaceFilesDirProblem('/Users/me/Workspaces'), null)
  eq('so is one from home', workspaceFilesDirProblem('~/Workspaces'), null)
  eq('and home itself', workspaceFilesDirProblem('~'), null)
  eq('and a Windows path', workspaceFilesDirProblem('D:\\Workspaces'), null)
  eq('and a share', workspaceFilesDirProblem('\\\\server\\share'), null)
  check('a relative one is not', workspaceFilesDirProblem('Workspaces') !== null)
  check('nor ~user, which is somebody else\'s home', workspaceFilesDirProblem('~bob/ws') !== null)

  eq('unset resolves to nothing', resolveWorkspaceFilesDir(undefined, '/home/me'), null)
  eq('blank too', resolveWorkspaceFilesDir('  ', '/home/me'), null)
  eq('~ is home', resolveWorkspaceFilesDir('~', '/home/me'), '/home/me')
  eq('~/ is under it', resolveWorkspaceFilesDir('~/Workspaces', '/home/me'), '/home/me/Workspaces')
  eq('an absolute path is kept, tidied', resolveWorkspaceFilesDir('/w/./x/', '/home/me'), '/w/x')
  eq('a relative one is refused, not resolved against wherever the app started',
    resolveWorkspaceFilesDir('ws', '/home/me'), null)
}

console.log('\nshortcuts: parsing Ghostty syntax')
{
  const t = parseTrigger('super+shift+d')
  check('a chord parses', !!t && t.mods.super && t.mods.shift && !t.mods.ctrl && t.key === 'd' && !t.physical,
    JSON.stringify(t))
  eq('an empty part is the plus key', parseTrigger('super++')?.key, '+')
  eq('the equals key parses too', parseTrigger('super+=')?.key, '=')
  eq('a Ghostty key name is a physical key', parseTrigger('cmd+arrow_left')?.physical, true)
  eq('W3C names are accepted', parseTrigger('ArrowUp')?.key, 'arrow_up')
  eq('so is Digit1', parseTrigger('super+Digit1')?.key, 'digit_1')
  eq('and the 1.1-era aliases', parseTrigger('up')?.key, 'arrow_up')
  eq('a repeated modifier is an error, as in Ghostty', parseTrigger('ctrl+ctrl+a'), null)
  eq('so is an unknown one', parseTrigger('hyper+a'), null)

  const inc = parseBindLine('super+==increase_font_size:1')
  check('"super+==…" splits at the second =, which is Ghostty\'s rule',
    inc?.kind === 'bind' && inc.binding.trigger.key === '=' && inc.binding.action === 'increase_font_size:1',
    JSON.stringify(inc))
  const pasted = parseBindLine('keybind = performable:super+c=copy_to_clipboard')
  check('a line pasted from a Ghostty config works as it is',
    pasted?.kind === 'bind' && pasted.binding.performable && pasted.binding.action === 'copy_to_clipboard',
    JSON.stringify(pasted))
  eq('unbind', parseBindLine('super+k=unbind')?.kind, 'unbind')
  eq('clear', parseBindLine('keybind = clear')?.kind, 'clear')
  eq('an empty keybind = is "back to the defaults"', parseBindLine('keybind =')?.kind, 'reset')
  eq('comments are skipped', parseBindLine('# nothing'), null)
  eq('blank lines are skipped', parseBindLine('   '), null)
  eq('global: is refused, not half-honoured', parseBindLine('global:super+a=new_tab')?.kind, 'error')
  eq('sequences are refused', parseBindLine('ctrl+a>n=new_tab')?.kind, 'error')
  eq('but > as a key is not a sequence', parseBindLine('ctrl+>=new_tab')?.kind, 'bind')
  eq('an unknown action is an error', parseBindLine('super+x=launch_rockets')?.kind, 'error')
  eq('a missing parameter is an error', parseBindLine('super+x=goto_tab')?.kind, 'error')
  eq('so is a bad one', parseBindLine('super+x=goto_tab:0')?.kind, 'error')
  eq('and one where none belongs', parseBindLine('super+x=select_all:now')?.kind, 'error')
  eq('a bare new_split is Ghostty\'s auto', parseBindLine('super+d=new_split')?.kind, 'bind')
  eq('goto_split takes Ghostty\'s top and bottom', parseBindLine('super+k=goto_split:top')?.kind, 'bind')

  eq('text: reads \\x escapes', decodeText('\\x01'), '\x01')
  eq('and the Zig ones', decodeText('a\\nb\\t\\\\'), 'a\nb\t\\')
  eq('and \\u{…}', decodeText('\\u{1F600}'), '\u{1F600}')
  eq('a bad escape is an error, not a stray backslash', decodeText('\\q'), null)
  eq('so is a short \\x', decodeText('\\x0'), null)
}

/** A keydown as the browser reports it, with every modifier explicit. */
const key = (k: string, code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike =>
  ({ key: k, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })
const action = (map: Keymap, e: KeyEventLike): string | null => lookupBinding(map, e)?.action ?? null

console.log('\nshortcuts: the defaults')
for (const where of ['darwin', 'linux', 'win32']) {
  const lines = defaultBinds(where)
  const { keymap, errors } = buildKeymap(lines, [])
  eq(`${where}: every default line parses`, errors.map((e) => `${e.line}: ${e.message}`).join('; '), '')
  // Two defaults on one trigger would be one silently overriding the other.
  eq(`${where}: no two defaults share a key`, keymap.size, lines.length)
  let roundTrips = true
  for (const b of keymap.values()) {
    const again = parseBindLine(bindingToString(b))
    if (again?.kind !== 'bind' || triggerId(again.binding.trigger) !== triggerId(b.trigger) ||
      again.binding.action !== b.action || again.binding.performable !== b.performable) roundTrips = false
  }
  check(`${where}: every default prints back to a line that parses to itself`, roundTrips)
}

console.log('\nshortcuts: macOS keys')
{
  const mac = buildKeymap(defaultBinds('darwin'), []).keymap
  // The two things this was built for.
  eq('Cmd+V pastes', action(mac, key('v', 'KeyV', { metaKey: true })), 'paste_from_clipboard')
  eq('Shift+Enter inserts a newline', action(mac, key('Enter', 'Enter', { shiftKey: true })), 'insert_newline')
  eq('plain Enter is left alone', action(mac, key('Enter', 'Enter')), null)
  eq('Cmd+Shift+V is Ghostty\'s selection paste', action(mac, key('v', 'KeyV', { metaKey: true, shiftKey: true })),
    'paste_from_selection')
  check('Cmd+C falls through with nothing selected', lookupBinding(mac, key('c', 'KeyC', { metaKey: true }))?.performable === true)

  // Shift turns [ into { — the unshifted lookup is what still finds the binding.
  eq('Cmd+Shift+[ is the previous tab', action(mac, key('{', 'BracketLeft', { metaKey: true, shiftKey: true })), 'previous_tab')
  eq('Cmd+[ is the previous pane', action(mac, key('[', 'BracketLeft', { metaKey: true })), 'goto_split:previous')
  eq('Cmd+= is bigger text', action(mac, key('=', 'Equal', { metaKey: true })), 'increase_font_size:1')
  eq('so is Cmd+Shift+=, which types +', action(mac, key('+', 'Equal', { metaKey: true, shiftKey: true })),
    'increase_font_size:1')
  eq('Cmd+- is smaller text', action(mac, key('-', 'Minus', { metaKey: true })), 'decrease_font_size:1')
  eq('Cmd+1 is the first tab', action(mac, key('1', 'Digit1', { metaKey: true })), 'goto_tab:1')
  eq('Cmd+9 is the last tab', action(mac, key('9', 'Digit9', { metaKey: true })), 'last_tab')
  // Option composes on a Mac: e.key is ¡, not 1.
  eq('Option+Cmd+1 is the first column', action(mac, key('¡', 'Digit1', { metaKey: true, altKey: true })), 'goto_group:1')
  eq('Option+Cmd+B finds alt+b through what the key types unshifted',
    action(mac, key('∫', 'KeyB', { metaKey: true, altKey: true })), 'toggle_right_panel')
  eq('Option+B alone is not bound', action(mac, key('∫', 'KeyB', { altKey: true })), null)
  eq('Option+Left is back a word', action(mac, key('ArrowLeft', 'ArrowLeft', { altKey: true })), 'esc:b')
  eq('Cmd+Left is start of line', action(mac, key('ArrowLeft', 'ArrowLeft', { metaKey: true })), 'text:\\x01')
  eq('Cmd+Shift+G is the previous match, whichever case e.key reports',
    action(mac, key('G', 'KeyG', { metaKey: true, shiftKey: true })), 'navigate_search:previous')
  eq('lower case too', action(mac, key('g', 'KeyG', { metaKey: true, shiftKey: true })), 'navigate_search:previous')
  eq('Cmd+W closes the pane first', action(mac, key('w', 'KeyW', { metaKey: true })), 'close_surface')
  eq('Escape only ever ends a search', action(mac, key('Escape', 'Escape')), 'end_search')
  check('and only when there is one', lookupBinding(mac, key('Escape', 'Escape'))?.performable === true)
  eq('Ctrl+C is SIGINT, never a shortcut', action(mac, key('c', 'KeyC', { ctrlKey: true })), null)
  eq('a letter is just a letter', action(mac, key('a', 'KeyA')), null)
  // The smoke tests dispatch synthetic events with no `code`. They must still land.
  eq('a key with no code still matches by what it types', action(mac, key('d', '', { metaKey: true })), 'new_split:right')
  eq('with Shift too', action(mac, key('D', '', { metaKey: true, shiftKey: true })), 'new_split:down')
  // AZERTY: the key in QWERTY's A position types q; Cmd+A is the one that types a.
  const azerty = (code: string): string | undefined => ({ KeyQ: 'a', KeyA: 'q' } as Record<string, string>)[code]
  eq('layouts: the key that types a is Cmd+A', lookupBinding(mac, key('a', 'KeyQ', { metaKey: true }), azerty)?.action,
    'select_all')
  eq('Cmd+keypad 1 is the first tab too, as in Ghostty', action(mac, key('1', 'Numpad1', { metaKey: true })), 'goto_tab:1')
  eq('Shift+keypad Enter (Fn+Return) inserts a newline', action(mac, key('Enter', 'NumpadEnter', { shiftKey: true })),
    'insert_newline')
  // An exact spelling beats the Shift liberty — it is what the dialog records for the chord.
  eq('super+shift+= spelled out wins over super++',
    action(buildKeymap(defaultBinds('darwin'), ['super+shift+==new_tab']).keymap, key('+', 'Equal', { metaKey: true, shiftKey: true })),
    'new_tab')
}

console.log('\nshortcuts: Windows and Linux keys')
{
  const other = buildKeymap(defaultBinds('linux'), []).keymap
  eq('Ctrl+Shift+C copies', action(other, key('C', 'KeyC', { ctrlKey: true, shiftKey: true })), 'copy_to_clipboard')
  eq('Ctrl+Shift+V pastes', action(other, key('V', 'KeyV', { ctrlKey: true, shiftKey: true })), 'paste_from_clipboard')
  eq('Shift+Enter inserts a newline', action(other, key('Enter', 'Enter', { shiftKey: true })), 'insert_newline')
  eq('Shift+Insert pastes the selection', action(other, key('Insert', 'Insert', { shiftKey: true })), 'paste_from_selection')
  // Plain Ctrl+letter belongs to the shell.
  for (const [k, what] of [['c', 'SIGINT'], ['v', 'literal-quote'], ['d', 'EOF'], ['w', 'delete-word'], ['t', 'transpose'], ['b', 'back-char']]) {
    eq(`Ctrl+${k.toUpperCase()} stays ${what}`, action(other, key(k, `Key${k.toUpperCase()}`, { ctrlKey: true })), null)
  }
  eq('Ctrl+\\ stays SIGQUIT', action(other, key('\\', 'Backslash', { ctrlKey: true })), null)
  eq('Ctrl+Enter stays Claude Code\'s send-now', action(other, key('Enter', 'Enter', { ctrlKey: true })), null)
  eq('Alt+1 is the first tab', action(other, key('1', 'Digit1', { altKey: true })), 'goto_tab:1')
  eq('Shift+Insert is the PRIMARY selection on Linux', action(other, key('Insert', 'Insert', { shiftKey: true })), 'paste_from_selection')
  const win = buildKeymap(defaultBinds('win32'), []).keymap
  eq('and the clipboard on Windows, as everywhere else there', action(win, key('Insert', 'Insert', { shiftKey: true })), 'paste_from_clipboard')
  // Ctrl+Alt+<key that types> is AltGr on Windows: AltGr+7 is { on a German keyboard.
  for (const k of ['7', '8', '9', '0', 'q', 'e', 'b']) {
    const code = /\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`
    eq(`Ctrl+Alt+${k.toUpperCase()} is left to AltGr`, action(win, key(k, code, { ctrlKey: true, altKey: true })), null)
  }
  eq('columns are Alt+Shift+digit', action(other, key('!', 'Digit1', { altKey: true, shiftKey: true })), 'goto_group:1')
  eq('the right panel is Ctrl+Shift+G', action(other, key('G', 'KeyG', { ctrlKey: true, shiftKey: true })), 'toggle_right_panel')
  check('and falls through when there is nothing to switch to', lookupBinding(other, key('1', 'Digit1', { altKey: true }))?.performable === true)
}

console.log('\nshortcuts: the user\'s changes')
{
  const lines = defaultBinds('darwin')
  const defaults = buildKeymap(lines, []).keymap
  const cmdK = key('k', 'KeyK', { metaKey: true })

  eq('unbind removes a default', action(buildKeymap(lines, ['super+k=unbind']).keymap, cmdK), null)
  eq('a new key works', action(buildKeymap(lines, ['super+shift+k=clear_screen']).keymap,
    key('k', 'KeyK', { metaKey: true, shiftKey: true })), 'clear_screen')
  eq('the last word on a key wins', action(buildKeymap(lines, ['super+k=select_all']).keymap, cmdK), 'select_all')
  eq('clear drops everything', buildKeymap(lines, ['keybind = clear']).keymap.size, 0)
  eq('and an empty keybind = brings the defaults back',
    buildKeymap(lines, ['keybind = clear', 'keybind =']).keymap.size, defaults.size)
  const bad = buildKeymap(lines, ['nonsense', 'super+k=unbind'])
  eq('a bad line is reported', bad.errors.length, 1)
  eq('and does not stop the good ones', action(bad.keymap, cmdK), null)

  eq('no changes save as nothing', diffKeymap(defaults, defaults).length, 0)
  const edited = new Map(buildKeymap(lines, ['super+k=unbind', 'super+shift+k=clear_screen', 'super+c=copy_to_clipboard']).keymap)
  const diff = diffKeymap(defaults, edited)
  eq('what is saved is only the difference', diff.length, 3)
  const again = buildKeymap(lines, diff).keymap
  check('and it rebuilds the same keymap',
    again.size === edited.size && [...edited].every(([id, b]) => {
      const x = again.get(id)
      return !!x && x.action === b.action && x.performable === b.performable
    }))
  check('a dropped performable: flag counts as a change', diff.includes('super+c=copy_to_clipboard'), JSON.stringify(diff))
}

console.log('\nshortcuts: display and capture')
{
  eq('mac spelling', formatTrigger(parseTrigger('super+shift+d')!, true), '⇧⌘D')
  eq('mac modifier order is ⌃⌥⇧⌘', formatTrigger(parseTrigger('super+ctrl+alt+shift+x')!, true), '⌃⌥⇧⌘X')
  eq('other platforms spell it out', formatTrigger(parseTrigger('ctrl+shift+c')!, false), 'Ctrl+Shift+C')
  eq('arrows are arrows', formatTrigger(parseTrigger('super+arrow_left')!, true), '⌘←')
  eq('a physical digit is its digit', formatTrigger(parseTrigger('super+digit_1')!, true), '⌘1')
  eq('the plus key', formatTrigger(parseTrigger('super++')!, true), '⌘+')

  const cap = (e: KeyEventLike): string => { const t = triggerFromEvent(e); return t ? `${t.physical ? 'p' : 'u'}:${JSON.stringify(t.mods)}:${t.key}` : 'null' }
  eq('capturing Cmd+Shift+[ records [ not {', triggerFromEvent(key('{', 'BracketLeft', { metaKey: true, shiftKey: true }))?.key, '[')
  eq('Shift+Enter records the physical Enter', cap(key('Enter', 'Enter', { shiftKey: true })),
    'p:{"super":false,"ctrl":false,"alt":false,"shift":true}:enter')
  eq('Option+E records e, not the dead key', triggerFromEvent(key('Dead', 'KeyE', { altKey: true }))?.key, 'e')
  eq('a modifier alone records nothing', triggerFromEvent(key('Meta', 'MetaLeft', { metaKey: true })), null)

  const aliases = triggerAliases(parseTrigger('super+digit_1')!)
  check('super+digit_1 and super+1 are the same key', aliases.includes(triggerId(parseTrigger('super+1')!)), JSON.stringify(aliases))
  check('and so are super+bracket_left and super+[',
    triggerAliases(parseTrigger('super+[')!).includes(triggerId(parseTrigger('super+bracket_left')!)))
  check('but not super+2', !aliases.includes(triggerId(parseTrigger('super+2')!)))
  check('Ctrl+Shift+Left is a text-editing key', isTextEditingTrigger(parseTrigger('ctrl+shift+arrow_left')!))
  check('so is Cmd+Enter', isTextEditingTrigger(parseTrigger('super+enter')!))
  check('Cmd+T is not', !isTextEditingTrigger(parseTrigger('super+t')!))
}

console.log('\npane navigation')
{
  // R(a, C(b, c)): a on the left, b over c on the right.
  const a = newLeaf()
  const two = splitLeaf(a, a.id, 'row')
  const b = two.newLeafId
  const three = splitLeaf(two.root, b, 'column')
  const c = three.newLeafId
  const root = three.root
  eq('shape', shape(root), 'R(L C(L L))')

  eq('next pane', cycleLeaf(root, a.id, 1), b)
  eq('next wraps round', cycleLeaf(root, c, 1), a.id)
  eq('previous wraps round', cycleLeaf(root, a.id, -1), c)
  eq('one pane has nowhere to go', cycleLeaf(a, a.id, 1), null)

  const rects = nodeRects(root)
  check('rects come from the tree', rects.get(c)!.x === 0.5 && rects.get(c)!.y === 0.5 && rects.get(a.id)!.h === 1,
    JSON.stringify([...rects]))

  eq('right of a is b, the nearer corner', leafInDirection(root, a.id, 'right'), b)
  eq('left of c is a', leafInDirection(root, c, 'left'), a.id)
  eq('below b is c', leafInDirection(root, b, 'down'), c)
  eq('above c is b', leafInDirection(root, c, 'up'), b)
  eq('nothing left of a, and no wrapping', leafInDirection(root, a.id, 'left'), null)

  const box = { width: 1000, height: 500 }
  const grown = resizeSplit(root, a.id, 'right', 10, box)
  check('10px right moves the divider 1% of 1000px',
    grown?.kind === 'split' && Math.abs(grown.sizes[0]! - 0.51) < 1e-9, JSON.stringify(grown?.kind === 'split' && grown.sizes))
  const fromRight = resizeSplit(root, b, 'right', 10, box)
  check('from the right-hand pane, the same divider moves right',
    fromRight?.kind === 'split' && Math.abs(fromRight.sizes[0]! - 0.51) < 1e-9)
  const down = resizeSplit(root, b, 'down', 25, box)
  const inner = down?.kind === 'split' ? down.children[1] : null
  check('down moves the nearest horizontal divider — the one in the right column',
    inner?.kind === 'split' && Math.abs(inner.sizes[0]! - 0.55) < 1e-9, JSON.stringify(inner))
  eq('there is no horizontal divider next to a', resizeSplit(root, a.id, 'up', 10, box), null)
  const squeezed = resizeSplit(root, a.id, 'right', 100000, box)
  check('a pane cannot be squeezed to nothing',
    squeezed?.kind === 'split' && Math.abs(squeezed.sizes[0]! - 0.92) < 1e-9)

  // Uneven, then equalised. R(a, R(b, c)) is not something splitLeaf builds, but a tree can hold it.
  const nested: PaneNode = {
    kind: 'split', id: 's1', direction: 'row', sizes: [0.8, 0.2],
    children: [{ kind: 'leaf', id: 'x', paneId: null },
      { kind: 'split', id: 's2', direction: 'row', sizes: [0.9, 0.1],
        children: [{ kind: 'leaf', id: 'y', paneId: null }, { kind: 'leaf', id: 'z', paneId: null }] }]
  }
  const even = equalize(nested)
  check('equalize counts panes, not branches: three equal columns',
    even.kind === 'split' && Math.abs(even.sizes[0]! - 1 / 3) < 1e-9 &&
      even.children[1]!.kind === 'split' && Math.abs(even.children[1]!.sizes[0]! - 0.5) < 1e-9,
    JSON.stringify(even))
  const evenMixed = equalize(setSizes(root, root.id, [0.9, 0.1]))
  check('a column in a row counts as one', evenMixed.kind === 'split' && Math.abs(evenMixed.sizes[0]! - 0.5) < 1e-9)

  const before = splitLeaf(a, a.id, 'row', newLeaf(), true)
  eq('new_split:left puts the new pane first',
    before.root.kind === 'split' ? before.root.children[0]!.id : '', before.newLeafId)
}

console.log('\ntab strip')
{
  /*
   * Which plugin tabs count as documents comes from the manifests at runtime. Injected here as a
   * literal so this file stays a pure unit test: it is bundled by esbuild with no aliases, and
   * reaching for the real registry would drag the whole plugin barrel into it.
   */
  const isDocument = (viewType: string): boolean => viewType === 'scm.diff'

  const editor = (id: string, pinned = false): Tab =>
    ({ id, kind: 'editor', title: id, pinned, filePath: `/${id}.ts`, repoId: null, readOnly: false })
  const diff = (id: string): Tab =>
    ({ id, kind: 'custom', title: id, pinned: false, viewType: 'scm.diff',
       state: { filePath: `/${id}.ts`, repoId: 'r', against: { kind: 'worktree-vs-index' } },
       key: `scm.diff:r:/${id}.ts:worktree-vs-index` })
  const terminal = (id: string): Tab =>
    ({ id, kind: 'terminal', title: id, pinned: false,
       root: { kind: 'leaf', id: `${id}-leaf`, paneId: null }, activeLeafId: `${id}-leaf` })
  const browser = (id: string): Tab =>
    ({ id, kind: 'custom', title: id, pinned: false, viewType: 'browser.page',
       state: { url: 'https://example.com' } })

  check('an editor is a file tab', isFileTab(editor('a'), isDocument))
  check('a diff is a file tab', isFileTab(diff('d'), isDocument))
  check('a terminal is not', !isFileTab(terminal('t'), isDocument))
  check('a browser is not', !isFileTab(browser('b'), isDocument))
  check('nor is a plugin tab whose plugin is gone',
    !isFileTab({ id: 'z', kind: 'custom', title: 'z', pinned: false,
                 viewType: 'ghost.view', state: {} }, isDocument))

  // One strip, one set of commands: terminals, pages and files are swept alike, whichever kind
  // of tab the menu was opened on. A running program is asked about by the caller, not skipped.
  const mixed = [terminal('t1'), editor('e1'), browser('b1'), editor('e2'), diff('d1'), terminal('t2')]

  eq('close others takes every other kind of tab',
    tabsToClose(mixed, 'e1', 'others').join(','), 't1,b1,e2,d1,t2')
  eq('close to the right takes terminals and pages too',
    tabsToClose(mixed, 'e1', 'right').join(','), 'b1,e2,d1,t2')
  eq('close all means all',
    tabsToClose(mixed, 'e1', 'all').join(','), 't1,e1,b1,e2,d1,t2')

  // The same commands from a terminal or a page as from a file.
  eq('close others from a terminal',
    tabsToClose(mixed, 't1', 'others').join(','), 'e1,b1,e2,d1,t2')
  eq('close to the right from a page',
    tabsToClose(mixed, 'b1', 'right').join(','), 'e2,d1,t2')

  eq('close to the right of the last tab is empty',
    tabsToClose(mixed, 't2', 'right').length, 0)
  eq('close others excludes the target',
    tabsToClose(mixed, 'e2', 'others').includes('e2'), false)
  eq('close others with nothing else open is empty',
    tabsToClose([terminal('only')], 'only', 'others').length, 0)

  eq('an unknown tab closes nothing', tabsToClose(mixed, 'nope', 'all').length, 0)

  // Pinned: TabBase says pinned tabs survive "close others", so they must also survive the
  // narrower sweep, but not an explicit close-all. Matches VSCode.
  const withPinned = [editor('p', true), editor('x'), terminal('y')]
  eq('a pinned tab survives close others',
    tabsToClose(withPinned, 'x', 'others').join(','), 'y')
  eq('and survives close to the right',
    tabsToClose([editor('a'), browser('p'), editor('z')].map((t) => (t.id === 'p' ? { ...t, pinned: true } : t)), 'a', 'right').join(','),
    'z')
  eq('but close all takes it',
    tabsToClose(withPinned, 'x', 'all').join(','), 'p,x,y')

  check('the menu ids are close commands', ['others', 'right', 'all'].every(isCloseCommand))
  check('and nothing else is', !isCloseCommand('close') && !isCloseCommand(''))

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

console.log('\neditor groups')
{
  const editor = (id: string): Tab =>
    ({ id, kind: 'editor', title: id, pinned: false, filePath: `/${id}.ts`, repoId: null, readOnly: false })
  const sameTarget = (a: Tab, b: Tab): boolean =>
    a.kind === 'editor' && b.kind === 'editor' && a.filePath === b.filePath

  /** Compact layout, by group id: `R(g1 C(g2 g3))`. */
  const layoutShape = (node: GroupLayout): string =>
    node.kind === 'group' ? node.id : `${node.direction === 'row' ? 'R' : 'C'}(${node.children.map(layoutShape).join(' ')})`
  const pct = (sizes: number[]): string => sizes.map((s) => Math.round(s * 100)).join(',')
  /** The outermost split's sizes; a lone group has all of it. */
  const sizesOf = (node: GroupLayout): number[] => (node.kind === 'split' ? node.sizes : [1])
  const topId = (row: GroupRow): string => (row.layout.kind === 'split' ? row.layout.id : '')
  /** The first stacked split, wherever it is. */
  const columnOf = (node: GroupLayout): Extract<GroupLayout, { kind: 'split' }> | null =>
    node.kind === 'group' ? null : node.direction === 'column' ? node : (node.children.map(columnOf).find(Boolean) ?? null)
  /**
   * Everything the module promises about a row, in one check: the layout's groups are exactly the
   * list, in its order, one of them active; no split of one, and none inside one running the same
   * way; and each split's sizes, one per child, fill it.
   */
  const sound = (row: GroupRow): boolean => {
    const splitOk = (node: GroupLayout): boolean =>
      node.kind === 'group' ||
      (node.children.length >= 2 &&
        node.sizes.length === node.children.length &&
        node.sizes.every((s) => s > 0) &&
        Math.abs(sum(node.sizes) - 1) < 1e-9 &&
        node.children.every((c) => c.kind === 'group' || c.direction !== node.direction) &&
        node.children.every(splitOk))
    return (
      layoutOrder(row.layout).join(',') === row.groups.map((g) => g.id).join(',') &&
      row.groups.some((g) => g.id === row.activeGroupId) &&
      splitOk(row.layout)
    )
  }

  // One group to start with, holding everything the workspace had before groups existed.
  const one = singleGroupRow('g1', [editor('a'), editor('b')])
  eq('a fresh row has one group', one.groups.length, 1)
  eq('and it is active', one.activeGroupId, 'g1')
  eq('its last tab is showing', one.groups[0].activeTabId, 'b')
  check('it fills the row', sound(one))

  // Split: the new group takes half of the SOURCE's width, not an equal share of the row.
  const two = splitGroup(one, 'g1', 'g2', editor('b-copy'))
  eq('split adds a group', two.groups.length, 2)
  eq('the new group is active', two.activeGroupId, 'g2')
  eq('beside the old one', layoutShape(two.layout), 'R(g1 g2)')
  eq('halves are equal', pct(sizesOf(two.layout)), '50,50')
  const three = splitGroup(two, 'g1', 'g3', editor('c'))
  eq('splitting the left group again', three.groups.map((g) => g.id).join(','), 'g1,g3,g2')
  eq('joins the row rather than nesting in it', layoutShape(three.layout), 'R(g1 g3 g2)')
  eq('takes width from the left group only', pct(sizesOf(three.layout)), '25,25,50')
  check('and the row still fills', sound(three))

  // Per-group de-duplication: the same file in two groups is the whole point of the feature.
  // A real caller mints a fresh id; what makes the two tabs "the same file" is the path.
  const dupA = openInGroup(two, 'g2', { ...editor('a-copy'), filePath: '/a.ts' } as Tab, sameTarget)
  eq('the same file opens in a second group', groupOfTab(dupA, 'a-copy').id, 'g2')
  eq('and the original stays where it was', groupOfTab(dupA, 'a').id, 'g1')
  const reopened = openInGroup(dupA, 'g1', { ...editor('a2'), filePath: '/a.ts' } as Tab, sameTarget)
  eq('reopening it in its own group re-activates rather than duplicating',
    reopened.groups[0].tabs.length, 2)
  eq('and shows the existing tab', reopened.groups[0].activeTabId, 'a')

  // Closing the last tab in a group takes the group with it, and gives back its width.
  const closed = closeTabsInRow(two, ['b-copy'])
  eq('emptying a group removes it', closed.groups.length, 1)
  eq('the survivor takes the whole row', layoutShape(closed.layout), 'g1')
  check('which is sound', sound(closed))
  eq('and becomes active', closed.activeGroupId, 'g1')

  // ...but never the last one: an empty row has nowhere to put the next file you open.
  const emptied = closeTabsInRow(closed, ['a', 'b'])
  eq('the last group survives empty', emptied.groups.length, 1)
  eq('showing nothing', emptied.groups[0].activeTabId, null)

  // Cross-group drag.
  const moved = moveTab(three, 'b', 'g2', 0)
  eq('a dragged tab leaves its group', groupOfTab(moved, 'b').id, 'g2')
  eq('and lands at the requested index', moved.groups[2].tabs[0].id, 'b')
  eq('its new group takes focus', moved.activeGroupId, 'g2')
  eq('nothing is lost', allTabs(moved).length, allTabs(three).length)

  const drained = moveTab(two, 'b-copy', 'g1', 0)
  eq('draining a group closes it', drained.groups.length, 1)
  check('and the row still fills', sound(drained))

  eq('dragging within a group reorders',
    moveTab(one, 'b', 'g1', 0).groups[0].tabs.map((t) => t.id).join(','), 'b,a')
  eq('dropping a tab where it already is changes nothing',
    moveTab(one, 'a', 'g1', 0), one)

  // Dragging out to a group of its own.
  const pulled = moveTabToNewGroup(one, 'a', 'g9')
  eq('the tab gets its own group', groupOfTab(pulled, 'a').id, 'g9')
  eq('and leaves the old one', pulled.groups[0].tabs.map((t) => t.id).join(','), 'b')
  eq('a lone tab cannot be pulled out of its own group',
    moveTabToNewGroup(singleGroupRow('g1', [editor('only')]), 'only', 'g2').groups.length, 1)

  // Selection.
  eq('activating a tab focuses its group', activateTab(three, 'b-copy').activeGroupId, 'g2')
  eq('focusing a group leaves tabs alone', focusGroup(three, 'g1').groups, three.groups)
  eq('focusing an unknown group is a no-op', focusGroup(three, 'nope'), three)

  // Resizing moves only the two groups either side of the handle.
  const resized = resizeAt(three, topId(three), 0, 0.1)
  eq('the pair either side of the handle move', pct(sizesOf(resized.layout)), '35,15,50')
  check('and the row still fills', sound(resized))
  eq('a group cannot be squeezed away',
    sizesOf(resizeAt(three, topId(three), 0, -1).layout)[0] > 0.05, true)
  eq('an out-of-range handle is a no-op', resizeAt(three, topId(three), 5, 0.1), three)
  eq('so is a split that is not there', resizeAt(three, 'nope', 0, 0.1), three)

  // Split down: the same arithmetic the other way. A lone group becomes a column of two.
  const stacked = splitGroup(one, 'g1', 'g2', editor('b-copy'), 'down')
  eq('splitting down stacks the new group under the old', layoutShape(stacked.layout), 'C(g1 g2)')
  eq('the new group is active', stacked.activeGroupId, 'g2')
  eq('and takes half the height', pct(sizesOf(stacked.layout)), '50,50')
  check('the column is sound', sound(stacked))

  // Down from a group in a row puts a column in that group's place, and leaves the row alone.
  const tee = splitGroup(two, 'g1', 'g3', editor('c'), 'down')
  eq('down from a group in a row nests a column there', layoutShape(tee.layout), 'R(C(g1 g3) g2)')
  eq('the row keeps its widths', pct(sizesOf(tee.layout)), '50,50')
  eq('reading order goes down a column before going on across',
    tee.groups.map((g) => g.id).join(','), 'g1,g3,g2')
  check('and it is sound', sound(tee))
  // Down again from inside that column joins it, rather than nesting a column in a column.
  const taller = splitGroup(tee, 'g1', 'g4', editor('d'), 'down')
  eq('down again joins the column', layoutShape(taller.layout), 'R(C(g1 g4 g3) g2)')
  eq('taking height from the split group only', pct(columnOf(taller.layout)!.sizes), '25,25,50')
  check('still sound', sound(taller))
  // Right from inside the column nests a row there.
  const grid = splitGroup(tee, 'g3', 'g5', editor('e'))
  eq('right from a stacked group nests a row in the column', layoutShape(grid.layout), 'R(C(g1 R(g3 g5)) g2)')
  check('sound again', sound(grid))

  // Closing the lower of two stacked groups gives the upper one the column's whole slot.
  const unstacked = closeGroup(tee, 'g3')
  eq('closing a stacked group collapses its column', layoutShape(unstacked.layout), 'R(g1 g2)')
  eq('the survivor keeps the column\'s width', pct(sizesOf(unstacked.layout)), '50,50')
  eq('and the focus goes up to it', unstacked.activeGroupId, 'g1')
  check('sound after closing', sound(unstacked))
  eq('closing the upper one sends the focus down', closeGroup(focusGroup(tee, 'g1'), 'g1').activeGroupId, 'g3')
  eq('closing one without the focus leaves it be', closeGroup(tee, 'g2').activeGroupId, 'g3')
  // The column around a nested row collapsing leaves a row inside a row, which is merged.
  const merged = closeGroup(grid, 'g1')
  eq('a row left inside a row merges into it', layoutShape(merged.layout), 'R(g3 g5 g2)')
  eq('sharing out the slot it had', pct(sizesOf(merged.layout)), '25,25,50')
  check('sound after merging', sound(merged))
  eq('emptying a stacked group closes it', layoutShape(closeTabsInRow(tee, ['c']).layout), 'R(g1 g2)')
  eq('so does dragging its last tab away', layoutShape(moveTab(tee, 'c', 'g2', 0).layout), 'R(g1 g2)')

  // A tab that cannot be copied moves down into a group of its own.
  const pulledDown = moveTabToNewGroup(one, 'a', 'g9', 'down')
  eq('a tab moved down gets a group below', layoutShape(pulledDown.layout), 'C(g1 g9)')
  eq('and leaves its old one', pulledDown.groups[0].tabs.map((t) => t.id).join(','), 'b')

  // A divider in a column moves by the column's own fractions.
  const dragged = setBoundary(tee, columnOf(tee.layout)!.id, 0, 0.7)
  eq('a column divider moves its own pair', pct(columnOf(dragged.layout)!.sizes), '70,30')
  eq('and nothing in the row', pct(sizesOf(dragged.layout)), '50,50')
  eq('but never squeezes a group away',
    columnOf(setBoundary(tee, columnOf(tee.layout)!.id, 0, 1).layout)!.sizes[1] > 0.05, true)

  // What reaches disk for a build that reads only a row: each group's share of the width.
  eq('a row writes its own sizes', pct(widthShares(three)), '25,25,50')
  eq('stacked groups share their column\'s width', pct(widthShares(tee)), '33,33,33')
  eq('a lone group writes all of it', pct(widthShares(one)), '100')

  // And what comes back from disk is trusted only as far as it can be checked.
  const grp = (id: string): GroupLayout => ({ kind: 'group', id })
  const saved: GroupLayout = {
    kind: 'split', id: 'x', direction: 'row', sizes: [0.5, 0.5],
    children: [{ kind: 'split', id: 'y', direction: 'column', sizes: [0.6, 0.4], children: [grp('g1'), grp('g3')] }, grp('g2')]
  }
  const restored = restoreLayout(saved, ['g1', 'g3', 'g2'], [1 / 3, 1 / 3, 1 / 3])
  eq('a saved layout comes back as it was', layoutShape(restored), 'R(C(g1 g3) g2)')
  eq('sizes and all', pct(columnOf(restored)!.sizes), '60,40')
  eq('a group that did not survive the read comes out of it',
    layoutShape(restoreLayout(saved, ['g1', 'g2'], [])), 'R(g1 g2)')
  eq('one that it leaves out gives way to a row of them all',
    layoutShape(restoreLayout(saved, ['g1', 'g3', 'g2', 'g4'], [])), 'R(g1 g3 g2 g4)')
  eq('a group named twice keeps its first place',
    layoutShape(restoreLayout({ kind: 'split', id: 'z', direction: 'column', sizes: [0.5, 0.5],
      children: [grp('g2'), { kind: 'split', id: 'w', direction: 'row', sizes: [0.5, 0.5], children: [grp('g1'), grp('g2')] }] },
    ['g1', 'g2'], [])), 'C(g2 g1)')
  eq('a row written inside a row is read as one',
    layoutShape(restoreLayout({ kind: 'split', id: 'v', direction: 'row', sizes: [0.5, 0.5],
      children: [grp('g1'), { kind: 'split', id: 'u', direction: 'row', sizes: [0.5, 0.5], children: [grp('g2'), grp('g3')] }] },
    ['g1', 'g2', 'g3'], [])), 'R(g1 g2 g3)')
  eq('a document from before stacking is the row its sizes describe',
    pct(sizesOf(restoreLayout(undefined, ['g1', 'g2'], [0.3, 0.7]))), '30,70')
  eq('sizes of the wrong length are evened out', pct(sizesOf(restoreLayout(undefined, ['g1', 'g2'], [1]))), '50,50')
  eq('one group is just the group', layoutShape(restoreLayout(undefined, ['g1'], [1])), 'g1')
  eq('nonsense is a row as well',
    layoutShape(restoreLayout({ kind: 'split', direction: 'diagonal', children: 'no' }, ['g1', 'g2'], [])), 'R(g1 g2)')
}

console.log('\nworkspace heat')

{
  // Local-time dates throughout: a day of use is the user's day, not UTC's.
  const at = (y: number, m: number, d: number, h = 10, min = 0): number => new Date(y, m - 1, d, h, min).getTime()
  const T = at(2026, 10, 13)
  eq('a day is its local date', localDay(at(2026, 1, 5, 23, 59)), '2026-01-05')
  eq('and sorts as text', localDay(at(2026, 9, 30)) < localDay(at(2026, 10, 1)), true)

  // Recording.
  eq('a fresh record starts today, empty', JSON.stringify(freshActivity(T)), '{"since":"2026-10-13","days":[]}')
  const one = recordMinute(undefined, 'used', T)
  eq('a first minute starts the record, and says when', JSON.stringify(one),
    `{"since":"2026-10-13","days":[{"day":"2026-10-13","used":1,"output":0}],"usedAt":${T}}`)
  const two = recordMinute(recordMinute(one, 'used', T + 60_000), 'output', T + 90_000)
  eq('minutes on the same day add up', two.days[0].used, 2)
  eq('output is counted apart', two.days[0].output, 1)
  eq('and dated apart', two.outputAt, T + 90_000)
  eq('without moving the time of use', two.usedAt, T + 60_000)
  const next = recordMinute(two, 'used', at(2026, 10, 14))
  eq('a new day goes first', next.days.map((d) => d.day).join(','), '2026-10-14,2026-10-13')
  eq('the day before is left alone', next.days[1].used, 2)
  const back = recordMinute(next, 'used', at(2026, 10, 12))
  eq('a clock put back still files the day in order',
    back.days.map((d) => d.day).join(','), '2026-10-14,2026-10-13,2026-10-12')
  let long: WorkspaceActivity | undefined
  for (let i = 0; i < KEEP_DAYS + 5; i++) long = recordMinute(long, 'used', at(2026, 1, 1) + i * 86_400_000)
  eq('a few weeks are kept, the newest', long!.days.length, KEEP_DAYS)
  eq('…dropping from the old end', long!.days[0].day > long!.days[KEEP_DAYS - 1].day, true)

  // The clock counts days of use.
  const rec = (days: Array<[string, number, number?]>, since = days[days.length - 1]?.[0] ?? '2026-10-13'): WorkspaceActivity => ({
    since,
    days: days.map(([day, used, output = 0]) => ({ day, used, output }))
  })
  eq('today is always a day of use', activityClock([], '2026-10-13').join(','), '2026-10-13')
  eq('every workspace\'s days of use make the clock, newest first, once each',
    activityClock([rec([['2026-10-10', 3]]), rec([['2026-10-11', 1], ['2026-10-10', 9]])], '2026-10-13').join(','),
    '2026-10-13,2026-10-11,2026-10-10')
  eq('a day a terminal printed on its own is not one',
    activityClock([rec([['2026-10-12', 0, 400], ['2026-10-01', 5]])], '2026-10-13').join(','), '2026-10-13,2026-10-01')
  eq('nor is a day from a clock that ran ahead', activityClock([rec([['2026-11-01', 5]])], '2026-10-13').join(','), '2026-10-13')
  const clock = ['2026-10-13', '2026-10-09', '2026-10-02']
  eq('today is age 0', ageOf('2026-10-13', clock), 0)
  eq('a day between days of use is as old as those after it', ageOf('2026-10-05', clock), 2)

  // Heat.
  eq('a minute today is worth a minute', heatOf(rec([['2026-10-13', 60]]), ['2026-10-13']), 60)
  eq('a day of use ago, three quarters', heatOf(rec([['2026-10-12', 60]]), ['2026-10-13', '2026-10-12']), 45)
  eq('a fortnight away costs a single day', heatOf(rec([['2026-09-28', 60]]), ['2026-10-13', '2026-09-28']), 45)
  eq('a terminal printing all day on its own stops short of hot',
    heatOf(rec([['2026-10-13', 0, 480]]), ['2026-10-13']), OUTPUT_CEILING)
  check('…which is warm', temperatureOf(rec([['2026-10-13', 0, 480]]), ['2026-10-13']) === 'warm')
  eq('output adds to use, a tenth as much', heatOf(rec([['2026-10-13', 30, 100]]), ['2026-10-13']), 40)
  eq('no record has no heat', heatOf(undefined, ['2026-10-13']), 0)

  // Temperature.
  const today = ['2026-10-13']
  eq('hot from HOT', temperatureOf(rec([['2026-10-13', HOT]]), today), 'hot')
  eq('warm just below it', temperatureOf(rec([['2026-10-13', HOT - 1]]), today), 'warm')
  eq('warm from WARM', temperatureOf(rec([['2026-10-13', WARM]]), today), 'warm')
  eq('cool just below it', temperatureOf(rec([['2026-10-13', WARM - 1]]), today), 'cool')
  eq('no record is cool, not cold', temperatureOf(undefined, today), 'cool')
  const days = (n: number): string[] => Array.from({ length: n + 1 }, (_, i) => localDay(at(2026, 10, 13) - i * 86_400_000))
  const used = days(COLD_AFTER)
  eq(`nothing for ${COLD_AFTER} days of use is cold`, temperatureOf(rec([[used[COLD_AFTER], 5]]), used), 'cold')
  eq('one day fewer is not', temperatureOf(rec([[used[COLD_AFTER - 1], 5]]), used), 'cool')
  eq('cold goes by recency, however busy it once was',
    temperatureOf(rec([[used[COLD_AFTER], 5000]]), used), 'cold')
  eq('a workspace that has just appeared is not cold, whatever the clock says',
    temperatureOf(freshActivity(at(2026, 10, 13)), used), 'cool')
  eq('nor one that was there all along, from the day heat arrived', temperatureOf({ since: used[3], days: [] }, used), 'cool')
  eq(`…until ${COLD_AFTER} days of use pass with nothing in it`, temperatureOf({ since: used[COLD_AFTER], days: [] }, used), 'cold')
  eq('a terminal printing keeps it from going cold',
    temperatureOf(rec([['2026-10-13', 0, 30], [used[COLD_AFTER], 50]]), used), 'cool')
  eq('when anything last happened, whichever kind', lastActiveAt({ since: '2026-10-13', usedAt: 5, outputAt: 9, days: [] }), 9)
  eq('never is null', lastActiveAt(freshActivity(T)), null)

  // Ordering.
  const w = (id: string, temperature: Warmth['temperature'], heat: number, lastActive = 0): Warmth & { id: string } =>
    ({ id, temperature, heat, lastActive })
  const sorted = [w('cold-old', 'cold', 900, 1), w('cool', 'cool', 2, 5), w('hot', 'hot', 50, 3),
    w('cold-new', 'cold', 0, 9), w('tie-a', 'cool', 2, 5), w('warm', 'warm', 9, 1)].sort(compareWarmth)
  eq('hottest first, cold last, recent first among the cold, ties as they were',
    sorted.map((x) => x.id).join(','), 'hot,warm,cool,tie-a,cold-new,cold-old')
  eq('equal heat goes to the more recent',
    [w('a', 'cool', 3, 1), w('b', 'cool', 3, 2)].sort(compareWarmth).map((x) => x.id).join(','), 'b,a')

  // Holding the order under the pointer.
  const held = { recent: ['a', 'b', 'c'], cold: ['x', 'y'] }
  const kept = holdRanking(held, { recent: ['c', 'b', 'a', 'x'], cold: ['y'] })
  eq('a held list keeps its order', kept.recent.join(','), 'a,b,c')
  eq('one warmed up while held stays where it was', kept.cold.join(','), 'x,y')
  const moved = holdRanking(held, { recent: ['new', 'c', 'a'], cold: ['y'] })
  eq('one added since goes at the end', moved.recent.join(','), 'a,c,new')
  eq('one removed since is gone', moved.cold.join(','), 'y')

  // Time ago.
  const m = 60_000
  eq('under a minute is now', shortAgo(T - 59_000, T), 'now')
  eq('a clock behind is now too', shortAgo(T + 5 * m, T), 'now')
  eq('minutes', shortAgo(T - 5 * m, T), '5m')
  eq('hours', shortAgo(T - 3 * 60 * m, T), '3h')
  eq('days', shortAgo(T - 13 * 1440 * m, T), '13d')
  eq('weeks from two', shortAgo(T - 14 * 1440 * m, T), '2w')
  eq('months from two', shortAgo(T - 61 * 1440 * m, T), '2mo')
  eq('years', shortAgo(T - 400 * 1440 * m, T), '1y')
  eq('in words', longAgo(T - 3 * 7 * 1440 * m, T), '3 weeks ago')
  eq('one of a unit is singular', longAgo(T - m, T), '1 minute ago')
  eq('and now is just now', longAgo(T, T), 'just now')

  // From disk.
  eq('garbage is nothing', sanitizeActivity('hot'), undefined)
  eq('a list is nothing', sanitizeActivity([]), undefined)
  eq('a record with neither a start nor a day is nothing', sanitizeActivity({ days: 'many' }), undefined)
  const cleaned = sanitizeActivity({
    since: '2026-09-01',
    usedAt: 'yesterday',
    outputAt: 7,
    days: [
      { day: '2026-10-01', used: 3.7, output: -2 },
      { day: '2026-10-05', used: Number.NaN, output: 4 },
      { day: '2026-10-01', used: 99, output: 99 },
      { day: 'Tuesday', used: 1, output: 1 },
      null
    ]
  })
  eq('days come back newest first, once each, counted in whole minutes',
    JSON.stringify(cleaned?.days), '[{"day":"2026-10-05","used":0,"output":4},{"day":"2026-10-01","used":3,"output":0}]')
  eq('a time that is not one is dropped', cleaned?.usedAt, undefined)
  eq('one that is, kept', cleaned?.outputAt, 7)
  eq('no start falls back to the oldest day', sanitizeActivity({ days: [{ day: '2026-10-02', used: 1, output: 0 }] })?.since, '2026-10-02')
}

console.log('\nterminals at work')

{
  const w = freshWatch()
  sawOutput(w, 0)
  sawOutput(w, WORK_MIN_MS - 1)
  eq('printing for under two seconds is a command, not work', printingLikeWork(w, WORK_MIN_MS - 1), false)
  sawOutput(w, WORK_MIN_MS)
  eq('two seconds of it is work', printingLikeWork(w, WORK_MIN_MS), true)
  eq('…and is asked about', wantsCheck(w, WORK_MIN_MS), true)
  notWork(w, WORK_MIN_MS)
  eq('its own shell printing is not asked about again at once', wantsCheck(w, WORK_MIN_MS + 500), false)
  sawOutput(w, WORK_MIN_MS + 3_000)
  eq('…but is a while later, if it keeps on', wantsCheck(w, WORK_MIN_MS + 3_000), true)
  w.working = true
  eq('a pane called working is not asked about', wantsCheck(w, WORK_MIN_MS + 3_100), false)
  const last = WORK_MIN_MS + 3_000
  eq('a pause short of QUIET is not the end of it', hasFinished(w, last + QUIET_MS - 1), false)
  eq('a pause of QUIET is', hasFinished(w, last + QUIET_MS), true)
  eq('it is live until that is noticed', isLive(w, last + QUIET_MS), true)
  w.working = false
  eq('and not after', isLive(w, last + QUIET_MS), false)
  sawOutput(w, last + QUIET_MS + 10)
  eq('printing after a pause starts a new run', w.since, last + QUIET_MS + 10)
  eq('which is not work yet', printingLikeWork(w, last + QUIET_MS + 100), false)
}

{
  // Somebody typing, every 100 ms for three seconds, each key echoed 30 ms later.
  const w = freshWatch()
  for (let t = 0; t <= 3_000; t += 100) {
    sawInput(w, t)
    sawOutput(w, t + 30)
  }
  eq('typing and its echo is not work', printingLikeWork(w, 3_030), false)
  eq('…and does not count as printing at all', w.lastOutput, -Infinity)
  // Enter at 3 s, and the program prints until 6 s.
  for (let t = 3_100; t <= 6_000; t += 100) sawOutput(w, t)
  eq('what it prints once the keys stop is', printingLikeWork(w, 6_000), true)
}

{
  const leaf = (id: string, paneId: string | null): PaneNode => ({ kind: 'leaf', id, paneId })
  const split: PaneNode = {
    kind: 'split', id: 's', direction: 'row', sizes: [1 / 3, 1 / 3, 1 / 3],
    children: [leaf('a', 'p1'), leaf('b', null), leaf('c', 'p2')]
  }
  const terminal = (id: string, root: PaneNode): Tab =>
    ({ id, kind: 'terminal', title: 'terminal', pinned: false, root, activeLeafId: 'a' }) as Tab
  const file: Tab = { id: 'f', kind: 'editor', title: 'f', pinned: false, filePath: '/f', repoId: null, readOnly: false }
  const row = splitGroup(singleGroupRow('g1', [terminal('t1', split), file]), 'g1', 'g2', terminal('t2', leaf('x', 'p3')))
  eq('every pane with a shell, tab by tab from the left, and none without',
    terminalPanes(row).map((p) => `${p.tabId}/${p.leafId}/${p.paneId}`).join(' '), 't1/a/p1 t1/c/p2 t2/x/p3')
  eq('a count, and what it counts, each program once',
    describePanes(2, 'at work', ['claude', 'npm', 'claude', '']), '2 terminals at work — claude, npm')
  eq('one, with nothing to name', describePanes(1, 'finished since you last looked', ['']), '1 terminal finished since you last looked')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
