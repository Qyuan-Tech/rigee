/**
 * Reading and writing `.code-workspace` files.
 *
 * The format is VS Code's, because that is what the user already has on disk and there is nothing
 * to gain from inventing a second one:
 *
 *   {
 *     "folders": [ { "path": "repo-a" }, { "path": "/abs/repo-b", "name": "Custom" } ],
 *     "settings": { }
 *   }
 *
 * Paths are resolved against the directory holding the file, which is what makes a workspace file
 * committable next to the repos it groups.
 *
 * Pure and filesystem-free so it can be unit tested: the parsing is the part with edges, and a
 * malformed workspace file should produce a diagnosable error rather than a half-loaded window.
 */

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { t } from '@shared/l10n'

export interface WorkspaceFileFolder {
  path: string
  name?: string
}

export interface ParsedWorkspaceFile {
  /** Display name for the workspace: the file's basename without the extension. */
  name: string
  /** Absolute, de-duplicated, in file order. */
  folders: WorkspaceFileFolder[]
}

/**
 * Strip comments and trailing commas so `JSON.parse` accepts the file.
 *
 * VS Code writes plain JSON but reads JSONC, and people hand-edit these files — a `//` note above
 * a folder entry is common and must not make the workspace unopenable. String contents are left
 * alone, which is the whole difficulty: a `//` inside a Windows path or a URL is not a comment.
 */
export function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  let comment: 'line' | 'block' | null = null

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const next = text[i + 1]

    if (comment === 'line') {
      if (c === '\n') { comment = null; out += c }
      continue
    }
    if (comment === 'block') {
      if (c === '*' && next === '/') { comment = null; i++ }
      continue
    }
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (c === '/' && next === '/') { comment = 'line'; i++; continue }
    if (c === '/' && next === '*') { comment = 'block'; i++; continue }
    out += c
  }

  // Trailing commas, now that no comma inside a string or comment can be confused for one.
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/** Throws with a message naming the file, which is the only useful thing to show a user here. */
export function parseWorkspaceFile(text: string, filePath: string): ParsedWorkspaceFile {
  const label = basename(filePath)
  let doc: unknown
  try {
    doc = JSON.parse(stripJsonComments(text))
  } catch (err) {
    throw new Error(t('{name} is not valid JSON: {reason}', { name: label, reason: err instanceof Error ? err.message : String(err) }))
  }
  if (!doc || typeof doc !== 'object') throw new Error(t('{name} is not a workspace file', { name: label }))

  const rawFolders = (doc as { folders?: unknown }).folders
  if (!Array.isArray(rawFolders)) {
    throw new Error(t('{name} has no "folders" array', { name: label }))
  }

  const base = dirname(resolve(filePath))
  const seen = new Set<string>()
  const folders: WorkspaceFileFolder[] = []
  for (const raw of rawFolders) {
    const abs = entryPath(raw, base)
    if (abs === null || seen.has(abs)) continue
    seen.add(abs)
    const name = (raw as { name?: unknown })?.name
    folders.push(typeof name === 'string' && name ? { path: abs, name } : { path: abs })
  }

  return { name: label.replace(/\.code-workspace$/i, ''), folders }
}

/** The folder one entry of the `folders` array names, absolute; null for an entry with no usable path. */
function entryPath(raw: unknown, base: string): string | null {
  const p = (raw as { path?: unknown })?.path
  if (typeof p !== 'string' || p === '') return null
  return isAbsolute(p) ? resolve(p) : resolve(join(base, p))
}

/**
 * The workspace files folder from Settings as an absolute path, or null when none is set.
 *
 * A leading `~` is the home directory, the way a shell reads it. Anything still relative after that
 * is refused rather than resolved: relative to where the app happened to be started is not a place
 * anybody meant.
 */
export function resolveWorkspaceFilesDir(raw: string | undefined, home: string): string | null {
  const dir = raw?.trim()
  if (!dir) return null
  const expanded = dir === '~' ? home : /^~[\\/]/.test(dir) ? join(home, dir.slice(2)) : dir
  return isAbsolute(expanded) ? resolve(expanded) : null
}

/**
 * Where renaming a workspace to `name` takes its `.code-workspace` file — and the folder the file is
 * in, when that goes too.
 *
 * The file always: a saved workspace is called what its file is called. Its folder only when the
 * file is filed the way a save by name files it, `<files folder>/<old>/<old>.code-workspace`: that
 * folder was made for the workspace and named after it, and becomes `<files folder>/<name>/`, as a
 * save under the new name would have made it. A file anywhere else stays in its folder, which is
 * somebody else's — a repo it was saved into, say. So does one whose folder holds a path in `keep`,
 * a workspace's folder, which would go with it.
 *
 * Paths absolute and resolved, as main has them; `filesDir` as `resolveWorkspaceFilesDir` gives it.
 */
export function renamedWorkspaceFile(
  file: string,
  name: string,
  filesDir: string | null,
  keep: readonly string[]
): { file: string; folder: { from: string; to: string } | null } {
  const extension = '.code-workspace'
  const dir = dirname(file)
  const stem = basename(file).slice(0, -extension.length)
  const filed = filesDir !== null && dirname(dir) === filesDir && basename(dir) === stem
  const holds = keep.some((path) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep))
  if (filed && !holds) {
    const to = join(filesDir, name)
    return { file: join(to, `${name}${extension}`), folder: { from: dir, to } }
  }
  return { file: join(dir, `${name}${extension}`), folder: null }
}

/**
 * Render a workspace file. Folders below the file's own directory are written relative, the way
 * VS Code does it, so a workspace checked in beside its repos still resolves on another machine.
 */
export function serializeWorkspaceFile(
  folders: readonly WorkspaceFileFolder[],
  filePath: string
): string {
  const base = dirname(resolve(filePath))
  const entries = folders.map((f) => fileEntry(f, base))
  // Two-space indent and a trailing newline: this file is meant to be committed and diffed.
  return `${JSON.stringify({ folders: entries, settings: {} }, null, 2)}\n`
}

/** One folder as a file in `base` records it: relative below it, and named only when that says something. */
function fileEntry(f: WorkspaceFileFolder, base: string): WorkspaceFileFolder {
  const abs = resolve(f.path)
  const rel = relative(base, abs)
  const usable = rel !== '' && !isAbsolute(rel) && !rel.startsWith('..')
  const out: WorkspaceFileFolder = { path: usable ? rel : abs }
  if (f.name && f.name !== basename(abs)) out.name = f.name
  return out
}

/**
 * Add folders to the text of a workspace file, leaving everything else in it as it was.
 *
 * Not parse-and-rewrite. That would be a few lines, and it would throw away every comment in the
 * file, its indentation and the order of its keys — in a file people hand-edit and commit, in
 * answer to a gesture that never mentioned editing it. So the new entries are spliced into the text
 * of the `folders` array after its last entry, laid out the way that entry is. Folders the file
 * already names, however it spells them, are skipped; with nothing left to add the text comes back
 * as it went in, which is how the caller knows there is nothing to write.
 *
 * Throws what `parseWorkspaceFile` throws for a file that is not a workspace file. What it returns
 * always parses to the folders it should: the splice is checked, and a layout that defeats it gets
 * the file rewritten whole instead — every key and value kept, the comments not — rather than
 * written back broken.
 */
export function addFoldersToWorkspaceFile(
  text: string,
  filePath: string,
  folders: readonly WorkspaceFileFolder[]
): string {
  const listed = new Set(parseWorkspaceFile(text, filePath).folders.map((f) => f.path))
  const base = dirname(resolve(filePath))
  const entries: WorkspaceFileFolder[] = []
  for (const f of folders) {
    const abs = resolve(f.path)
    if (listed.has(abs)) continue
    listed.add(abs)
    entries.push(fileEntry(f, base))
  }
  if (entries.length === 0) return text

  const listsThemAll = (out: string): boolean => {
    try {
      const got = parseWorkspaceFile(out, filePath).folders
      return got.length === listed.size && got.every((f) => listed.has(f.path))
    } catch {
      return false
    }
  }
  const spliced = spliceFolders(text, entries)
  if (spliced !== null && listsThemAll(spliced)) return spliced

  const doc = JSON.parse(stripJsonComments(text)) as { folders: unknown[] }
  doc.folders = [...doc.folders, ...entries]
  return `${JSON.stringify(doc, null, /^\t/m.test(text) ? '\t' : 2)}\n`
}

/** The new entries written into the text of the `folders` array, or null when it cannot be found. */
function spliceFolders(text: string, entries: readonly WorkspaceFileFolder[]): string | null {
  const array = findFoldersArray(text)
  if (!array) return null
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const last = array.items[array.items.length - 1]

  if (!last) {
    // Empty: one entry per line, a level in from the line the key is on, in the file's own unit.
    const outer = lineIndent(text, array.open)
    const inner = outer + (outer || (/^\t/m.test(text) ? '\t' : '  '))
    const body = entries.map((e) => renderEntry(e, { lines: inner.slice(outer.length), spaced: true }, inner, eol))
    const sep = eol + inner
    const blank = text.slice(array.open + 1, array.close).trim() === ''
    return blank
      ? text.slice(0, array.open + 1) + sep + body.join(`,${sep}`) + eol + outer + text.slice(array.close)
      : text.slice(0, array.open + 1) + sep + body.join(`,${sep}`) + text.slice(array.open + 1)
  }

  // Laid out like the entry before: on a line of its own, or after it on the same line; spread over
  // several lines in its indent unit, or kept to one with or without spaces inside the braces.
  const own = lineIndent(text, last.start)
  const ownLine = /^[ \t]*$/.test(text.slice(lineStart(text, last.start), last.start))
  const lastText = text.slice(last.start, last.end)
  const continuation = /^[ \t]*/.exec(lastText.split('\n')[1] ?? '')![0]
  const layout = lastText.includes('\n')
    ? { lines: continuation.startsWith(own) && continuation.length > own.length ? continuation.slice(own.length) : '  ', spaced: true }
    : { lines: null, spaced: /^\{\s/.test(lastText) }
  const sep = ownLine ? eol + own : ' '
  const body = entries.map((e) => renderEntry(e, layout, own, eol)).join(`,${sep}`)

  // After any comment sharing the line, so a note about the last folder stays beside it.
  if (last.comma !== null) {
    const at = ownLine ? lineEnd(text, last.comma + 1) : last.comma + 1
    return text.slice(0, at) + sep + body + ',' + text.slice(at)
  }
  const at = ownLine ? lineEnd(text, last.end) : last.end
  return text.slice(0, last.end) + ',' + text.slice(last.end, at) + sep + body + text.slice(at)
}

/**
 * One entry's text. `lines` is the indent unit when entries are spread over several lines, null
 * when each is on one; continuation lines are indented from `indent`, where the entry's brace is.
 */
function renderEntry(
  entry: WorkspaceFileFolder,
  layout: { lines: string | null; spaced: boolean },
  indent: string,
  eol: string
): string {
  if (layout.lines !== null) return JSON.stringify(entry, null, layout.lines).split('\n').join(eol + indent)
  const pairs = Object.entries(entry).map(([k, v]) => `${JSON.stringify(k)}:${layout.spaced ? ' ' : ''}${JSON.stringify(v)}`)
  return layout.spaced ? `{ ${pairs.join(', ')} }` : `{${pairs.join(',')}}`
}

/**
 * Take folders out of the text of a workspace file, leaving everything else in it as it was: the
 * other half of `addFoldersToWorkspaceFile`, and not parse-and-rewrite for the same reasons.
 *
 * Every entry naming one of `paths`, however it spells it, is cut out of the text — with the lines
 * it has to itself, when it has them, so a comment beside it goes too while a comment on a line of
 * its own stays. The commas left are the file's own, and a file that writes a trailing comma still
 * does. Folders the file does not name are ignored; with nothing to take out the text comes back as
 * it went in, which is how the caller knows there is nothing to write.
 *
 * Throws what `parseWorkspaceFile` throws for a file that is not a workspace file. What it returns is
 * checked as adding's is, and rewritten whole in the same way when the cut defeats the check.
 */
export function removeFoldersFromWorkspaceFile(
  text: string,
  filePath: string,
  paths: readonly string[]
): string {
  const listed = parseWorkspaceFile(text, filePath).folders.map((f) => f.path)
  const doomed = new Set(paths.map((p) => resolve(p)))
  const kept = listed.filter((p) => !doomed.has(p))
  if (kept.length === listed.length) return text

  const base = dirname(resolve(filePath))
  const goes = (entry: unknown): boolean => {
    const abs = entryPath(entry, base)
    return abs !== null && doomed.has(abs)
  }
  const listsTheRest = (out: string): boolean => {
    try {
      const got = parseWorkspaceFile(out, filePath).folders
      return got.length === kept.length && got.every((f, i) => f.path === kept[i])
    } catch {
      return false
    }
  }
  const cut = cutFolders(text, goes)
  if (cut !== null && listsTheRest(cut)) return cut

  const doc = JSON.parse(stripJsonComments(text)) as { folders: unknown[] }
  doc.folders = doc.folders.filter((entry) => !goes(entry))
  return `${JSON.stringify(doc, null, /^\t/m.test(text) ? '\t' : 2)}\n`
}

/**
 * The entries `goes` picks cut out of the text of the `folders` array, or null when it cannot be
 * found.
 *
 * An entry with lines to itself takes them whole, line break and any comment beside it included;
 * when the last entries go from a list with no trailing comma, the entry left last loses its comma.
 * Entries sharing a line go with the comma after them, or at the end of the list with the comma
 * before them, a run of neighbours at a time. A list left with nothing between its brackets but
 * space closes up, as an empty one is written.
 */
function cutFolders(text: string, goes: (entry: unknown) => boolean): string | null {
  const array = findFoldersArray(text)
  if (!array) return null
  const { items } = array
  const going = items.map((item) => {
    try {
      return goes(JSON.parse(stripJsonComments(text.slice(item.start, item.end))))
    } catch {
      return false
    }
  })

  const cuts: Array<[from: number, to: number]> = []
  for (let i = 0; i < items.length; i++) {
    if (!going[i]) continue
    let j = i
    while (going[j + 1]) j++
    const first = items[i]!
    const last = items[j]!
    const before = items[i - 1]
    const after = items[j + 1]
    const lines = items.slice(i, j + 1).map((item) => linesOf(text, item))
    if (lines.every((l): l is [number, number] => l !== null)) {
      // Each on its own, so a comment on a line between two of them stays.
      cuts.push(...lines)
      if (!after && last.comma === null && before?.comma != null) cuts.push([before.comma, before.comma + 1])
    } else if (after) {
      cuts.push([first.start, after.start])
    } else if (before) {
      cuts.push([before.end, last.end])
    } else {
      cuts.push([first.start, last.comma === null ? last.end : last.comma + 1])
    }
    i = j
  }

  cuts.sort((a, b) => a[0] - b[0])
  let out = ''
  let at = 0
  for (const [from, to] of cuts) {
    out += text.slice(at, from)
    at = to
  }
  out += text.slice(at)
  if (going.every(Boolean)) {
    // Every cut was inside the brackets: the opening one has not moved, the closing one has moved
    // back by all of them.
    const close = array.close - cuts.reduce((n, [from, to]) => n + to - from, 0)
    if (out.slice(array.open + 1, close).trim() === '') out = out.slice(0, array.open + 1) + out.slice(close)
  }
  return out
}

/**
 * The lines an entry has to itself, from the start of its first to past the line break of its last:
 * nothing but space before it on the first, and nothing after it — and after its comma, which must
 * be on the same line — but space and comments on the last. Null when it shares a line.
 */
function linesOf(text: string, item: FoldersArray['items'][number]): [number, number] | null {
  const from = lineStart(text, item.start)
  if (!/^[ \t]*$/.test(text.slice(from, item.start))) return null
  if (item.comma !== null && text.slice(item.end, item.comma).includes('\n')) return null
  const to = lineEnd(text, item.comma === null ? item.end : item.comma + 1)
  const eol = text.startsWith('\r\n', to) ? 2 : text[to] === '\n' ? 1 : 0
  return eol > 0 ? [from, to + eol] : null
}

function lineStart(text: string, at: number): number {
  return text.lastIndexOf('\n', at - 1) + 1
}

function lineIndent(text: string, at: number): string {
  return /^[ \t]*/.exec(text.slice(lineStart(text, at)))![0]
}

/** Past the spaces and the comments that share a line with `at`: where a new line would start. */
function lineEnd(text: string, at: number): number {
  let p = at
  for (;;) {
    while (text[p] === ' ' || text[p] === '\t') p++
    if (text.startsWith('//', p)) {
      const nl = text.indexOf('\n', p)
      if (nl < 0) return text.length
      return text[nl - 1] === '\r' ? nl - 1 : nl
    }
    if (text.startsWith('/*', p)) {
      const end = text.indexOf('*/', p + 2)
      const nl = text.indexOf('\n', p)
      if (end >= 0 && (nl < 0 || end < nl)) {
        p = end + 2
        continue
      }
    }
    return p
  }
}

interface FoldersArray {
  /** Offsets of the array's brackets. */
  open: number
  close: number
  /**
   * Where each entry's text starts and ends, and the comma after it: every entry has one but the
   * last, which has one too in a file that writes a trailing comma.
   */
  items: Array<{ start: number; end: number; comma: number | null }>
}

/**
 * The top-level `folders` array, found in the text. The last one if the key is there twice,
 * because that is the one `JSON.parse` — and so `parseWorkspaceFile` — reads.
 */
function findFoldersArray(text: string): FoldersArray | null {
  const tokens = jsoncTokens(text)
  let found: FoldersArray | null = null
  let depth = 0
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!
    if (t.punct === '{' || t.punct === '[') { depth++; continue }
    if (t.punct === '}' || t.punct === ']') { depth--; continue }
    if (depth !== 1 || text[t.start] !== '"' || tokens[k + 1]?.punct !== ':' || tokens[k + 2]?.punct !== '[') continue
    let key: unknown
    try { key = JSON.parse(text.slice(t.start, t.end)) } catch { continue }
    if (key !== 'folders') continue

    const items: FoldersArray['items'] = []
    let item: FoldersArray['items'][number] | null = null
    let nested = 0
    let m = k + 3
    for (; m < tokens.length; m++) {
      const u = tokens[m]!
      if (nested === 0 && u.punct === ',') {
        if (item) items.push({ ...item, comma: u.start })
        item = null
        continue
      }
      if (nested === 0 && u.punct === ']') break
      if (u.punct === '{' || u.punct === '[') nested++
      else if (u.punct === '}' || u.punct === ']') nested--
      if (item) item.end = u.end
      else item = { start: u.start, end: u.end, comma: null }
    }
    if (m >= tokens.length) return null
    if (item) items.push(item)
    found = { open: tokens[k + 2]!.start, close: tokens[m]!.start, items }
    // The array's own brackets were consumed above, so the depth outside it is unchanged.
    k = m
  }
  return found
}

/**
 * The significant tokens of a JSONC text — strings, punctuation and bare words — with whitespace and
 * comments dropped. As much of a tokenizer as finding one array needs, and no more.
 */
function jsoncTokens(text: string): Array<{ start: number; end: number; punct: string }> {
  const out: Array<{ start: number; end: number; punct: string }> = []
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? text.length : nl
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
    } else if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out.push({ start: i, end: Math.min(j + 1, text.length), punct: '' })
      i = j + 1
    } else if ('{}[]:,'.includes(c)) {
      out.push({ start: i, end: i + 1, punct: c })
      i++
    } else if (/\s/.test(c)) {
      i++
    } else {
      let j = i + 1
      while (j < text.length && !/[\s{}[\]:,"/]/.test(text[j]!)) j++
      out.push({ start: i, end: j, punct: '' })
      i = j
    }
  }
  return out
}
