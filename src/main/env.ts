import { execFile } from 'node:child_process'

/**
 * Recover the PATH the user actually has in their shell.
 *
 * A GUI-launched app does not inherit your shell environment. On macOS, launchd hands the process
 * whatever `launchctl getenv PATH` holds — normally nothing — so an app opened from Finder or the
 * Dock runs with:
 *
 *     PATH=/usr/bin:/bin:/usr/sbin:/sbin
 *
 * (measured, on this project, which is how this module came to exist). Everything installed by
 * Homebrew, nvm, asdf, mise, pyenv, cargo or a package manager's user prefix is invisible.
 * `tmux` at /usr/local/bin is the first casualty, and the failure looks like "tmux not found on
 * PATH" even though `which tmux` in a terminal answers immediately.
 *
 * The same applies to Linux desktop launchers. Running from a terminal — including `pnpm dev` —
 * inherits a correct PATH, which is exactly why this only shows up in packaged builds.
 *
 * Fix: ask the user's login shell, once, what PATH it ends up with, and merge it in.
 */

/** Framing so shell banners, MOTDs and rc-file chatter cannot be mistaken for the value. */
const DELIMITER = '__onestop_path_delimiter__'

/** A slow rc file should degrade to the fallback, not hang startup. */
const TIMEOUT_MS = 5000

/**
 * Last-resort additions when the shell probe fails. Deliberately short: these are the standard
 * package-manager prefixes, not a guess at the user's setup.
 */
const FALLBACK_DIRS = [
  '/opt/homebrew/bin', // Homebrew on Apple Silicon
  '/usr/local/bin', // Homebrew on Intel, and most `make install` targets
  '/opt/local/bin', // MacPorts
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
]

let resolved: Promise<void> | null = null

/**
 * Resolve and apply the login-shell PATH. Idempotent, and safe to await from several places —
 * the shell is only ever spawned once.
 */
export function ensureShellPath(): Promise<void> {
  resolved ??= resolve()
  return resolved
}

async function resolve(): Promise<void> {
  // Windows has no equivalent problem: GUI processes inherit the full user and system PATH.
  if (process.platform === 'win32') return

  const before = process.env.PATH ?? ''
  let fromShell: string | null = null

  try {
    fromShell = await probeLoginShell()
  } catch {
    fromShell = null
  }

  const merged = mergePaths(fromShell ?? '', before, FALLBACK_DIRS)
  process.env.PATH = merged

  if (merged !== before) {
    console.log(
      `[env] PATH recovered from ${fromShell ? 'login shell' : 'fallback list'}: ` +
        `${before.split(':').length} entries -> ${merged.split(':').length}`
    )
  }
}

function probeLoginShell(): Promise<string> {
  const shell = process.env.SHELL ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')

  return new Promise((resolvePath, reject) => {
    // -l runs the login files (.zprofile, .bash_profile), -i the interactive ones (.zshrc,
    // .bashrc). Both are needed: people put PATH edits in either. `printenv` rather than `echo
    // $PATH` keeps this working under fish, where $PATH is a list.
    execFile(
      shell,
      ['-ilc', `printf %s '${DELIMITER}'; printenv PATH; printf %s '${DELIMITER}'`],
      { timeout: TIMEOUT_MS, encoding: 'utf8', env: { ...process.env, TERM: 'dumb' } },
      (err, stdout) => {
        if (err && !stdout) return reject(err)
        const first = stdout.indexOf(DELIMITER)
        const second = stdout.indexOf(DELIMITER, first + DELIMITER.length)
        if (first < 0 || second < 0) return reject(new Error('delimiters not found in shell output'))
        const value = stdout.slice(first + DELIMITER.length, second).trim()
        if (!value) return reject(new Error('shell reported an empty PATH'))
        resolvePath(value)
      }
    )
  })
}

/**
 * Combine PATH sources, first occurrence wins, blanks and duplicates dropped.
 * The shell's own ordering is preserved because it is passed first.
 */
function mergePaths(...sources: Array<string | string[]>): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const source of sources) {
    const entries = Array.isArray(source) ? source : source.split(':')
    for (const entry of entries) {
      const dir = entry.trim()
      if (!dir || seen.has(dir)) continue
      seen.add(dir)
      out.push(dir)
    }
  }
  return out.join(':')
}
