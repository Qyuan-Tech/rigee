import { MessageChannelMain, type MessagePortMain, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { readFile, readlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { IPty } from 'node-pty'

/**
 * Terminals, one pseudo-terminal per pane.
 *
 * This replaced a tmux control-mode client. tmux bought session persistence — terminals that
 * outlive the app and can be re-attached from outside it — at the cost of an intricate protocol
 * between us and the shell. Without it a terminal is just a pty, splits are ours to lay out
 * rather than tmux's to mirror, and Windows no longer needs WSL. Anyone who wants tmux can still
 * type `tmux`; it is only the integration that is gone.
 *
 * Bytes do not travel over ipcMain. A busy build or an agent streaming output is thousands of
 * writes per second, and every one would be a structured-clone hop through the single
 * ipcRenderer queue, competing with every other message in the app. Each workspace gets a
 * MessagePort instead, with output coalesced per flush tick: at that rate the postMessage
 * overhead dominates, while xterm is happy to receive one large write.
 */

/** Long enough to coalesce a firehose, short enough to be invisible while typing. */
const FLUSH_MS = 6

/** Per-workspace cap between flushes; beyond this, flush early rather than grow. */
const FLUSH_BYTES = 64 * 1024

/** A pane that produces more than this between flushes is dropped down to its tail. */
const MAX_PENDING_BYTES = 4 * 1024 * 1024

export interface SpawnOptions {
  workspaceId: string
  cwd: string
  /** A live pane to start beside: in the directory its shell is in now. `cwd` if that fails. */
  cwdFrom?: string
  cols: number
  rows: number
  /** Extra environment for this terminal, e.g. a workspace-specific variable. */
  env?: Record<string, string>
}

interface Pane {
  id: string
  pty: IPty
  workspaceId: string
  /** Where the shell started: what `cwdOf` answers when where it is now cannot be read. */
  cwd: string
  /** Bytes waiting for the next flush. */
  pending: string[]
  pendingBytes: number
}

/** A process asked about that never answers must not hold up a split, or a close. */
const PROBE_TIMEOUT_MS = 2000

interface Workspace {
  port: MessagePortMain | null
  panes: Set<string>
  timer: NodeJS.Timeout | null
  queuedBytes: number
}

type NodePty = typeof import('node-pty')

export class PtyManager {
  private readonly panes = new Map<string, Pane>()
  private readonly workspaces = new Map<string, Workspace>()
  private seq = 0
  private pty: NodePty | null = null

  constructor(
    private readonly shell: () => WebContents | null,
    /** Told when a pane's process exits, so the UI can close or mark it. */
    private readonly onExit: (workspaceId: string, paneId: string, exitCode: number) => void
  ) {}

  /**
   * node-pty is a native module; importing it eagerly costs 230-1000 ms of dlopen and N-API init
   * on the whenReady path, for something no window needs before the first terminal opens.
   */
  private async load(): Promise<NodePty> {
    this.pty ??= (await import('node-pty')) as unknown as NodePty
    return this.pty
  }

  private workspace(id: string): Workspace {
    let ws = this.workspaces.get(id)
    if (!ws) {
      ws = { port: null, panes: new Set(), timer: null, queuedBytes: 0 }
      this.workspaces.set(id, ws)
    }
    return ws
  }

  async spawn(opts: SpawnOptions): Promise<{ paneId: string }> {
    const pty = await this.load()
    const { file, args } = defaultShell()
    // A split starts where the pane it came from is now, not back at the workspace's first folder.
    const wanted = (opts.cwdFrom ? await this.cwdOf(opts.cwdFrom) : null) ?? (opts.cwd || homedir())
    // A directory that has gone — a workspace file moved, a repo deleted — does not fail the spawn:
    // the shell starts, cannot chdir and exits with nothing said, and the new tab flashes and is gone.
    const cwd = isDirectory(wanted) ? wanted : homedir()

    const child = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: Math.max(2, opts.cols),
      rows: Math.max(1, opts.rows),
      cwd,
      env: {
        ...process.env,
        ...opts.env,
        TERM: 'xterm-256color',
        // Tells anything that cares which terminal it is running under, the way iTerm and
        // VS Code both do.
        TERM_PROGRAM: 'rigee',
        COLORTERM: 'truecolor'
      } as Record<string, string>
    })

    const paneId = `pane${++this.seq}`
    const pane: Pane = { id: paneId, pty: child, workspaceId: opts.workspaceId, cwd, pending: [], pendingBytes: 0 }
    this.panes.set(paneId, pane)
    this.workspace(opts.workspaceId).panes.add(paneId)

    child.onData((chunk) => this.enqueue(pane, chunk))
    child.onExit(({ exitCode }) => {
      this.flush(opts.workspaceId) // do not lose the last few bytes before the prompt died
      this.panes.delete(paneId)
      this.workspaces.get(opts.workspaceId)?.panes.delete(paneId)
      this.onExit(opts.workspaceId, paneId, exitCode)
    })

    return { paneId }
  }

  write(paneId: string, data: string): void {
    this.panes.get(paneId)?.pty.write(data)
  }

  resize(paneId: string, cols: number, rows: number): void {
    const pane = this.panes.get(paneId)
    if (!pane) return
    try {
      pane.pty.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows)))
    } catch {
      // The process can exit between the renderer measuring and this arriving.
    }
  }

  kill(paneId: string): void {
    const pane = this.panes.get(paneId)
    if (!pane) return
    try { pane.pty.kill() } catch { /* already gone */ }
  }

  /**
   * The directory a pane's shell is in now, after any `cd` — or, when that cannot be read, the one
   * it started in. Null for a pane that has gone.
   *
   * Asked of the operating system rather than reported by the shell. An OSC 7 report needs shell
   * integration nobody has to have set up, and from inside an ssh session it names a directory on
   * the other machine. The SHELL is asked, not whatever program runs in front of it: where `claude`
   * was started is where its shell still is, and that is the answer VS Code's split gives too.
   */
  async cwdOf(paneId: string): Promise<string | null> {
    const pane = this.panes.get(paneId)
    if (!pane) return null
    const now = await processCwd(pane.pty.pid)
    return now && isDirectory(now) ? now : pane.cwd
  }

  /**
   * Which of these panes have a program in the foreground rather than a shell at its prompt, and
   * what each program is called. Asked before a bulk close stops them.
   *
   * "In the foreground" is the terminal's own answer: its foreground process group is not the
   * shell's. Comparing NAMES instead would call every pane busy for somebody whose login shell
   * `exec`s another one from its rc file. Windows has no such answer to give, so nothing there
   * counts as running.
   */
  async running(paneIds: readonly string[]): Promise<Array<{ paneId: string; process: string }>> {
    if (process.platform === 'win32') return []
    const panes = paneIds.flatMap((id) => this.panes.get(id) ?? [])
    if (panes.length === 0) return []
    const groups = await foregroundGroups(panes.map((p) => p.pty.pid))
    return panes
      .filter((p) => {
        const group = groups.get(p.pty.pid)
        return group !== undefined && group > 0 && group !== p.pty.pid
      })
      .map((p) => ({ paneId: p.id, process: programName(p.pty.process) }))
  }

  /** Hand the renderer one end of a dedicated channel for this workspace's terminal bytes. */
  establishPort(workspaceId: string): void {
    const wc = this.shell()
    if (!wc) return
    const ws = this.workspace(workspaceId)

    ws.port?.close()
    const { port1, port2 } = new MessageChannelMain()
    ws.port = port1

    port1.on('message', (event) => {
      // Keystrokes come back the same way, so typing never queues behind whatever else
      // ipcRenderer is doing.
      const msg = event.data as { paneId: string; data: string }
      if (!msg || typeof msg.paneId !== 'string') return
      this.write(msg.paneId, msg.data)
    })
    port1.start()

    wc.postMessage('terminal:port', { workspaceId }, [port2])
  }

  private enqueue(pane: Pane, chunk: string): void {
    pane.pending.push(chunk)
    pane.pendingBytes += chunk.length

    // Backpressure: if the renderer cannot keep up, keep the tail rather than the head. A
    // terminal's value is in what just happened, and the alternative is unbounded memory.
    if (pane.pendingBytes > MAX_PENDING_BYTES) {
      const tail = pane.pending.join('').slice(-MAX_PENDING_BYTES / 2)
      pane.pending = [tail]
      pane.pendingBytes = tail.length
    }

    const ws = this.workspace(pane.workspaceId)
    ws.queuedBytes += chunk.length
    if (ws.queuedBytes >= FLUSH_BYTES) {
      this.flush(pane.workspaceId)
      return
    }
    ws.timer ??= setTimeout(() => this.flush(pane.workspaceId), FLUSH_MS)
  }

  private flush(workspaceId: string): void {
    const ws = this.workspaces.get(workspaceId)
    if (!ws) return
    if (ws.timer) { clearTimeout(ws.timer); ws.timer = null }
    ws.queuedBytes = 0
    if (!ws.port) return

    for (const paneId of ws.panes) {
      const pane = this.panes.get(paneId)
      if (!pane || pane.pending.length === 0) continue
      const data = pane.pending.join('')
      pane.pending = []
      pane.pendingBytes = 0
      ws.port.postMessage({ paneId, data })
    }
  }

  disconnect(workspaceId: string): void {
    const ws = this.workspaces.get(workspaceId)
    if (!ws) return
    this.workspaces.delete(workspaceId)
    if (ws.timer) clearTimeout(ws.timer)
    ws.port?.close()
    for (const paneId of ws.panes) this.kill(paneId)
  }

  disposeAll(): void {
    for (const id of [...this.workspaces.keys()]) this.disconnect(id)
    for (const paneId of [...this.panes.keys()]) this.kill(paneId)
    this.panes.clear()
  }
}

/**
 * The shell to run.
 *
 * macOS terminals start a LOGIN shell, which is what makes /etc/paths, .zprofile and friends
 * apply; on Linux an interactive non-login shell is the convention and reads .bashrc. On Windows
 * ConPTY hosts PowerShell directly — with tmux gone there is no reason to require WSL.
 */
function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.COMSPEC ?? 'powershell.exe', args: [] }
  }
  const file = process.env.SHELL ?? '/bin/bash'
  return { file, args: process.platform === 'darwin' ? ['-l'] : [] }
}

/** A child's output even when it exits non-zero: `ps` does that when one of the pids has gone. */
function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' }, (_err, stdout) => resolve(stdout ?? ''))
  })
}

/**
 * Where a process is now. Linux says so in /proc. macOS has no /proc, but lsof is part of the base
 * system there and answers in about a tenth of a second — `-b` and `-w` so a hung network mount
 * can neither block it nor fill its output with warnings. Windows offers nothing comparable, so a
 * split there starts where the pane it came from started.
 */
async function processCwd(pid: number): Promise<string | null> {
  if (process.platform === 'win32') return null
  if (process.platform === 'linux') return readlink(`/proc/${pid}/cwd`).catch(() => null)
  const lsof = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof'
  const out = await run(lsof, ['-a', '-n', '-P', '-b', '-w', '-p', String(pid), '-d', 'cwd', '-Fn'])
  const line = out.split('\n').find((l) => l.startsWith('n'))
  return line ? line.slice(1) : null
}

/**
 * Each process's terminal foreground process group — `tpgid` — by pid. A pid that has gone, or a
 * system that will not say, is simply missing, and missing counts as not running.
 */
async function foregroundGroups(pids: readonly number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (process.platform === 'linux') {
    await Promise.all(
      pids.map(async (pid) => {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '')
        // The command name sits in parentheses and may contain anything, parentheses included; the
        // fields after the LAST `)` are fixed, and tpgid is the sixth of them.
        const tpgid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[5])
        if (stat && Number.isInteger(tpgid)) out.set(pid, tpgid)
      })
    )
    return out
  }
  for (const line of (await run('ps', ['-o', 'pid=,tpgid=', '-p', pids.join(',')])).split('\n')) {
    const [pid, tpgid] = line.trim().split(/\s+/).map(Number)
    if (Number.isInteger(pid) && Number.isInteger(tpgid)) out.set(pid!, tpgid!)
  }
  return out
}

/** `claude`, not `/usr/local/bin/claude`; `bash`, not the `-bash` a login shell is listed as. */
function programName(raw: string): string {
  return raw.replace(/^-/, '').split(/[\\/]/).pop() || raw
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
