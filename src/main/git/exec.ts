import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * Running git.
 *
 * Two decisions here were measured rather than assumed, on a 96k-file repository:
 *
 *  - **Shell out to the git binary.** `simple-git` is 23x slower (it hardcodes `--porcelain`
 *    v1 and `-u`, i.e. `-uall`), and libgit2 via `@napi-rs/simple-git` is 30x slower and blocks
 *    the JS thread, because it has neither the untracked cache nor fsmonitor. The real binary
 *    also honours the user's credential helpers, hooks, GPG agent, LFS filters and
 *    `.gitattributes`, which the libraries each get some subset of wrong.
 *
 *  - **Resolve the binary once.** On macOS `/usr/bin/git` is the xcode-select shim: it
 *    re-resolves DEVELOPER_DIR and re-execs on every call, measured at 31-50 ms per spawn
 *    against 10-13 ms for the real binary. A panel refresh runs several git commands, so that
 *    difference is the whole latency budget.
 */

let gitBin: Promise<string> | null = null

export function resolveGitBinary(): Promise<string> {
  gitBin ??= locate()
  return gitBin
}

async function locate(): Promise<string> {
  const candidates: string[] = []

  if (process.platform === 'darwin') {
    // xcrun reports the real binary behind the shim.
    const found = await tryExec('/usr/bin/xcrun', ['--find', 'git'])
    if (found) candidates.push(found.trim())
    candidates.push('/opt/homebrew/bin/git', '/usr/local/bin/git')
  } else if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    candidates.push(`${pf}\\Git\\cmd\\git.exe`)
  }

  for (const candidate of candidates) {
    if (await tryExec(candidate, ['--version'])) return candidate
  }
  // Fall back to PATH resolution. ensureShellPath() has already repaired PATH by this point.
  return 'git'
}

function tryExec(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5000, encoding: 'utf8' }, (err, stdout) =>
      resolve(err ? null : stdout)
    )
  })
}

/**
 * Environment for every git child.
 *
 * Note what is deliberately absent: GIT_OPTIONAL_LOCKS. Setting it (as VSCode's git extension
 * does) stops git writing back the refreshed index, so after any bulk mtime change — a build,
 * an install, a branch switch in the user's own terminal — every subsequent status re-hashes
 * those files. Measured: 108 ms becomes 959-1263 ms, permanently, until something else
 * refreshes the index. If another git holds index.lock, git skips the writeback on its own and
 * still exits 0.
 *
 * LC_ALL is also absent: porcelain output is already locale-independent, and forcing C would
 * mangle the user's commit messages.
 */
function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0', // never block on a terminal that does not exist
    GIT_PAGER: 'cat', // core.pager=less would hang forever
    PAGER: 'cat',
    GIT_EDITOR: 'true', // an accidental interactive command aborts instead of hanging
    ...extra
  }
}

export interface GitResult {
  stdout: Buffer
  stderr: string
  code: number
}

/**
 * Run git and return raw bytes. Paths are bytes on disk and may not be valid UTF-8, so the
 * caller decides how to decode. Never uses a shell; always an argv array.
 */
export function git(
  cwd: string,
  args: string[],
  opts: { stdin?: string; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<GitResult> {
  return resolveGitBinary().then(
    (bin) =>
      new Promise<GitResult>((resolve, reject) => {
        const child = execFile(
          bin,
          args,
          {
            cwd,
            env: gitEnv(opts.env),
            encoding: 'buffer',
            maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
            windowsHide: true
          },
          (err, stdout, stderr) => {
            const code =
              err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
                ? ((err as unknown as { code: number }).code)
                : err
                  ? 1
                  : 0
            // A non-zero exit is normal for plenty of git commands, so it is reported rather
            // than thrown. Only a failure to spawn at all rejects.
            if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(err)
            resolve({ stdout: stdout as Buffer, stderr: (stderr as Buffer).toString('utf8'), code })
          }
        )
        if (opts.stdin !== undefined) {
          child.stdin?.end(opts.stdin)
        }
      })
  )
}

/** Run git, returning stdout as text, and throw with git's own stderr when it fails. */
export async function gitText(cwd: string, args: string[], stdin?: string): Promise<string> {
  const res = await git(cwd, args, { stdin })
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.toString('utf8').trim() || `git ${args[0]} failed`)
  }
  return res.stdout.toString('utf8')
}

export function gitSpawn(cwd: string, args: string[], bin: string): ChildProcessWithoutNullStreams {
  return spawn(bin, args, { cwd, env: gitEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
}
