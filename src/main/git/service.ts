import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BlobReader, looksBinary } from './blobs'
import { git, gitText } from './exec'
import { readStatus, resolveRepoPaths, type RepoPaths } from './status'
import type { DiffTarget, RepoStatus } from '@shared/types'

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

  dispose(): void {
    for (const repo of new Set(this.repos.values())) repo.blobs.dispose()
    this.repos.clear()
  }
}
