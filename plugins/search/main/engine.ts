import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { lstat, open, readdir, readFile } from 'node:fs/promises'
import { delimiter, join, relative, resolve, sep } from 'node:path'
import type { Locale, Translator } from '@rigee/plugin-api/l10n'
import { translatorFor } from './l10n'
import { MAX_RESULTS, type SearchFileResult, type SearchMatch, type SearchQuery, type SearchResult } from '../types'

/**
 * Finding text in every file of a workspace.
 *
 * Three engines, tried in order of how well they know what NOT to search:
 *
 *  - **ripgrep**, when it is installed: fast, and it reads .gitignore, .ignore and the rest the
 *    way a developer expects, in and out of repositories.
 *  - **git grep**, in a repository, when ripgrep is not there: it knows exactly which files git
 *    ignores, and with --untracked it still finds the new file you have not added yet.
 *  - **a plain walk**, for a folder that is neither: node_modules and the like skipped by name,
 *    the root .gitignore's simple patterns honoured, binaries and huge files left alone.
 *
 * Whichever engine finds a line, JAVASCRIPT decides what matched in it and where. That is what
 * keeps the three agreeing — ripgrep's regex dialect, git's POSIX one and V8's differ at the edges
 * — and it is what makes the columns right: ripgrep counts bytes, git counts bytes, and Monaco
 * counts UTF-16 code units. In a line of Chinese those are three different numbers for the same
 * character. An engine is only ever a filter for lines worth looking at; a line it offers that the
 * JS expression does not match is dropped.
 */

export type EngineName = 'ripgrep' | 'git' | 'node'

/**
 * Run one search. Resolves with what was found — never rejects for a folder it could not read or a
 * pattern that does not compile; those come back as `error`. An aborted search resolves too, with
 * whatever it had, so a superseded keystroke's search costs nothing to throw away.
 *
 * `locale` is the language of what the engine notes itself, a folder it could not read; English if
 * none is given. What ripgrep, git, V8 and the OS report is passed on in their own words.
 */
export async function runSearch(
  query: SearchQuery,
  signal: AbortSignal,
  options: { engine?: EngineName; rgPath?: string | null; locale?: Locale } = {}
): Promise<SearchResult> {
  const started = performance.now()
  const { t } = translatorFor(options.locale ?? 'en')
  const found = new Collector(query.maxResults ?? MAX_RESULTS)
  const done = (engine: EngineName, error?: string): SearchResult => ({
    files: found.files(),
    matchCount: found.count,
    truncated: found.full,
    engine,
    elapsedMs: Math.round(performance.now() - started),
    ...(error ? { error } : {})
  })

  let matcher: RegExp
  try {
    matcher = buildMatcher(query)
  } catch (err) {
    return done(options.engine ?? 'node', err instanceof Error ? err.message : String(err))
  }
  // Every folder is searched, nested ones included — the outer folder's ignore rules may well skip
  // the inner one (a git worktree under .worktrees/, a library under node_modules/ added on purpose
  // to read it). A file reached through two of them is counted once; see Collector.claim.
  query = { ...query, roots: [...new Set(query.roots.map((r) => resolve(r)))] }

  const rg = options.engine && options.engine !== 'ripgrep' ? null : (options.rgPath ?? findRipgrep())
  if (options.engine === 'ripgrep' && !rg) return done('ripgrep', t('ripgrep is not installed'))

  let error: string | undefined
  const note = (message: string): void => { error ??= message }

  if (rg) {
    const ok = await searchWithRipgrep(rg, query, matcher, found, signal, note, t)
    // ripgrep's dialect refused a pattern V8 accepts — a lookbehind, say. The other engines filter
    // less cleverly but understand it, so fall through to them rather than report nothing.
    if (ok || options.engine === 'ripgrep') return done('ripgrep', error)
    error = undefined
  }

  let usedGit = false
  // Submodules are found as the search goes, and appended: git grep does not go into them. Each is
  // searched as a folder of its own but reported under the workspace folder it sits in, as the
  // other engines report it.
  const queue = query.roots.map((dir) => ({ dir, root: dir }))
  for (const { dir, root } of queue) {
    if (signal.aborted || found.full) break
    if (!isDirectory(dir)) {
      note(t('cannot read {dir}', { dir }))
      continue
    }
    // A folder its own repository ignores — a worktree under .worktrees/, a library under
    // node_modules/, added to the workspace on purpose — would come back empty from git, which
    // honours that ignore. The walk searches it.
    const inRepository = options.engine !== 'node' && (await isGitWorkTree(dir))
    const viaGit = inRepository && !(await ignoredByRepository(dir))
    if (options.engine === 'git' && !inRepository) {
      note(t('{dir} is not a git repository', { dir }))
      continue
    }
    if (viaGit && (await searchWithGit(dir, root, query, matcher, found, signal, note))) {
      usedGit = true
      queue.push(...submodules(dir).map((sub) => ({ dir: sub, root })))
      continue
    }
    await searchWithWalk(dir, root, matcher, found, signal, note)
  }
  return done(usedGit ? 'git' : 'node', error)
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * One expression for the whole search. Throws, with V8's message, when a regex does not compile.
 *
 * Whole word is lookarounds on Unicode letters, digits and underscore rather than `\b`, which in
 * JavaScript only knows ASCII — `\bfoo\b` would call the "foo" in "éfoo" a word. The `u` flag so
 * that a character outside the BMP is one character, and case folding is Unicode's.
 */
export function buildMatcher(query: Pick<SearchQuery, 'pattern' | 'regex' | 'wholeWord' | 'caseSensitive'>): RegExp {
  let source = query.regex ? unicodeSafeEscapes(query.pattern) : query.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Unicode's word characters, as ripgrep's -w counts them: letters, combining marks (the vowel
  // signs of Devanagari, the accent in a decomposed é), digits, connector punctuation, and the
  // zero-width joiners.
  if (query.wholeWord) source = `(?<![${WORD}])(?:${source})(?![${WORD}])`
  return new RegExp(source, query.caseSensitive ? 'gu' : 'giu')
}

const WORD = '\\p{L}\\p{M}\\p{N}\\p{Pc}\\u200C\\u200D'

/**
 * `foo\-bar`, `href=\"`, `key\=val`: escaping punctuation that needs no escape is second nature,
 * every other regex dialect allows it — ripgrep's included — and the `u` flag forbids it. Each such
 * escape becomes the same character as a hex escape, which means the same inside a character
 * class and out of it. Real escapes (`\d`, `\\`, `\.`) are left exactly as they are.
 */
function unicodeSafeEscapes(pattern: string): string {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c !== '\\' || i === pattern.length - 1) {
      out += c
      continue
    }
    // The whole character, which outside the BMP is two code units.
    const cp = pattern.codePointAt(i + 1)!
    const next = String.fromCodePoint(cp)
    i += next.length
    if (/[A-Za-z0-9^$\\.*+?()[\]{}|/]/.test(next)) out += c + next
    else out += `\\u{${cp.toString(16)}}`
  }
  return out
}

/** Every match in one line, as UTF-16 offsets. An empty match advances rather than looping. */
function matchesIn(matcher: RegExp, line: string): Array<{ index: number; length: number }> {
  const out: Array<{ index: number; length: number }> = []
  matcher.lastIndex = 0
  for (let m = matcher.exec(line); m; m = matcher.exec(line)) {
    if (m[0].length === 0) {
      // `^` or `a*` match nothing, everywhere. Nobody searching means that; skip past it.
      matcher.lastIndex += line.codePointAt(matcher.lastIndex)! > 0xffff ? 2 : 1
      if (matcher.lastIndex > line.length) break
      continue
    }
    out.push({ index: m.index, length: m[0].length })
  }
  return out
}

const PREVIEW = 250
const LEAD = 60

/** A long line cut to a window around the match, so a minified file does not become the panel. */
function preview(line: string, index: number, length: number): { preview: string; previewColumn: number } {
  if (line.length <= PREVIEW) return { preview: line, previewColumn: index }
  let start = Math.max(0, index - LEAD)
  const end = Math.min(line.length, Math.max(start + PREVIEW, index + length))
  if (end - start < PREVIEW) start = Math.max(0, end - PREVIEW)
  const head = start > 0 ? '…' : ''
  return {
    preview: head + line.slice(start, end) + (end < line.length ? '…' : ''),
    previewColumn: index - start + head.length
  }
}

/** Results as they arrive, up to the cap. `add` answers false once the cap is reached. */
class Collector {
  private readonly byPath = new Map<string, SearchFileResult>()
  /** Where each file's matches are, so a file reached through two nested folders counts once. */
  private readonly seen = new Map<string, Set<string>>()
  private readonly read = new Set<string>()
  count = 0
  full = false

  constructor(private readonly max: number) {}

  /** True the first time a file is offered for reading, false after — for the engines that read. */
  firstVisit(path: string): boolean {
    if (this.read.has(path)) return false
    this.read.add(path)
    return true
  }

  /** Offer one line; keeps every match the expression finds in it. */
  line(root: string, path: string, lineNumber: number, text: string, matcher: RegExp): boolean {
    if (this.full) return false
    let clean = text.endsWith('\r') ? text.slice(0, -1) : text
    // Monaco keeps a byte order mark beside the text rather than in it, so a column counted with it
    // would be one to the right of where the editor puts the character. ripgrep drops it already.
    if (lineNumber === 1 && clean.startsWith('\uFEFF')) clean = clean.slice(1)
    let seen = this.seen.get(path)
    if (!seen) this.seen.set(path, (seen = new Set()))
    for (const { index, length } of matchesIn(matcher, clean)) {
      const at = `${lineNumber}:${index}`
      if (seen.has(at)) continue
      if (this.count >= this.max) {
        this.full = true
        return false
      }
      seen.add(at)
      let file = this.byPath.get(path)
      if (!file) this.byPath.set(path, (file = { path, root, matches: [] }))
      const match: SearchMatch = { line: lineNumber, column: index + 1, length, ...preview(clean, index, length) }
      file.matches.push(match)
      this.count++
    }
    return true
  }

  files(): SearchFileResult[] {
    const files = [...this.byPath.values()]
    // Code-unit order, not the locale's: the same list on every machine, every time.
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    for (const f of files) f.matches.sort((a, b) => a.line - b.line || a.column - b.column)
    return files
  }
}

// ---------------------------------------------------------------------------
// ripgrep
// ---------------------------------------------------------------------------

let ripgrep: string | null | undefined

/**
 * `rg` on PATH, or null. Asked once: PATH is repaired at startup (ensureShellPath) before any
 * plugin runs, and a ripgrep installed while the app is open can wait for the next launch.
 */
export function findRipgrep(): string | null {
  if (ripgrep !== undefined) return ripgrep
  // On Windows only a real executable: a .cmd or .bat cannot be spawned without a shell.
  const names = process.platform === 'win32' ? ['rg.exe', 'rg.com'] : ['rg']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      try {
        if (!statSync(candidate).isFile()) continue
        if (process.platform !== 'win32') accessSync(candidate, constants.X_OK)
        return (ripgrep = candidate)
      } catch { /* not here */ }
    }
  }
  return (ripgrep = null)
}

/**
 * False when ripgrep could not run this pattern at all, so the caller can try another engine.
 * Everything ripgrep finds is only a candidate line; see the top of the file. `t` is for what this
 * notes in its own words, rather than ripgrep's.
 */
function searchWithRipgrep(
  rg: string,
  query: SearchQuery,
  matcher: RegExp,
  found: Collector,
  signal: AbortSignal,
  note: (message: string) => void,
  t: Translator['t']
): Promise<boolean> {
  const roots = query.roots.filter((root) => {
    if (isDirectory(root)) return true
    note(t('cannot read {dir}', { dir: root }))
    return false
  })
  if (roots.length === 0) return Promise.resolve(true)

  const filters = [
    '--no-config',
    // Dotfiles are searched — .github, .env.example — but never the repository's own database, and
    // not the dependency folders the walk skips: without these a folder that is not a repository
    // yet would be flooded with node_modules. --no-require-git so a .gitignore is honoured there too.
    '--hidden',
    '--no-require-git',
    // Only ignore files inside the folders being searched. One further up — outside the workspace,
    // or an outer folder's .gitignore listing `.worktrees/` — must not hide a folder the user added
    // to the workspace precisely to search it.
    '--no-ignore-parent',
    ...[...SKIP_DIRS].flatMap((dir) => ['--glob', `!${dir}`]),
    '--max-filesize',
    '5M'
  ]

  // ripgrep only narrows the search down to lines worth looking at — and it must never narrow away
  // a line JavaScript would match. Where its class is SMALLER than JavaScript's, it would: its \b
  // and \B know Unicode words (`\bfoo` right after Chinese text is a boundary to JavaScript, not to
  // ripgrep), its \W and \D leave out letters and digits outside ASCII that JavaScript's include,
  // its \s leaves out U+FEFF, and the same goes for \w or \d inside a negated class. Its \w, \d
  // and \S are LARGER, which is harmless — JavaScript drops the extra lines. For the risky ones,
  // ripgrep lists the files, honouring every ignore rule, and JavaScript reads them.
  if (query.regex && (/\\[bBWDs]/.test(query.pattern) || /\[\^[^\]]*\\[wd]/.test(query.pattern))) {
    const listed: string[] = []
    return streamLines(rg, ['--files', '--null', ...filters, '--', ...roots], undefined, signal, (path) => {
      if (path) listed.push(path)
      return true
    }, '\0').then(async ({ code, stderr }) => {
      if (code === 127) return forgetRipgrep()
      await scanFiles(listed.sort().map((path) => ({ root: rootOf(roots, path), path: resolve(path) })), matcher, found, signal)
      if (code === 2 && stderr.trim()) note(stderr.trim().split('\n')[0]!)
      return true
    })
  }

  const args = [
    '--json',
    ...filters,
    // `$` before a Windows line ending, as JavaScript sees it once the \r is stripped.
    '--crlf',
    query.caseSensitive ? '--case-sensitive' : '--ignore-case',
    ...(query.regex ? [] : ['--fixed-strings']),
    ...(query.wholeWord ? ['--word-regexp'] : []),
    '--regexp',
    query.pattern,
    '--',
    ...roots
  ]
  return streamLines(rg, args, undefined, signal, (line) => {
    if (!line.startsWith('{"type":"match"')) return true
    let event: RipgrepMatch
    try {
      event = JSON.parse(line) as RipgrepMatch
    } catch {
      return true
    }
    const path = event.data.path.text ?? decode(event.data.path.bytes)
    const text = event.data.lines.text ?? decode(event.data.lines.bytes)
    if (path === undefined || text === undefined) return true
    return found.line(rootOf(roots, path), resolve(path), event.data.line_number, text.replace(/\n$/, ''), matcher)
  }).then(({ code, stderr }) => {
    // Could not be started at all — uninstalled since it was found. Not "no results": try the
    // other engines, and look for ripgrep afresh next time.
    if (code === 127) return forgetRipgrep()
    // 0 found, 1 found nothing, 2 an error — which with --no-messages off is usually one unreadable
    // file among thousands, and results still came back.
    if (code === 2 && found.count === 0 && /regex|parse error|syntax/i.test(stderr)) return false
    if (code === 2 && stderr.trim()) note(stderr.trim().split('\n')[0]!)
    return true
  })
}

function forgetRipgrep(): false {
  ripgrep = undefined
  return false
}

/** The folder a path is shown under: the innermost one containing it, as the one nearest to it. */
function rootOf(roots: readonly string[], path: string): string {
  let best: string | undefined
  for (const r of roots) {
    if ((path === r || path.startsWith(r.endsWith(sep) ? r : r + sep)) && (!best || r.length > best.length)) best = r
  }
  return best ?? roots[0]!
}

interface RipgrepMatch {
  type: 'match'
  data: {
    path: { text?: string; bytes?: string }
    lines: { text?: string; bytes?: string }
    line_number: number
  }
}

/** ripgrep sends a path or line that is not valid UTF-8 as base64 bytes. */
function decode(bytes: string | undefined): string | undefined {
  return bytes === undefined ? undefined : Buffer.from(bytes, 'base64').toString('utf8')
}

// ---------------------------------------------------------------------------
// git grep
// ---------------------------------------------------------------------------

function isGitWorkTree(root: string): Promise<boolean> {
  return new Promise((done) => {
    execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, timeout: 5000, windowsHide: true }, (err, stdout) =>
      done(!err && String(stdout).trim() === 'true')
    )
  })
}

function ignoredByRepository(dir: string): Promise<boolean> {
  return new Promise((done) => {
    execFile('git', ['check-ignore', '-q', '.'], { cwd: dir, timeout: 5000, windowsHide: true }, (err) => done(!err))
  })
}

/**
 * Search a repository with git's knowledge of what it ignores. False when git could not run, so
 * the caller walks the folder instead.
 *
 * git only FILTERS where its idea of a match provably contains JavaScript's: literal text that is
 * case-sensitive or plain ASCII. A regex is another matter — POSIX ERE has no `\s`, and rather
 * than fail it quietly matches a literal `s`, so every line the user wanted is filtered out before
 * JavaScript sees it. And git's case folding outside ASCII follows the locale. So for those, git
 * lists the files it does not ignore and JavaScript reads them, which agrees with the other engines
 * by construction.
 */
async function searchWithGit(
  dir: string,
  root: string,
  query: SearchQuery,
  matcher: RegExp,
  found: Collector,
  signal: AbortSignal,
  note: (message: string) => void
): Promise<boolean> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' }
  const exact = !query.regex && (query.caseSensitive || /^[\x20-\x7e]*$/.test(query.pattern))
  if (!exact) {
    const listed = new Set<string>()
    // Tracked and untracked-but-not-ignored: the same set git grep --untracked searches.
    const { code } = await streamLines(
      'git',
      ['-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: dir, env },
      signal,
      (rel) => { if (rel) listed.add(rel); return true },
      '\0'
    )
    if (code !== 0) return false
    await scanFiles([...listed].sort().map((rel) => ({ root, path: join(dir, rel) })), matcher, found, signal)
    return true
  }

  const args = [
    '-c',
    'core.quotePath=false',
    // The user's own git config can reshape this output: grep.column adds a field, grep.fullName
    // makes paths relative to the repository instead of to this folder. Pinned, so it parses.
    '-c',
    'grep.column=false',
    '-c',
    'grep.fullName=false',
    'grep',
    '--no-color',
    '--line-number',
    // Binaries are skipped; untracked files that are not ignored are searched, which is what makes
    // this find the file you created five minutes ago and have not added.
    '-I',
    '--untracked',
    '--exclude-standard',
    '-z',
    ...(query.caseSensitive ? [] : ['--ignore-case']),
    ...(query.wholeWord ? ['--word-regexp'] : []),
    '--fixed-strings',
    '-e',
    query.pattern
  ]
  return streamLines('git', args, { cwd: dir, env }, signal, (line) => {
    // path NUL line NUL text — the NULs are what make a path with a colon in it parse.
    const a = line.indexOf('\0')
    const b = a < 0 ? -1 : line.indexOf('\0', a + 1)
    if (b < 0) return true
    return found.line(root, join(dir, line.slice(0, a)), Number(line.slice(a + 1, b)), line.slice(b + 1), matcher)
  }).then(({ code, stderr }) => {
    if (code === 0 || code === 1) return true
    if (found.count === 0) return false
    note(stderr.trim().split('\n')[0] ?? `git grep failed in ${dir}`)
    return true
  })
}

/**
 * A repository's submodules, as folders to search next. git grep with --untracked cannot recurse
 * into them, and without this every file in a submodule would be invisible to search — but only on
 * machines without ripgrep, which is the kind of difference nobody could ever work out.
 *
 * Read from .gitmodules, which is a few lines, rather than by listing the whole index again after
 * every search: most repositories have no submodules and no such file, and cost one failed read.
 */
function submodules(dir: string): string[] {
  let text: string
  try {
    text = readFileSync(join(dir, '.gitmodules'), 'utf8')
  } catch {
    return []
  }
  return [...text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((m) => join(dir, m[1]!)).filter(isDirectory)
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * Never descended into. The ones that exist in nearly every project and are never what a person is
 * searching for; anything beyond this is left to the root's .gitignore.
 */
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'bower_components', '__pycache__', '.venv'])
const MAX_FILE_BYTES = 5 * 1024 * 1024

async function searchWithWalk(
  base: string,
  root: string,
  matcher: RegExp,
  found: Collector,
  signal: AbortSignal,
  note: (message: string) => void
): Promise<void> {
  const ignored = await rootIgnore(base)
  const walk = async (dir: string): Promise<void> => {
    if (signal.aborted || found.full) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (dir === base) note(err instanceof Error ? err.message : String(err))
      return
    }
    // Sorted, so a capped search stops at the same place every time.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (signal.aborted || found.full) return
      const path = join(dir, entry.name)
      const rel = relative(base, path).split(sep).join('/')
      // Symlinks are not followed at all: a link to a parent is a loop, and a link out of the
      // workspace is not the workspace.
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || ignored(rel, true)) continue
        await walk(path)
      } else if (entry.isFile() && !ignored(rel, false)) {
        await searchFile(root, path, matcher, found)
      }
    }
  }
  await walk(base)
}

/** How many files the listing engines read at once: enough to keep the disk busy, few enough not to flood it. */
const READ_AHEAD = 16

/**
 * Read a listed set of files and offer their lines, in the listed order — several reads in flight
 * at a time, but lines handed over one file after another, so a capped search stops at the same
 * place every time. Reading them one by one made a regex search of a large repository take long
 * enough to run into the time limit.
 */
async function scanFiles(
  files: ReadonlyArray<{ root: string; path: string }>,
  matcher: RegExp,
  found: Collector,
  signal: AbortSignal
): Promise<void> {
  for (let i = 0; i < files.length; i += READ_AHEAD) {
    if (signal.aborted || found.full) return
    const batch = files.slice(i, i + READ_AHEAD)
    const texts = await Promise.all(batch.map((f) => readText(f.path, found)))
    for (let j = 0; j < batch.length; j++) {
      const text = texts[j]
      if (text === null || text === undefined) continue
      if (!offerLines(batch[j]!.root, batch[j]!.path, text, matcher, found)) return
    }
  }
}

async function searchFile(root: string, path: string, matcher: RegExp, found: Collector): Promise<void> {
  const text = await readText(path, found)
  if (text !== null) offerLines(root, path, text, matcher, found)
}

function offerLines(root: string, path: string, text: string, matcher: RegExp, found: Collector): boolean {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!found.line(root, path, i + 1, lines[i]!, matcher)) return false
  }
  return true
}

/**
 * A file's text, or null when it is not one to search: already read through another folder, not a
 * regular file — a tracked symlink (git lists them; following one reads a file outside the
 * workspace, or a device that never ends), a FIFO — too large, or binary.
 */
async function readText(path: string, found: Collector): Promise<string | null> {
  if (!found.firstVisit(path)) return null
  let bytes: Buffer
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null
    const handle = await open(path, 'r')
    try {
      bytes = await handle.readFile()
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
  // A NUL in the first 8 KB is how git decides a file is binary, and it is right often enough.
  if (bytes.subarray(0, 8000).includes(0)) return null
  return bytes.toString('utf8')
}

/**
 * The root .gitignore, for the walk: plain names, `dir/`, `*.ext`-style globs and `/anchored`
 * paths. Not negation (`!keep`), not nested .gitignore files, not the global excludes — a folder
 * complicated enough to need those is almost always a git repository, and git grep searches those.
 */
async function rootIgnore(root: string): Promise<(rel: string, isDir: boolean) => boolean> {
  let text = ''
  try {
    text = await readFile(join(root, '.gitignore'), 'utf8')
  } catch {
    return () => false
  }
  const rules = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
    .map((raw) => {
      const dirOnly = raw.endsWith('/')
      const body = raw.replace(/\/+$/, '')
      const anchored = body.startsWith('/') || body.includes('/')
      const re = new RegExp(
        `^${body.replace(/^\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*')}$`
      )
      return { re, dirOnly, anchored }
    })
  return (rel, isDir) =>
    rules.some(({ re, dirOnly, anchored }) => {
      if (dirOnly && !isDir) return false
      if (anchored) return re.test(rel)
      return re.test(rel.slice(rel.lastIndexOf('/') + 1))
    })
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

let childWatcher: ((pid: number, alive: boolean) => void) | null = null

/**
 * Be told of every child this engine starts and reaps. The worker passes them to the main thread,
 * which can then kill them when it has to terminate a worker that no longer answers — terminating
 * a thread does not end the processes it started.
 */
export function watchChildren(watcher: (pid: number, alive: boolean) => void): void {
  childWatcher = watcher
}

/**
 * Run a program and hand each record of its output — a line, or with `delimiter` '\0' one
 * NUL-terminated entry of a -z listing — to `onLine`, which answers false to stop early: the cap was
 * reached. Killed on abort. Resolves with the exit code and stderr, never rejects: a program that
 * cannot be started at all resolves as code 127 with the reason in stderr.
 */
function streamLines(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } | undefined,
  signal: AbortSignal,
  onLine: (line: string) => boolean,
  delimiter = '\n'
): Promise<{ code: number; stderr: string }> {
  return new Promise((done) => {
    if (signal.aborted) return done({ code: 0, stderr: '' })
    const child = spawn(file, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    if (child.pid) childWatcher?.(child.pid, true)
    let stderr = ''
    let settled = false
    const finish = (result: { code: number; stderr: string }): void => {
      if (settled) return
      settled = true
      if (child.pid) childWatcher?.(child.pid, false)
      signal.removeEventListener('abort', stop)
      done(result)
    }
    const stop = (): void => { child.kill() }
    signal.addEventListener('abort', stop, { once: true })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 4096) stderr += chunk })
    // Split on the delimiter alone. readline also splits on a lone \r, and a progress-bar log line
    // such as "10%\r100% needle" would arrive as two, the second without the path and line number
    // git put in front of the first. Only the newly arrived chunk is searched for the delimiter —
    // the unfinished tail before it is known not to contain one — so a listing of a hundred
    // thousand files is one pass over the output, not one per chunk.
    let pending = ''
    let stopped = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return
      const from = pending.length
      pending += chunk
      let start = 0
      let at = pending.indexOf(delimiter, from)
      while (at >= 0) {
        if (!onLine(pending.slice(start, at))) {
          stopped = true
          child.kill()
          return
        }
        start = at + 1
        at = pending.indexOf(delimiter, start)
      }
      pending = pending.slice(start)
    })
    child.stdout.on('end', () => { if (!stopped && pending) onLine(pending) })
    child.on('error', (err) => finish({ code: 127, stderr: err.message }))
    child.on('close', (code) => finish({ code: code ?? (signal.aborted ? 0 : 1), stderr }))
  })
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
