import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { git, gitText } from './exec'
import type { GitFileChange, GitOperation, GitStatusLetter, RepoStatus } from '../../protocol'

/**
 * `git status --porcelain=v2 -z` parsing, verified against git 2.50.1.
 *
 * Two things about -z mode drive the design:
 *
 *  - Paths are emitted RAW, never C-quoted, and every record is NUL-terminated. Split on 0x00,
 *    never on newline: a path may legally contain 0x0A.
 *
 *  - A rename/copy record ('2') is followed by the original path as a SEPARATE NUL-terminated
 *    field. A parser that only splits on NUL and dispatches on rec[0] sees that path as a bogus
 *    record beginning with whatever character the path starts with. The next field must be
 *    consumed immediately.
 *
 * `--no-optional-locks` is deliberately NOT passed; see the note in exec.ts.
 */

const STATUS_ARGS = [
  'status',
  '--porcelain=v2',
  '-z',
  // -unormal collapses an untracked directory to a single `? dir/` record. -uall on a large repo
  // was measured in seconds rather than milliseconds.
  '-unormal',
  '--branch',
  '--show-stash',
  '--ignore-submodules=none'
]

interface Parsed {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  detachedAt: string | null
  stashCount: number
  staged: GitFileChange[]
  unstaged: GitFileChange[]
  untracked: GitFileChange[]
  conflicts: GitFileChange[]
}

export function parsePorcelainV2(buf: Buffer): Parsed {
  const out: Parsed = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detachedAt: null,
    stashCount: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: []
  }

  // Trailing NUL produces a final empty field; drop it rather than parsing an empty record.
  const fields = buf.toString('utf8').split('\0')
  if (fields.length && fields[fields.length - 1] === '') fields.pop()

  let oid: string | null = null

  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i]!
    if (rec === '') continue

    switch (rec[0]) {
      case '#': {
        const body = rec.slice(2)
        const sp = body.indexOf(' ')
        const key = sp < 0 ? body : body.slice(0, sp)
        const value = sp < 0 ? '' : body.slice(sp + 1)
        if (key === 'branch.oid') oid = value
        else if (key === 'branch.head') out.branch = value === '(detached)' ? null : value
        else if (key === 'branch.upstream') out.upstream = value
        else if (key === 'branch.ab') {
          const m = /^\+(\d+) -(\d+)$/.exec(value)
          if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]) }
        } else if (key === 'stash') out.stashCount = Number(value) || 0
        break
      }

      case '1': {
        // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        const f = splitFields(rec, 8)
        if (!f) break
        const [, xy, sub] = f
        push(out, change(f[8]!, null, xy!, sub!, null))
        break
      }

      case '2': {
        // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>  NUL  <origPath>
        const f = splitFields(rec, 9)
        if (!f) break
        const origPath = fields[++i] ?? null // consume the following field — see the header note
        const score = Number(f[8]!.slice(1)) || null
        push(out, change(f[9]!, origPath, f[1]!, f[2]!, score))
        break
      }

      case 'u': {
        // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
        const f = splitFields(rec, 10)
        if (!f) break
        const c = change(f[10]!, null, f[1]!, f[2]!, null)
        // Both sides are conflict markers here, not ordinary index/worktree states.
        out.conflicts.push({ ...c, index: 'U', worktree: 'U' })
        break
      }

      case '?':
        out.untracked.push(plain(rec.slice(2), '?'))
        break

      case '!':
        break // only present with --ignored, which we do not pass

      default:
        break
    }
  }

  if (out.branch === null && oid && oid !== '(initial)') out.detachedAt = oid.slice(0, 8)
  return out
}

/**
 * Split a record into exactly `count` space-separated fields plus a final path field that may
 * itself contain spaces. Returns null if the record is malformed.
 */
function splitFields(rec: string, count: number): string[] | null {
  const parts: string[] = []
  let pos = 0
  for (let n = 0; n < count; n++) {
    const sp = rec.indexOf(' ', pos)
    if (sp < 0) return null
    parts.push(rec.slice(pos, sp))
    pos = sp + 1
  }
  parts.push(rec.slice(pos)) // the path: everything left, spaces included
  return parts
}

function change(
  path: string,
  origPath: string | null,
  xy: string,
  sub: string,
  score: number | null
): GitFileChange {
  return {
    path,
    origPath,
    index: letter(xy[0]!),
    worktree: letter(xy[1]!),
    score,
    // "N..." means not a submodule; anything else is "S<c><m><u>".
    isSubmodule: sub[0] === 'S'
  }
}

function plain(path: string, l: GitStatusLetter): GitFileChange {
  return { path, origPath: null, index: '.', worktree: l, score: null, isSubmodule: false }
}

function letter(c: string): GitStatusLetter | '.' {
  return c === '.' ? '.' : (c as GitStatusLetter)
}

/**
 * A file can appear in both groups at once — staged edits plus further unstaged edits — which is
 * exactly what the two columns of XY mean, so it is listed in both.
 */
function push(out: Parsed, c: GitFileChange): void {
  if (c.index !== '.') out.staged.push(c)
  if (c.worktree !== '.') out.unstaged.push(c)
}

// ---------------------------------------------------------------------------
// In-progress operation
// ---------------------------------------------------------------------------

/**
 * Not available from porcelain v2 — it has to be read off marker files in the git directory.
 * All metadata, all in page cache; the whole block measured under 2 ms.
 */
export async function detectOperation(gitDir: string): Promise<GitOperation> {
  const [merge, rebaseMerge, rebaseApply, cherry, revert, bisect] = await Promise.all([
    exists(join(gitDir, 'MERGE_HEAD')),
    exists(join(gitDir, 'rebase-merge')),
    exists(join(gitDir, 'rebase-apply')),
    exists(join(gitDir, 'CHERRY_PICK_HEAD')),
    exists(join(gitDir, 'REVERT_HEAD')),
    exists(join(gitDir, 'BISECT_LOG'))
  ])
  // Order matters: a rebase that hits a conflict also writes MERGE-ish state, and the rebase is
  // the more useful thing to report.
  if (rebaseMerge || rebaseApply) return 'rebase'
  if (cherry) return 'cherry-pick'
  if (revert) return 'revert'
  if (merge) return 'merge'
  if (bisect) return 'bisect'
  return 'none'
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------

export interface RepoPaths {
  /** Per-worktree state: HEAD, MERGE_HEAD, rebase-merge/, index. */
  gitDir: string
  /** Shared across worktrees: refs/, packed-refs, config, objects/. */
  commonDir: string
  root: string
}

/** Resolved once per repo: three answers from one spawn. */
export async function resolveRepoPaths(cwd: string): Promise<RepoPaths> {
  const out = await gitText(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-dir',
    '--git-common-dir',
    '--show-toplevel'
  ])
  const [gitDir, commonDir, root] = out.trim().split('\n')
  if (!gitDir || !commonDir || !root) throw new Error(`not a git repository: ${cwd}`)
  return { gitDir, commonDir, root }
}

export async function readStatus(paths: RepoPaths): Promise<RepoStatus> {
  const [res, operation] = await Promise.all([
    git(paths.root, STATUS_ARGS),
    detectOperation(paths.gitDir)
  ])
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'git status failed')

  const p = parsePorcelainV2(res.stdout)
  return {
    repoId: paths.root,
    root: paths.root,
    name: basename(paths.root),
    branch: p.branch,
    upstream: p.upstream,
    ahead: p.ahead,
    behind: p.behind,
    detachedAt: p.detachedAt,
    operation,
    staged: p.staged,
    unstaged: p.unstaged,
    untracked: p.untracked,
    conflicts: p.conflicts,
    stashCount: p.stashCount,
    at: Date.now()
  }
}
