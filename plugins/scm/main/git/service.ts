import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BlobReader, looksBinary } from './blobs'
import { git, gitText } from './exec'
import { readStatus, resolveRepoPaths, type RepoPaths } from './status'
import { buildSelectionPatch, parseUnifiedDiff, type ParsedDiff } from './patch'
import { ScmWatchers } from './watcher'
import type { DiffTarget, RepoStatus, SelectionAction } from '../../protocol'

/**
 * The source control service: one entry per repository, each holding its resolved paths and a
 * warm `git cat-file --batch`.
 */

/** Beyond this, Monaco is not a good way to look at the file and the diff is not worth computing. */
const MAX_DIFF_BYTES = 4 * 1024 * 1024

interface Repo {
  paths: RepoPaths
  blobs: BlobReader
}

export class GitService {
  private readonly repos = new Map<string, Repo>()
  private watchers: ScmWatchers | null = null
  /** Last status emitted per repo, so unchanged refreshes stay silent. */
  private readonly lastStatusKey = new Map<string, string>()

  private async repo(repoRoot: string): Promise<Repo> {
    let entry = this.repos.get(repoRoot)
    if (!entry) {
      const paths = await resolveRepoPaths(repoRoot)
      // Key by the resolved root: on macOS /tmp is a symlink, so the caller's path and git's
      // --show-toplevel disagree unless both are normalised.
      entry = this.repos.get(paths.root) ?? { paths, blobs: new BlobReader(paths.root) }
      this.repos.set(repoRoot, entry)
      this.repos.set(paths.root, entry)
    }
    return entry
  }

  async status(repoRoot: string): Promise<RepoStatus> {
    const { paths } = await this.repo(repoRoot)
    return readStatus(paths)
  }

  /** Repos are independent, so they refresh concurrently; one bad repo must not sink the rest. */
  async statusAll(repoRoots: string[]): Promise<RepoStatus[]> {
    const results = await Promise.allSettled(repoRoots.map((r) => this.status(r)))
    const out: RepoStatus[] = []
    for (const [i, r] of results.entries()) {
      if (r.status === 'fulfilled') out.push(r.value)
      else console.warn(`[git] status failed for ${repoRoots[i]}: ${String(r.reason)}`)
    }
    return out
  }

  /**
   * The two sides of a diff.
   *
   * Which pair depends on which group the row came from, and it matters: showing
   * worktree-vs-HEAD for a row under "Staged Changes" would display unstaged edits the user did
   * not stage.
   *
   *   worktree-vs-index  unstaged edits      index blob   vs  file on disk
   *   index-vs-head      staged edits        HEAD blob    vs  index blob
   *   worktree-vs-head   everything          HEAD blob    vs  file on disk
   */
  async diff(
    repoRoot: string,
    path: string,
    against: DiffTarget
  ): Promise<{ original: string; modified: string; binary: boolean; tooLarge: boolean }> {
    const { paths, blobs } = await this.repo(repoRoot)

    // Resolve the revision-relative spec to an object id first. The batch reader caches the
    // index from when it started, so asking it for `:0:<path>` directly returns whatever was
    // staged at that moment — wrong as soon as anything stages a change, and in this app the
    // user's own terminal is one of the things that does.
    const resolve = async (spec: string): Promise<Buffer | null> => {
      const res = await git(paths.root, ['rev-parse', '--quiet', '--verify', spec])
      if (res.code !== 0) return null // path absent from that revision: added, or deleted
      return blobs.read(res.stdout.toString('utf8').trim())
    }

    const original = await resolve(
      against.kind === 'worktree-vs-index' ? `:0:${path}` : `HEAD:${path}`
    )

    let modified: Buffer | null
    if (against.kind === 'index-vs-head') {
      modified = await resolve(`:0:${path}`)
    } else {
      // Read the working tree from disk rather than through git: it is the live file, and for an
      // untracked or deleted path there is no object to ask for.
      modified = await readFile(join(paths.root, path)).catch(() => null)
    }

    const empty = { original: '', modified: '', binary: false, tooLarge: false }
    if (!original && !modified) return empty

    const size = (original?.length ?? 0) + (modified?.length ?? 0)
    if (size > MAX_DIFF_BYTES) return { ...empty, tooLarge: true }
    if ((original && looksBinary(original)) || (modified && looksBinary(modified))) {
      return { ...empty, binary: true }
    }

    return {
      original: original?.toString('utf8') ?? '',
      modified: modified?.toString('utf8') ?? '',
      binary: false,
      tooLarge: false
    }
  }

  /**
   * The hunks of one file, for selective staging.
   *
   * `-U3` and no `--unidiff-zero`: with zero context `git apply` has nothing to verify against
   * and will happily misapply. `--no-ext-diff` keeps the user's diff.external out of it,
   * `--no-color` survives color.ui=always, and `--no-renames` gets an add/delete pair rather
   * than a rename record that cannot be applied line by line.
   */
  async hunks(repoRoot: string, path: string, action: SelectionAction): Promise<ParsedDiff> {
    const { paths } = await this.repo(repoRoot)

    // `git diff` is empty for an untracked file, so there is nothing to select. Marking it
    // intent-to-add makes git produce a `new file mode` hunk and per-line staging works; it does
    // not stage any content.
    if (action === 'stage') {
      const st = await readStatus(paths)
      if (st.untracked.some((f) => f.path === path)) {
        await git(paths.root, ['add', '-N', '--', path])
      }
    }

    const args = [
      'diff',
      ...(action === 'unstage' ? ['--cached'] : []),
      '--no-color',
      '--no-ext-diff',
      '-U3',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--no-renames',
      '--text',
      '--',
      path
    ]
    const res = await git(paths.root, args)
    if (res.code !== 0) throw new Error(res.stderr.trim() || 'git diff failed')
    return parseUnifiedDiff(res.stdout.toString('utf8'))
  }

  /**
   * Apply just the selected lines.
   *
   *   stage    diff worktree-vs-index, apply forward onto the index
   *   unstage  diff index-vs-HEAD,     apply reversed onto the index
   *   discard  diff worktree-vs-index, apply reversed onto the worktree
   *
   * The patch goes in on stdin rather than via a file in the worktree: under core.autocrlf a
   * written patch file gets line-ending warnings and then shows up as untracked in the next
   * status. `--whitespace=nowarn` stops the user's apply.whitespace=fix from rewriting it, and
   * git apply is atomic per invocation, so a failure leaves nothing half-applied.
   */
  async applySelection(
    repoRoot: string,
    path: string,
    selectedIds: number[],
    action: SelectionAction
  ): Promise<{ applied: boolean }> {
    if (selectedIds.length === 0) return { applied: false }
    const { paths } = await this.repo(repoRoot)

    const parsed = await this.hunks(repoRoot, path, action)
    if (parsed.binary) throw new Error('cannot stage part of a binary file')

    const reverse = action !== 'stage'
    const patch = buildSelectionPatch(parsed, new Set(selectedIds), reverse)
    if (patch === null) return { applied: false }

    const args = [
      'apply',
      ...(action === 'discard' ? [] : ['--cached']),
      ...(reverse ? ['--reverse'] : []),
      '--whitespace=nowarn',
      '--recount',
      '-'
    ]
    const res = await git(paths.root, args, { stdin: patch })
    if (res.code !== 0) {
      const detail = res.stderr.trim()
      throw new Error(
        /patch failed|does not apply/.test(detail)
          ? `${detail}\nThe file changed on disk. Refresh and try again.`
          : detail || 'git apply failed'
      )
    }
    return { applied: true }
  }

  /**
   * `-A` rather than a bare `add`: it is the only form that stages a deletion as well as a
   * modification, so one code path covers every row in the panel.
   */
  async stage(repoRoot: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return
    const { paths: p } = await this.repo(repoRoot)
    await gitText(p.root, ['add', '-A', '--', ...paths])
  }

  async unstage(repoRoot: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return
    const { paths: p } = await this.repo(repoRoot)
    // On an unborn branch there is no HEAD to reset against; `rm --cached` is the equivalent.
    const hasHead = (await git(p.root, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0
    if (hasHead) await gitText(p.root, ['restore', '--staged', '--', ...paths])
    else await gitText(p.root, ['rm', '--cached', '-r', '--', ...paths])
  }

  /** Throw away working-tree changes. Untracked files are removed, tracked ones restored. */
  async discard(repoRoot: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return
    const { paths: p } = await this.repo(repoRoot)
    const status = await readStatus(p)
    const untracked = new Set(status.untracked.map((f) => f.path))

    const toRestore = paths.filter((x) => !untracked.has(x))
    const toClean = paths.filter((x) => untracked.has(x))

    if (toRestore.length) await gitText(p.root, ['restore', '--worktree', '--', ...toRestore])
    if (toClean.length) await gitText(p.root, ['clean', '-fdq', '--', ...toClean])
  }

  /**
   * Commit with the message on stdin.
   *
   * Never `-m`: it hits argument-length limits and joins paragraphs differently from a message
   * file. And never echo back the message the user typed — a `commit-msg` hook may have rewritten
   * it, so the recorded subject is re-read afterwards.
   */
  async commit(repoRoot: string, message: string, amend: boolean): Promise<{ sha: string }> {
    const { paths } = await this.repo(repoRoot)
    const args = ['commit', '-q', ...(amend ? ['--amend'] : []), '-F', '-']
    const res = await git(paths.root, args, { stdin: message })
    if (res.code !== 0) {
      const detail = [res.stderr.trim(), res.stdout.toString('utf8').trim()]
        .filter(Boolean)
        .join('\n')
      throw new Error(detail || 'git commit failed')
    }
    const sha = (await gitText(paths.root, ['rev-parse', 'HEAD'])).trim()
    return { sha }
  }

  /**
   * Watch these repositories and push a fresh status whenever anything changes, replacing the
   * renderer's polling. Called again on every workspace switch; repos no longer in the list are
   * released.
   */
  async watch(repoRoots: string[], onStatus: (status: RepoStatus) => void): Promise<void> {
    this.watchers ??= new ScmWatchers(async (paths) => {
      const status = await readStatus(paths)
      // Emit only when the status actually differs.
      //
      // Filesystem events are not the signal the UI wants; a change in what git reports is. This
      // matters beyond saving renders: we deliberately let git write back its refreshed index
      // (see the --no-optional-locks note in exec.ts), so our own `git status` mutates
      // .git/index, which trips the watcher, which runs status again. Comparing results breaks
      // that loop at the only place it can be broken correctly.
      const key = statusKey(status)
      if (this.lastStatusKey.get(paths.root) === key) return
      this.lastStatusKey.set(paths.root, key)
      onStatus(status)
    })

    const resolved: string[] = []
    for (const root of repoRoots) {
      try {
        const { paths } = await this.repo(root)
        resolved.push(paths.root)
        await this.watchers.watch(paths)

        // Read and publish once at subscribe time, which both hands the caller the authoritative
        // current state and seeds the comparison key. Without the seed the very first filesystem
        // event always emits, even when nothing changed — and one is guaranteed, because our own
        // `git status` lets git write back its refreshed index.
        const status = await readStatus(paths)
        this.lastStatusKey.set(paths.root, statusKey(status))
        onStatus(status)
      } catch (err) {
        console.warn(`[git] cannot watch ${root}: ${String(err)}`)
      }
    }
    await this.watchers.retain(new Set(resolved))
  }

  /**
   * Async because releasing a filesystem watcher is async all the way down, and the quit path has
   * to be able to wait for it — an unsubscribe still in flight when Node tears the environment
   * down aborts the process. See `ScmWatchers.unwatch`.
   */
  async dispose(): Promise<void> {
    this.lastStatusKey.clear()
    // Detached before the await so a `watch()` racing the teardown builds a fresh ScmWatchers
    // rather than adding subscriptions to the one being torn down.
    const watchers = this.watchers
    this.watchers = null
    await watchers?.dispose()
    for (const repo of new Set(this.repos.values())) repo.blobs.dispose()
    this.repos.clear()
  }
}


/**
 * Identity of a status for change detection. `at` is excluded — it is a timestamp, so including
 * it would make every refresh look like a change and defeat the whole point.
 */
function statusKey(s: RepoStatus): string {
  const files = (fs: RepoStatus['staged']): string =>
    fs.map((f) => `${f.path}:${f.origPath ?? ''}:${f.index}${f.worktree}`).join('|')
  return [
    s.branch,
    s.upstream,
    s.ahead,
    s.behind,
    s.detachedAt,
    s.operation,
    s.stashCount,
    files(s.staged),
    files(s.unstaged),
    files(s.untracked),
    files(s.conflicts)
  ].join('\u001f')
}
