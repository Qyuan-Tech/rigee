/**
 * Checks for the workspace search engine, against a real fixture on disk.
 *
 *   pnpm search:selftest
 *
 * The one property worth the most is that the three engines AGREE. ripgrep, git grep and the
 * plain walk are each chosen in different situations — ripgrep installed or not, a repository or
 * not — and a search that found different things depending on which machine it ran on would be
 * worse than a slow one. So every query below runs through each engine and the answers are
 * compared line for line, column for column. Columns are checked on Chinese text in particular:
 * ripgrep reports bytes, and a byte offset handed to Monaco puts the highlight in the wrong place.
 */

import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findRipgrep, runSearch, type EngineName } from '../plugins/search/main/engine.ts'
import type { SearchQuery, SearchResult } from '../plugins/search/types.ts'

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

// realpath: on macOS /tmp is a symlink, and git reports resolved paths.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'rigee-search-')))
const repo = join(base, 'repo')
const plain = join(base, 'plain')

function write(path: string, content: string | Buffer): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

write(join(repo, 'src/app.ts'), 'const needle = 1\nconst other = 2\n// needle again, needle twice\n')
write(join(repo, 'src/notes.md'), '这是一个needle测试\n中文needle在这里\n')
write(join(repo, 'src/crlf.txt'), 'first line\r\nthe needle here\r\nlast\r\n')
write(join(repo, 'src/long.min.js'), `${'x'.repeat(5000)}needle${'y'.repeat(5000)}\n`)
write(join(repo, 'src/words.txt'), 'needles and a needle, xneedle, needle_x, 针needle针\n')
write(join(repo, '.github/workflow.yml'), 'name: needle in a hidden folder\n')
write(join(repo, 'untracked.txt'), 'an untracked needle\n')
write(join(repo, 'ignored.log'), 'an ignored needle\n')
write(join(repo, 'node_modules/pkg/index.js'), 'module.exports = "needle"\n')
write(join(repo, 'image.bin'), Buffer.concat([Buffer.from('needle'), Buffer.from([0, 1, 2, 0]), Buffer.from('needle')]))
write(join(repo, '.gitignore'), 'ignored.log\nnode_modules/\nvendored/\n')
write(join(repo, 'vendored/lib/deep.txt'), 'needle in a folder the repository ignores\n')
write(join(repo, 'src/accents.txt'), 'cafe\u0301 and cafe\n')
write(join(repo, 'src/emoji.txt'), 'party 😀 time\n')
write(join(repo, 'src/bom.txt'), '\uFEFFneedle at the very start\n')
write(join(repo, 'src/zh-word.txt'), '中文needle\n')
write(join(repo, 'src/escapes.txt'), 'foo-bar key=val\n')
write(join(repo, 'src/crlf-end.txt'), 'ends with needle\r\nnot this line\r\n')
write(join(repo, 'src/lone-cr.log'), 'progress 10%\rprogress 100% needle\n')
write(join(plain, 'readme.txt'), 'plain folder needle\nNEEDLE in capitals\n')
write(join(plain, 'build.log'), 'ignored by the root gitignore: needle\n')
write(join(plain, '.gitignore'), '*.log\n')
write(join(plain, 'node_modules/x.js'), 'needle\n')

const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }) }
git('init', '-q')
// A submodule: git grep does not go into one, so the engine has to.
const sub = join(base, 'subrepo')
write(join(sub, 'inner.txt'), 'needle inside a submodule\n')
execFileSync('git', ['init', '-q'], { cwd: sub })
execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: sub })
execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'sub'], { cwd: sub })
git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub')
// The user's own git config must not reshape git grep's output.
git('config', 'grep.column', 'true')
git('config', 'grep.fullName', 'true')
// A tracked symlink out of the workspace: listing engines must not follow it.
const outside = join(base, 'outside.txt')
writeFileSync(outside, 'needle beyond the workspace\n')
execSync(`ln -s ${JSON.stringify(outside)} ${JSON.stringify(join(repo, 'src/link.txt'))}`)
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'src', '.github', '.gitignore', 'image.bin')
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture')
// The .git directory itself contains the word, in the commit message and the index.
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'needle in a commit message')

const rg = findRipgrep()
const engines: EngineName[] = rg ? ['ripgrep', 'git', 'node'] : ['git', 'node']
if (!rg) console.log('  (ripgrep is not installed: its checks are skipped)')

async function run(q: Partial<SearchQuery>, engine: EngineName, roots = [repo]): Promise<SearchResult> {
  return runSearch({ roots, pattern: 'needle', caseSensitive: false, wholeWord: false, regex: false, ...q }, new AbortController().signal, { engine })
}

const lit0 = (r: SearchResult): string => flat(r)

/** A result as comparable text: one line per match. */
const flat = (r: SearchResult): string =>
  r.files.flatMap((f) => f.matches.map((m) => `${f.path.slice(base.length)}:${m.line}:${m.column}:${m.length}`)).join('\n')

async function agree(label: string, q: Partial<SearchQuery>, engs: EngineName[] = engines): Promise<SearchResult> {
  const results = await Promise.all(engs.map((e) => run(q, e)))
  const [first, ...rest] = results
  rest.forEach((r, i) => eq(`${label}: ${engs[i + 1]} agrees with ${engs[0]}`, flat(r), flat(first!)))
  return first!
}

console.log('\nsearch engines agree')
{
  const lit = await agree('literal, case-insensitive', {})
  const paths = lit.files.map((f) => f.path.slice(repo.length + 1))
  check('finds the tracked files', paths.includes('src/app.ts') && paths.includes('src/notes.md'), paths.join(','))
  check('finds the untracked file', paths.includes('untracked.txt'), paths.join(','))
  check('searches hidden folders', paths.includes('.github/workflow.yml'), paths.join(','))
  check('skips what .gitignore ignores', !paths.includes('ignored.log'), paths.join(','))
  check('skips node_modules', !paths.some((p) => p.startsWith('node_modules')), paths.join(','))
  check('skips binaries', !paths.includes('image.bin'), paths.join(','))
  check('never searches .git', !paths.some((p) => p.startsWith('.git/') || p === '.git'), paths.join(','))

  const app = lit.files.find((f) => f.path.endsWith('app.ts'))!
  eq('every match on a line is reported', app.matches.filter((m) => m.line === 3).length, 2)
  eq('in column order', app.matches.filter((m) => m.line === 3).map((m) => m.column).join(','), '4,18')

  const zh = lit.files.find((f) => f.path.endsWith('notes.md'))!
  // 这是一个 is four characters: the match starts at UTF-16 column 5, not byte 13.
  eq('columns count characters, not bytes, after Chinese text', zh.matches[0]!.column, 5)
  eq('on the second line too', zh.matches[1]!.column, 3)
  eq('the preview is the line', zh.matches[0]!.preview, '这是一个needle测试')

  const crlf = lit.files.find((f) => f.path.endsWith('crlf.txt'))!
  check('a CRLF line has no \\r in its preview', !crlf.matches[0]!.preview.includes('\r'), JSON.stringify(crlf.matches[0]!.preview))

  const long = lit.files.find((f) => f.path.endsWith('long.min.js'))!.matches[0]!
  eq('a match deep in a long line has its real column', long.column, 5001)
  check('its preview is cut down', long.preview.length < 400, `${long.preview.length} chars`)
  eq('with the match where the preview says', long.preview.slice(long.previewColumn, long.previewColumn + 6), 'needle')

  await agree('case-sensitive', { caseSensitive: true, pattern: 'NEEDLE' })
  const words = await agree('whole word', { wholeWord: true })
  const w = words.files.find((f) => f.path.endsWith('words.txt'))!
  // "needles", "xneedle" and "needle_x" are not the word; "needle" and "针needle针" — CJK letters
  // either side — are not either, by the Unicode-letter rule.
  eq('whole word keeps only the word itself', w.matches.map((m) => m.column).join(','), '15')
  await agree('regex', { regex: true, pattern: 'nee+dle\\s+(again|here)' })
  await agree('regex alternation', { regex: true, pattern: 'needle|other' })
}

console.log('\nsearch: what the last review found')
{
  const bom = await agree('a byte order mark', { pattern: 'needle at the very start' })
  eq('a match right after a BOM is column 1, as Monaco counts', bom.files.find((f) => f.path.endsWith('bom.txt'))?.matches[0]?.column, 1)
  const anchored = await agree('^ after a BOM', { regex: true, pattern: '^needle at' })
  check('^ matches line 1 of a file with a BOM', anchored.files.some((f) => f.path.endsWith('bom.txt')))

  const zh = await agree('\\b beside Chinese text', { regex: true, pattern: '\\bneedle' })
  check('JavaScript\'s ASCII \\b finds needle after 中文, and ripgrep does not filter it away',
    zh.files.some((f) => f.path.endsWith('zh-word.txt')), flat(zh))

  const esc = await agree('escaped punctuation', { regex: true, pattern: 'foo\\-bar key\\=val' })
  eq('an unnecessary escape like \\- is accepted, as in every other dialect', esc.matchCount, 1)

  const eol = await agree('$ before CRLF', { regex: true, pattern: 'needle$' })
  check('$ matches before a Windows line ending', eol.files.some((f) => f.path.endsWith('crlf-end.txt')), flat(eol))

  const cr = await agree('a lone carriage return', { pattern: '100% needle' })
  check('a match after a lone \\r is found by every engine', cr.files.some((f) => f.path.endsWith('lone-cr.log')), flat(cr))

  const subs = await agree('inside a submodule', { pattern: 'needle inside a submodule' })
  check('files in a submodule are searched', subs.files.some((f) => f.path.endsWith('inner.txt')), flat(subs))
  check('with grep.column and grep.fullName set, columns are still right',
    lit0(await run({}, 'git')).includes('/repo/src/app.ts:1:7:6'))

  const nested = await runSearch(
    { roots: [repo, join(repo, 'src')], pattern: 'needle', caseSensitive: false, wholeWord: false, regex: false },
    new AbortController().signal
  )
  const single = await run({}, engines[0]!)
  eq('a folder inside another is searched once, not twice', nested.matchCount, single.matchCount)

  // git has nothing to say about a folder that is not a repository; ripgrep and the walk must agree.
  if (rg) {
    const [viaRg, viaWalk] = await Promise.all([run({}, 'ripgrep', [plain]), run({}, 'node', [plain])])
    eq('outside a repository, ripgrep honours .gitignore and skips node_modules as the walk does', flat(viaRg), flat(viaWalk))
  }
}

console.log('\nsearch: the final review')
{
  const lib = join(repo, 'vendored/lib')
  for (const engine of engines) {
    const r = await run({ pattern: 'repository ignores' }, engine, [repo, lib])
    eq(`${engine}: a folder added on purpose is searched even though its repository ignores it`, r.matchCount, 1)
  }
  const nm = join(repo, 'node_modules/pkg')
  for (const engine of engines.filter((e) => e !== 'git')) {
    const r = await run({ pattern: 'module.exports' }, engine, [nm])
    eq(`${engine}: a folder inside node_modules, added as a folder of its own, is searched`, r.matchCount, 1)
  }
  const word = await agree('whole word and combining marks', { wholeWord: true, pattern: 'cafe' })
  eq('the "cafe" inside a decomposed "café" is not a whole word; the plain one is',
    word.files.find((f) => f.path.endsWith('accents.txt'))?.matches.map((m) => m.column).join(','), '11')
  // ripgrep refuses `\😀`; left to choose, the search falls through to an engine that takes it.
  const emoji = await runSearch({ roots: [repo], pattern: '\\😀', caseSensitive: false, wholeWord: false, regex: true }, new AbortController().signal)
  eq('an escaped character outside the BMP still matches', emoji.matchCount, 1)
  await agree('an escaped emoji, without ripgrep', { regex: true, pattern: '\\😀' }, engines.filter((e) => e !== 'ripgrep'))
  const links = await Promise.all(engines.map((e) => run({ regex: true, pattern: 'beyond the \\w+' }, e)))
  links.forEach((r, i) => eq(`${engines[i]}: a tracked symlink is not followed out of the workspace`, r.matchCount, 0))
}

console.log('\nsearch edge cases')
{
  const bad = await run({ regex: true, pattern: 'needle(' }, engines[0]!)
  check('an invalid regex is an error, not a crash', !!bad.error && bad.files.length === 0, bad.error ?? '')

  // A lookbehind is JavaScript but not ripgrep's dialect nor git's ERE: another engine answers.
  const behind = await runSearch(
    { roots: [repo], pattern: '(?<=const )needle', caseSensitive: true, wholeWord: false, regex: true },
    new AbortController().signal
  )
  eq('a regex only JavaScript understands still finds its match', flat(behind), '/repo/src/app.ts:1:7:6')

  const capped = await run({ maxResults: 3 }, engines[0]!)
  check('maxResults stops the search and says so', capped.matchCount === 3 && capped.truncated, `${capped.matchCount} ${capped.truncated}`)

  const walked = await run({}, 'node', [plain])
  const names = walked.files.map((f) => f.path.slice(plain.length + 1))
  eq('the walk honours the root .gitignore and skips node_modules', names.join(','), 'readme.txt')
  eq('and finds both cases', walked.matchCount, 2)

  const mixed = await runSearch(
    { roots: [repo, plain, join(base, 'missing')], pattern: 'needle', caseSensitive: false, wholeWord: false, regex: false },
    new AbortController().signal
  )
  check('several roots at once', mixed.files.some((f) => f.root === plain) && mixed.files.some((f) => f.root === repo))
  check('a missing folder is reported, not fatal', !!mixed.error && mixed.matchCount > 0, mixed.error ?? '')
}

console.log('\nsearch abort')
{
  // Enough files that a search is still running when it is aborted.
  const big = join(base, 'big')
  for (let d = 0; d < 40; d++) {
    for (let f = 0; f < 50; f++) write(join(big, `d${d}`, `f${f}.txt`), `${'filler line\n'.repeat(200)}needle\n`)
  }
  for (const engine of ['node', ...(rg ? ['ripgrep'] : [])] as EngineName[]) {
    const controller = new AbortController()
    const t0 = performance.now()
    const pending = runSearch({ roots: [big], pattern: 'needle', caseSensitive: false, wholeWord: false, regex: false }, controller.signal, { engine })
    setTimeout(() => controller.abort(), 5)
    const result = await pending
    const ms = performance.now() - t0
    check(`${engine}: an aborted search comes back promptly`, ms < 3000, `${Math.round(ms)} ms`)
    check(`${engine}: with fewer than every match`, result.matchCount < 2000, `${result.matchCount}`)
  }
  let survivors = ''
  try { survivors = execSync(`pgrep -f "${big}" || true`, { encoding: 'utf8' }).trim() } catch { /* none */ }
  eq('no search process outlives its abort', survivors, '')
}

rmSync(base, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
