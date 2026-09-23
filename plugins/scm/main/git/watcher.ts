import watcher, { type AsyncSubscription, type Event } from '@parcel/watcher'
import type { RepoPaths } from './status'

/**
 * Filesystem watching for the source control panel.
 *
 * Why @parcel/watcher and not chokidar: chokidar opens one non-recursive fs.watch (a kqueue fd)
 * per directory, and a GUI-launched Electron app on macOS inherits `launchctl limit maxfiles`,
 * whose soft limit is **256** — not the 1M a terminal reports. Watching any real repository
 * crashes the process with EMFILE. @parcel/watcher uses one FSEvents stream on macOS,
 * ReadDirectoryChangesW on Windows and inotify on Linux; subscribing to a 96k-file worktree was
 * measured at 12 ms with a 14 ms event latency.
 *
 * Two subscriptions per repo, because the two answer different questions:
 *   worktree -> did the files change (an agent writing code, an editor saving)
 *   git dir  -> did the index, HEAD, refs or an in-progress operation change
 */

/** Directories that are never interesting and are expensive to watch. */
const WORKTREE_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/target/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/.venv/**',
  '**/__pycache__/**',
  '**/.mypy_cache/**',
  '**/.pytest_cache/**',
  '**/.gradle/**',
  '**/vendor/**'
]

/**
 * `objects` must be ignored or a single fetch delivers thousands of events.
 *
 * `fsmonitor--daemon` matters more subtly: its cookie files are created and deleted by *every*
 * `git status`, including the ones this panel runs. Watching them is a feedback loop that
 * refreshes forever.
 */
const GITDIR_IGNORE = [
  '**/objects/**',
  '**/lfs/**',
  '**/modules/**',
  '**/fsmonitor--daemon/**',
  '**/fsmonitor--daemon.ipc',
  '**/worktrees/*/objects/**'
]

/** A single save is one event; a 2000-file burst lands within 60 ms of the last write. */
const WORKTREE_DEBOUNCE_MS = 150
const WORKTREE_MAX_WAIT_MS = 600

/** Few and far between, and the user is watching for the result of their own commit. */
const GITDIR_DEBOUNCE_MS = 50

/** Used when inotify watches are exhausted; the git dir alone is tiny, so this stays cheap. */
const FALLBACK_POLL_MS = 3000

export type WatchReason = 'worktree' | 'gitdir' | 'poll'

interface Entry {
  paths: RepoPaths
  subs: AsyncSubscription[]
  timer: NodeJS.Timeout | null
  maxTimer: NodeJS.Timeout | null
  poll: NodeJS.Timeout | null
  /** A refresh is running; further events set `dirty` instead of queueing another. */
  running: boolean
  dirty: boolean
  pendingReason: WatchReason
}

export class ScmWatchers {
  private readonly entries = new Map<string, Entry>()

  constructor(
    /** Runs one refresh for the repo. Never called concurrently for the same repo. */
    private readonly refresh: (paths: RepoPaths, reason: WatchReason) => Promise<void>
  ) {}

  async watch(paths: RepoPaths): Promise<void> {
    if (this.entries.has(paths.root)) return
    const entry: Entry = {
      paths,
      subs: [],
      timer: null,
      maxTimer: null,
      poll: null,
      running: false,
      dirty: false,
      pendingReason: 'worktree'
    }
    this.entries.set(paths.root, entry)

    const worktreeOk = await this.subscribe(entry, paths.root, WORKTREE_IGNORE, 'worktree')

    // A linked worktree keeps per-worktree state in gitDir and shared refs in commonDir.
    const gitDirs = new Set([paths.gitDir, paths.commonDir])
    for (const dir of gitDirs) {
      await this.subscribe(entry, dir, GITDIR_IGNORE, 'gitdir')
    }

    if (!worktreeOk) {
      // Linux inotify allocates one watch descriptor per directory and the per-user limit is
      // finite; a big node_modules exhausts it. Degrading to a poll is far better than crashing,
      // and `git status` with fsmonitor is cheap enough to poll.
      console.warn(
        `[scm] falling back to polling for ${paths.root}. On Linux raise the limit with:\n` +
          '      sudo sysctl fs.inotify.max_user_watches=524288'
      )
      entry.poll = setInterval(() => this.run(entry, 'poll'), FALLBACK_POLL_MS)
    }
  }

  private async subscribe(
    entry: Entry,
    dir: string,
    ignore: string[],
    reason: WatchReason
  ): Promise<boolean> {
    try {
      const sub = await watcher.subscribe(
        dir,
        (err, events) => {
          if (err) {
            console.warn(`[scm] watcher error on ${dir}: ${err.message}`)
            return
          }
          if (!interesting(events)) return
          this.schedule(entry, reason)
        },
        { ignore }
      )
      entry.subs.push(sub)
      return true
    } catch (err) {
      // ENOSPC on Linux means inotify watches are exhausted. Never let that kill the app.
      console.warn(`[scm] cannot watch ${dir}: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /** Trailing debounce, with a ceiling so a long build still refreshes periodically. */
  private schedule(entry: Entry, reason: WatchReason): void {
    entry.pendingReason = reason
    const wait = reason === 'gitdir' ? GITDIR_DEBOUNCE_MS : WORKTREE_DEBOUNCE_MS

    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => this.fire(entry), wait)

    if (!entry.maxTimer && reason !== 'gitdir') {
      entry.maxTimer = setTimeout(() => this.fire(entry), WORKTREE_MAX_WAIT_MS)
    }
  }

  private fire(entry: Entry): void {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    if (entry.maxTimer) { clearTimeout(entry.maxTimer); entry.maxTimer = null }
    this.run(entry, entry.pendingReason)
  }

  /**
   * One refresh in flight per repo. Events arriving during a refresh set a dirty flag and cause
   * exactly one more run, rather than queueing — a build touching 2000 files must not enqueue
   * 2000 `git status` calls.
   */
  private run(entry: Entry, reason: WatchReason): void {
    if (entry.running) {
      entry.dirty = true
      return
    }
    entry.running = true
    void this.refresh(entry.paths, reason)
      .catch((err: unknown) => {
        console.warn(`[scm] refresh failed for ${entry.paths.root}: ${String(err)}`)
      })
      .finally(() => {
        entry.running = false
        if (entry.dirty) {
          entry.dirty = false
          this.run(entry, reason)
        }
      })
  }

  /**
   * Stop watching one repo, and WAIT until the native subscriptions are really gone.
   *
   * The await is the whole point of this method's signature, and it was missing. `unsubscribe()`
   * is not bookkeeping: it schedules work on @parcel/watcher's own thread and completes through a
   * napi async callback. Start one and let the process quit underneath it and that callback
   * arrives while Node is already tearing the environment down — napi has nowhere to deliver it,
   * calls `napi_fatal_error`, and the app dies with SIGABRT in `Environment::RunCleanup` instead
   * of exiting. Observed exactly that on a packaged build after a normal Cmd+Q:
   *
   *     watcher.node … PromiseRunner::onWorkComplete → napi_fatal_error → abort()
   *
   * So every caller on the quit path has to be able to wait, which means this returns a promise
   * and `dispose` awaits all of them.
   */
  async unwatch(repoRoot: string): Promise<void> {
    const entry = this.entries.get(repoRoot)
    if (!entry) return
    this.entries.delete(repoRoot)
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.maxTimer) clearTimeout(entry.maxTimer)
    if (entry.poll) clearInterval(entry.poll)
    // Emptied before awaiting, so a second unwatch of the same repo cannot unsubscribe twice.
    const subs = entry.subs.splice(0)
    await Promise.all(subs.map((sub) => sub.unsubscribe().catch(() => { /* already gone */ })))
  }

  /** Stop watching everything not in `keep`, so switching workspace releases the old repos. */
  async retain(keep: Set<string>): Promise<void> {
    const doomed = [...this.entries.keys()].filter((root) => !keep.has(root))
    await Promise.all(doomed.map((root) => this.unwatch(root)))
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((root) => this.unwatch(root)))
  }
}

/**
 * git writes `foo.lock`, then renames it over `foo`. The lock file is noise; the rename is the
 * event that matters, and it arrives separately.
 */
function interesting(events: Event[]): boolean {
  return events.some((e) => !e.path.endsWith('.lock'))
}
