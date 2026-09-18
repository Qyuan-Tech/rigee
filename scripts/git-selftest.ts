/**
 * Integration self-test for the source control service, against a real git binary and a fixture
 * repository built from scratch in /tmp.
 *
 *   pnpm git:selftest
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { GitService } from '../src/main/git/service.ts'
import { parsePorcelainV2 } from '../src/main/git/status.ts'

const DIR = '/tmp/onestop-git-selftest'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await sleep(50)
  }
  return pred()
}

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

function sh(cmd: string, args: string[], cwd = DIR): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' })
}
const g = (...args: string[]): string => sh('git', args)

// ---------------------------------------------------------------------------

function unitTests(): void {
  console.log('\nporcelain v2 parser')

  // The rename trap: the original path is a SEPARATE NUL field after the '2' record. A parser
  // that only splits on NUL sees it as a record starting with 'o'.
  {
    const wire = [
      '# branch.oid abc123',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '# stash 3',
      '1 M. N... 100644 100644 100644 aaa bbb staged.txt',
      '1 .M N... 100644 100644 100644 aaa bbb dirty.txt',
      '1 MM N... 100644 100644 100644 aaa bbb both.txt',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt',
      'old name.txt',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
      '? untracked.txt',
      '? newdir/'
    ].join('\0') + '\0'

    const p = parsePorcelainV2(Buffer.from(wire, 'utf8'))
    eq('branch', p.branch, 'main')
    eq('upstream', p.upstream, 'origin/main')
    eq('ahead', p.ahead, 2)
    eq('behind', p.behind, 1)
    eq('stash count', p.stashCount, 3)
    // staged.txt, both.txt, and the rename
    eq('staged count', p.staged.length, 3)
    eq('unstaged count', p.unstaged.length, 2) // dirty.txt, both.txt
    eq('conflicts', p.conflicts.length, 1)
    eq('untracked count', p.untracked.length, 2)

    const ren = p.staged.find((f) => f.path === 'new name.txt')
    check('rename record parsed', !!ren, JSON.stringify(p.staged.map((f) => f.path)))
    eq('rename origPath consumed as its own field', ren?.origPath, 'old name.txt')
    eq('rename score', ren?.score, 100)
    check('origPath did not leak in as a record',
      !p.untracked.some((f) => f.path.startsWith('old')), JSON.stringify(p.untracked))
    check('path with a space survived', p.staged.some((f) => f.path === 'new name.txt'))
    check('collapsed untracked dir kept its slash', p.untracked.some((f) => f.path === 'newdir/'))
  }

  // Detached HEAD has no branch name; the oid is what the UI shows instead.
  {
    const p = parsePorcelainV2(
      Buffer.from(['# branch.oid deadbeefcafe', '# branch.head (detached)'].join('\0') + '\0', 'utf8')
    )
    eq('detached branch is null', p.branch, null)
    eq('detached oid shown', p.detachedAt, 'deadbeef')
    eq('no upstream means no ahead/behind', p.ahead + p.behind, 0)
  }
}

// ---------------------------------------------------------------------------

async function liveTests(): Promise<void> {
  console.log('\nlive git')
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })

  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 'selftest@onestop.local')
  g('config', 'user.name', 'onestop selftest')
  g('config', 'commit.gpgsign', 'false')

  writeFileSync(join(DIR, 'a.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(DIR, 'keep.txt'), 'keep\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'initial')

  const svc = new GitService()
  try {
    // clean
    let st = await svc.status(DIR)
    eq('branch reported', st.branch, 'main')
    eq('clean repo has no changes', st.staged.length + st.unstaged.length + st.untracked.length, 0)
    eq('no operation in progress', st.operation, 'none')

    // worktree edit + a new file
    writeFileSync(join(DIR, 'a.txt'), 'one\nTWO\nthree\n')
    writeFileSync(join(DIR, 'b.txt'), 'brand new\n')
    st = await svc.status(DIR)
    eq('one unstaged edit', st.unstaged.map((f) => f.path).join(','), 'a.txt')
    eq('one untracked', st.untracked.map((f) => f.path).join(','), 'b.txt')

    // diff: worktree vs index
    const d1 = await svc.diff(DIR, 'a.txt', { kind: 'worktree-vs-index' })
    check('diff original is the committed text', d1.original === 'one\ntwo\nthree\n', JSON.stringify(d1.original))
    check('diff modified is the file on disk', d1.modified === 'one\nTWO\nthree\n', JSON.stringify(d1.modified))

    // stage, then the staged diff must be visible and the unstaged one gone
    await svc.stage(DIR, ['a.txt'])
    st = await svc.status(DIR)
    eq('staged after stage()', st.staged.map((f) => f.path).join(','), 'a.txt')
    eq('nothing left unstaged', st.unstaged.length, 0)
    const d2 = await svc.diff(DIR, 'a.txt', { kind: 'index-vs-head' })
    check('index-vs-head shows the staged edit', d2.modified === 'one\nTWO\nthree\n')

    // unstage round-trips
    await svc.unstage(DIR, ['a.txt'])
    st = await svc.status(DIR)
    eq('unstage moved it back', st.unstaged.map((f) => f.path).join(','), 'a.txt')
    eq('nothing staged', st.staged.length, 0)

    // deletion must stage too — `git add <path>` alone would not do this, `-A` does
    g('rm', '-q', 'keep.txt')
    st = await svc.status(DIR)
    check('deletion is staged by rm', st.staged.some((f) => f.path === 'keep.txt' && f.index === 'D'),
      JSON.stringify(st.staged))
    g('reset', '-q', 'HEAD', '--', 'keep.txt')
    rmSync(join(DIR, 'keep.txt'), { force: true })
    await svc.stage(DIR, ['keep.txt'])
    st = await svc.status(DIR)
    check('stage() stages a deletion', st.staged.some((f) => f.path === 'keep.txt' && f.index === 'D'),
      JSON.stringify(st.staged))

    // commit: message on stdin, and the recorded subject is re-read rather than echoed
    await svc.stage(DIR, ['a.txt', 'b.txt'])
    const { sha } = await svc.commit(DIR, 'subject line\n\nbody paragraph\n', false)
    check('commit returned a sha', /^[0-9a-f]{40}$/.test(sha), sha)
    const recorded = g('log', '-1', '--format=%B').trim()
    eq('subject and body preserved verbatim', recorded, 'subject line\n\nbody paragraph')
    st = await svc.status(DIR)
    eq('tree clean after commit', st.staged.length + st.unstaged.length + st.untracked.length, 0)

    // rename detection, end to end
    g('mv', 'a.txt', 'renamed.txt')
    st = await svc.status(DIR)
    const ren = st.staged.find((f) => f.path === 'renamed.txt')
    check('rename detected', !!ren && ren.origPath === 'a.txt',
      JSON.stringify(st.staged.map((f) => [f.path, f.origPath])))
    g('reset', '-q', '--hard', 'HEAD')

    // discard: tracked file restored, untracked file removed
    writeFileSync(join(DIR, 'a.txt'), 'clobbered\n')
    writeFileSync(join(DIR, 'junk.txt'), 'junk\n')
    await svc.discard(DIR, ['a.txt', 'junk.txt'])
    eq('tracked file restored', readFileSync(join(DIR, 'a.txt'), 'utf8'), 'one\nTWO\nthree\n')
    st = await svc.status(DIR)
    eq('untracked file cleaned', st.untracked.length, 0)
    eq('worktree clean after discard', st.unstaged.length, 0)

    // binary is reported, not rendered
    writeFileSync(join(DIR, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]))
    g('add', '-A'); g('commit', '-q', '-m', 'binary')
    writeFileSync(join(DIR, 'bin.dat'), Buffer.from([0x00, 0x09, 0x09, 0x00, 0x04]))
    const dbin = await svc.diff(DIR, 'bin.dat', { kind: 'worktree-vs-index' })
    check('binary file flagged', dbin.binary, JSON.stringify(dbin))

    // a symlink is a typechange, not a modification
    rmSync(join(DIR, 'b.txt'), { force: true })
    symlinkSync('a.txt', join(DIR, 'b.txt'))
    st = await svc.status(DIR)
    check('typechange surfaces', st.unstaged.some((f) => f.path === 'b.txt'),
      JSON.stringify(st.unstaged.map((f) => [f.path, f.worktree])))
    g('checkout', '--', 'b.txt')

    // merge conflict is detected as an operation and the path lands in conflicts
    g('checkout', '-q', '-b', 'side')
    writeFileSync(join(DIR, 'a.txt'), 'side\n'); g('commit', '-qam', 'side')
    g('checkout', '-q', 'main')
    writeFileSync(join(DIR, 'a.txt'), 'main\n'); g('commit', '-qam', 'main')
    try { g('merge', 'side') } catch { /* expected to conflict */ }
    st = await svc.status(DIR)
    eq('operation is merge', st.operation, 'merge')
    check('conflicted path listed', st.conflicts.some((f) => f.path === 'a.txt'),
      JSON.stringify(st.conflicts))
    g('merge', '--abort')
    st = await svc.status(DIR)
    eq('operation clears after abort', st.operation, 'none')
    // --- watching -------------------------------------------------------
    // Reset to a clean, non-conflicted tree first.
    g('reset', '-q', '--hard', 'HEAD')

    const seen: string[] = []
    await svc.watch([DIR], (s2) => {
      seen.push(`${s2.unstaged.length}u/${s2.staged.length}s/${s2.untracked.length}?`)
    })

    // Settle, then confirm the watcher is quiet when nothing happens. This is the feedback-loop
    // check: git's fsmonitor cookie files are created and deleted by every status we run
    // ourselves, so watching them would refresh forever.
    await sleep(900)
    seen.length = 0
    await svc.status(DIR)
    await sleep(900)
    eq('idle watcher fires nothing, even while we poll status', seen.length, 0)

    // A worktree write must push a status without anyone asking.
    writeFileSync(join(DIR, 'watched.txt'), 'hello\n')
    const gotWorktree = await waitFor(() => seen.length > 0, 4000)
    check('worktree write pushes a status', gotWorktree, JSON.stringify(seen))

    // Staging from outside the service — as the user's own terminal would — must also push.
    seen.length = 0
    g('add', 'watched.txt')
    const gotIndex = await waitFor(() => seen.some((x) => x.includes('1s')), 4000)
    check('external git add pushes a status', gotIndex, JSON.stringify(seen))

    // A burst must collapse, not produce one refresh per file.
    seen.length = 0
    for (let i = 0; i < 200; i++) writeFileSync(join(DIR, `burst-${i}.txt`), 'x')
    await sleep(1500)
    check('200 writes collapse into a handful of refreshes', seen.length > 0 && seen.length <= 4,
      `${seen.length} refreshes`)
  } finally {
    svc.dispose()
    rmSync(DIR, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  unitTests()
  try {
    await liveTests()
  } catch (err) {
    failures++
    console.log('  FAIL live tests threw —', err instanceof Error ? err.message : err)
  }
  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
