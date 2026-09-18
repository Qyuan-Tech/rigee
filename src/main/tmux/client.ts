import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TmuxStreamParser, type TmuxParserSink } from './parser'
import { diffPanes, parseLayout, type LayoutParseError } from './layout'
import type { TmuxLayoutNode, TmuxPane, TmuxWindow } from '@shared/types'

/**
 * A tmux control-mode client: one per onestop workspace, owning one tmux session.
 *
 * Mapping: workspace -> tmux session, terminal tab -> tmux window, split -> tmux pane.
 *
 * Non-obvious constraints, each verified against tmux 3.6a:
 *
 *  - Use `-C`, never `-CC`. `-CC` calls tcgetattr(stdin) and exits 1 when stdin is not a tty,
 *    and wraps the stream in a DCS envelope. `-C` needs no tty at all, which is also what lets
 *    the Windows path pipe through `wsl.exe` without ConPTY.
 *
 *  - Always attach with `-f pause-after=N`. Without it, tmux's control_check_age() kills the
 *    client once the head of the output queue is 300 s old ("too far behind"), taking the whole
 *    terminal subsystem with it.
 *
 *  - Only guard blocks with flags == 1 are responses to commands we sent. Config parsing and
 *    hooks also emit blocks, sharing the same server-global command counter, so a FIFO that pops
 *    on every %begin desynchronises permanently.
 *
 *  - Never issue run-shell / if-shell / display-popup on this stream. Their output is printed
 *    later by an async callback with no guard framing at all, so a payload containing
 *    "%output %9 …" or "%exit" is indistinguishable from a real notification.
 *
 *  - A single empty line written to stdin detaches the client.
 */

/** Seconds. tmux's own socket buffer is 8 KiB, so age reflects real consumer lag, not jitter. */
const PAUSE_AFTER_SECONDS = 2

/** Above this many bytes, a write goes through load-buffer/paste-buffer instead of send-keys. */
const SEND_KEYS_MAX_BYTES = 64

/** send-keys -H hex args are yacc tokens; 16384 bytes overflows the parser stack. */
const SEND_KEYS_CHUNK = 1024

/** Field separator for list-* formats. Legal raw in a command line; only \n is forbidden. */
const FS = '\x1f'

/** Wrap user-controlled format variables: a newline in a value breaks the line framing. */
const nl = (v: string): string => `#{s/\\n/ /:${v}}`

const LIST_WINDOWS_FORMAT = [
  '#{session_id}',
  '#{window_id}',
  '#{window_index}',
  nl('window_name'),
  '#{window_active}',
  '#{window_width}',
  '#{window_height}',
  '#{window_zoomed_flag}',
  '#{window_layout}',
  '#{window_visible_layout}'
].join(FS)

const LIST_PANES_FORMAT = [
  '#{window_id}',
  '#{pane_id}',
  '#{pane_active}',
  '#{pane_width}',
  '#{pane_height}',
  '#{pane_left}',
  '#{pane_top}',
  nl('pane_current_path'),
  nl('pane_current_command'),
  nl('pane_title'),
  '#{pane_in_mode}',
  '#{pane_dead}'
].join(FS)

export interface TmuxClientOptions {
  sessionName: string
  cwd: string
  /** Absolute path to a private socket, so we can never touch the user's default server. */
  socketPath: string
  /** Optional config file; pass '/dev/null' for a pristine session. */
  configFile?: string
  cols: number
  rows: number
  /** On win32 the command is routed through WSL. */
  useWsl?: boolean
}

interface PendingCommand {
  resolve: (lines: string[]) => void
  reject: (err: Error) => void
  command: string
}

export interface TmuxClientEvents {
  output: (paneId: string, data: Uint8Array) => void
  state: (windows: TmuxWindow[], panes: TmuxPane[]) => void
  paneExit: (paneId: string) => void
  exit: (reason: string, code: number | null) => void
  anomaly: (reason: string, sample: string) => void
}

export declare interface TmuxClient {
  on<K extends keyof TmuxClientEvents>(e: K, l: TmuxClientEvents[K]): this
  emit<K extends keyof TmuxClientEvents>(e: K, ...a: Parameters<TmuxClientEvents[K]>): boolean
}

export class TmuxClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private parser: TmuxStreamParser
  private readonly pending: PendingCommand[] = []
  /** Body lines of the guard block currently open, when it is one of ours. */
  private blockLines: string[] = []
  private blockIsOurs = false
  private exited = false

  private readonly windows = new Map<string, TmuxWindow>()
  private readonly panes = new Map<string, TmuxPane>()
  private readonly layouts = new Map<string, TmuxLayoutNode>()

  /** Panes we have proactively paused because the renderer fell behind. */
  private readonly desynced = new Set<string>()
  private readonly resizeTimers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly opts: TmuxClientOptions) {
    super()
    this.parser = new TmuxStreamParser(this.sink())
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    const tmuxArgs = [
      '-S', this.opts.socketPath,
      '-C',
      ...(this.opts.configFile ? ['-f', this.opts.configFile] : []),
      'new-session',
      '-A',              // attach if the session exists
      '-D',              // detach any other client, so we are the only size negotiator
      '-s', this.opts.sessionName,
      '-x', String(this.opts.cols),
      '-y', String(this.opts.rows),
      '-c', this.opts.cwd,
      // The subcommand's own -f is client-flags, distinct from the global config-file -f above.
      '-f', `pause-after=${PAUSE_AFTER_SECONDS}`
    ]

    const [file, args] = this.opts.useWsl
      ? ['wsl.exe', ['--', 'tmux', ...tmuxArgs]]
      : ['tmux', tmuxArgs]

    const proc = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc

    proc.stdout.on('data', (chunk: Buffer) => this.parser.push(chunk))
    proc.stderr.on('data', (chunk: Buffer) => {
      this.emit('anomaly', 'stderr', chunk.toString('utf8').slice(0, 400))
    })
    proc.on('error', (err) => this.fail(`spawn failed: ${err.message}`, null))
    proc.on('exit', (code) => {
      if (!this.exited) this.fail('tmux client exited', code)
    })

    // Attaching to an existing session emits no inventory at all — no %window-add, no panes, no
    // layout. The only way to learn the current state is to ask.
    await this.refreshState()
  }

  dispose(): void {
    if (this.exited) return
    this.exited = true
    for (const t of this.resizeTimers.values()) clearTimeout(t)
    this.resizeTimers.clear()
    for (const p of this.pending.splice(0)) p.reject(new Error('client disposed'))
    const proc = this.proc
    this.proc = null
    if (proc && !proc.killed) {
      // An empty line is the documented, graceful way to detach a control client.
      try { proc.stdin.write('\n') } catch { /* already gone */ }
      setTimeout(() => { if (!proc.killed) proc.kill('SIGTERM') }, 250).unref()
    }
  }

  private fail(reason: string, code: number | null): void {
    if (this.exited) return
    this.exited = true
    for (const p of this.pending.splice(0)) p.reject(new Error(reason))
    this.emit('exit', reason, code)
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Send one command and resolve with its guard-block body lines.
   * Rejects if tmux answers with %error.
   */
  command(cmd: string): Promise<string[]> {
    if (this.exited || !this.proc) return Promise.reject(new Error('tmux client not running'))
    if (cmd.includes('\n')) return Promise.reject(new Error('command may not contain a newline'))
    return new Promise<string[]>((resolve, reject) => {
      this.pending.push({ resolve, reject, command: cmd })
      this.proc!.stdin.write(`${cmd}\n`)
    })
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  async refreshState(): Promise<void> {
    const [winLines, paneLines] = await Promise.all([
      this.command(`list-windows -a -F "${LIST_WINDOWS_FORMAT}"`),
      this.command(`list-panes -a -F "${LIST_PANES_FORMAT}"`)
    ])

    this.windows.clear()
    this.panes.clear()

    for (const line of winLines) {
      const f = line.split(FS)
      if (f.length < 10) continue
      const id = f[1]!
      this.windows.set(id, {
        id,
        sessionId: f[0]!,
        index: Number(f[2]),
        name: f[3]!,
        active: f[4] === '1',
        layout: f[8]!,
        panes: []
      })
      // Render from the visible layout: when a pane is zoomed it differs from window_layout,
      // which is kept intact so the pre-zoom tree can be restored.
      const visible = f[9]!
      try {
        this.layouts.set(id, parseLayout(visible))
      } catch (err) {
        this.emit('anomaly', 'layout-parse', (err as LayoutParseError).message)
      }
    }

    for (const line of paneLines) {
      const f = line.split(FS)
      if (f.length < 12) continue
      const id = f[1]!
      const windowId = f[0]!
      this.panes.set(id, {
        id,
        windowId,
        active: f[2] === '1',
        width: Number(f[3]),
        height: Number(f[4]),
        left: Number(f[5]),
        top: Number(f[6]),
        currentPath: f[7]!,
        currentCommand: f[8]!,
        title: f[9]!,
        inMode: f[10] === '1',
        dead: f[11] === '1'
      })
      this.windows.get(windowId)?.panes.push(id)
    }

    this.emitState()
  }

  private emitState(): void {
    this.emit('state', [...this.windows.values()], [...this.panes.values()])
  }

  getLayout(windowId: string): TmuxLayoutNode | null {
    return this.layouts.get(windowId) ?? null
  }

  // -------------------------------------------------------------------------
  // Writing into panes
  // -------------------------------------------------------------------------

  /**
   * Write bytes to a pane.
   *
   * send-keys -H is byte-exact but costs ~0.019 ms/byte because tmux routes every hex argument
   * through the full key-input path — about 50 KB/s, and chunking does not help. load-buffer +
   * paste-buffer measures 3.83 MB/s, so anything beyond keystroke scale goes that way.
   */
  async write(paneId: string, data: Uint8Array): Promise<void> {
    if (data.length === 0) return
    if (data.length <= SEND_KEYS_MAX_BYTES) {
      await this.sendKeys(paneId, data)
    } else {
      await this.pasteBytes(paneId, data)
    }
  }

  private async sendKeys(paneId: string, data: Uint8Array): Promise<void> {
    for (let i = 0; i < data.length; i += SEND_KEYS_CHUNK) {
      const chunk = data.subarray(i, i + SEND_KEYS_CHUNK)
      const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, '0')).join(' ')
      await this.command(`send-keys -t ${paneId} -H ${hex}`)
    }
  }

  private async pasteBytes(paneId: string, data: Uint8Array): Promise<void> {
    const bufferName = `onestop-paste-${process.pid}`
    const file = join(tmpdir(), `onestop-paste-${process.pid}-${Date.now()}.bin`)
    await writeFile(file, data)
    try {
      await this.command(`load-buffer -b ${bufferName} ${quote(file)}`)
      // -p requests bracketed paste; tmux emits the markers only if the application enabled
      // them, so it is always safe either way.
      // -r keeps LF raw. paste-buffer would otherwise translate LF to CR, which would make a
      // write behave differently either side of the SEND_KEYS_MAX_BYTES threshold. write() is a
      // transport, not a translator: xterm.js already emits CR for Enter, so the bytes handed to
      // us are terminal-correct and must be delivered unchanged.
      await this.command(`paste-buffer -d -p -r -b ${bufferName} -t ${paneId}`)
    } finally {
      await unlink(file).catch(() => { /* best effort */ })
    }
  }

  // -------------------------------------------------------------------------
  // Sizing
  // -------------------------------------------------------------------------

  /**
   * Tell tmux this window's cell geometry. Debounced: each call is a full
   * recalculate_sizes_now(), and a splitter drag would otherwise issue hundreds.
   */
  resizeWindow(windowId: string, cols: number, rows: number): void {
    const existing = this.resizeTimers.get(windowId)
    if (existing) clearTimeout(existing)
    this.resizeTimers.set(
      windowId,
      setTimeout(() => {
        this.resizeTimers.delete(windowId)
        void this.command(`refresh-client -C ${windowId}:${cols}x${rows}`).catch(() => { /* raced with close */ })
      }, 50)
    )
  }

  // -------------------------------------------------------------------------
  // Window / pane operations
  // -------------------------------------------------------------------------

  async newWindow(cwd: string): Promise<string> {
    const out = await this.command(`new-window -P -F "#{window_id}" -c ${quote(cwd)}`)
    await this.refreshState()
    return out[0]?.trim() ?? ''
  }

  async splitPane(paneId: string, direction: 'horizontal' | 'vertical'): Promise<string> {
    // tmux's -h splits left/right, -v splits top/bottom.
    const flag = direction === 'horizontal' ? '-h' : '-v'
    const out = await this.command(`split-window ${flag} -P -F "#{pane_id}" -t ${paneId}`)
    await this.refreshState()
    return out[0]?.trim() ?? ''
  }

  async killPane(paneId: string): Promise<void> {
    await this.command(`kill-pane -t ${paneId}`)
  }

  async selectPane(paneId: string): Promise<void> {
    await this.command(`select-pane -t ${paneId}`)
  }

  /** Colour-preserving scrollback snapshot, used to repaint after a paused pane resumes. */
  async capturePane(paneId: string, historyLines = 2000): Promise<string> {
    const out = await this.command(`capture-pane -p -e -J -S -${historyLines} -t ${paneId}`)
    return out.join('\n')
  }

  // -------------------------------------------------------------------------
  // Parser sink
  // -------------------------------------------------------------------------

  private sink(): TmuxParserSink {
    return {
      onOutput: (paneId, bytes, ageMs) => {
        if (ageMs !== null && ageMs > 1000 && !this.desynced.has(paneId)) {
          // The renderer is more than a second behind on this pane. Let tmux absorb the firehose
          // rather than growing an unbounded queue in Node.
          this.desynced.add(paneId)
          void this.command(`refresh-client -A "${paneId}:pause"`).catch(() => {})
        }
        // The view is borrowed from the parser's scratch buffer and dies on the next line.
        this.emit('output', paneId, Uint8Array.prototype.slice.call(bytes))
      },

      onNotification: (name, args) => this.onNotification(name, args),

      onBlockBegin: (_t, _n, flags) => {
        // flags === 1 means this block answers a command we sent. Config parsing and hooks share
        // the same server-global counter and must not consume a pending entry.
        this.blockIsOurs = flags === 1 && this.pending.length > 0
        this.blockLines = []
      },

      onBlockLine: (line) => {
        if (this.blockIsOurs) this.blockLines.push(line)
      },

      onBlockEnd: (ok) => {
        if (!this.blockIsOurs) return
        this.blockIsOurs = false
        const p = this.pending.shift()
        if (!p) return
        const lines = this.blockLines
        this.blockLines = []
        if (ok) p.resolve(lines)
        else p.reject(new Error(`${p.command}: ${lines.join('; ') || 'tmux error'}`))
      },

      onAnomaly: (reason, sample) => this.emit('anomaly', reason, sample)
    }
  }

  private onNotification(name: string, args: string): void {
    switch (name) {
      case 'output':
      case 'extended-output':
        return // handled on the fast path

      case 'layout-change': {
        // The ONLY signal that the pane set changed: tmux has no %pane-add or %pane-close.
        const [windowId, , visibleLayout] = args.split(' ')
        if (!windowId || !visibleLayout) return
        try {
          const next = parseLayout(visibleLayout)
          const { removed } = diffPanes(this.layouts.get(windowId) ?? null, next)
          this.layouts.set(windowId, next)
          for (const paneId of removed) {
            this.panes.delete(paneId)
            this.emit('paneExit', paneId)
          }
        } catch (err) {
          this.emit('anomaly', 'layout-parse', String(err))
        }
        void this.refreshState().catch(() => {})
        return
      }

      case 'window-add':
      case 'window-close':
      // control_notify_window_unlinked looks the winlink up after removal, so windows in our own
      // session arrive as unlinked-window-close too. Treat both identically.
      case 'unlinked-window-close':
      case 'window-renamed':
      case 'window-pane-changed':
      case 'session-window-changed':
        void this.refreshState().catch(() => {})
        return

      case 'pause': {
        const paneId = args.trim()
        this.desynced.add(paneId)
        // Data produced while paused is discarded by tmux, so resuming leaves a hole; the caller
        // repaints from capture-pane once %continue arrives.
        void this.command(`refresh-client -A "${paneId}:continue"`).catch(() => {})
        return
      }

      case 'continue': {
        const paneId = args.trim()
        this.desynced.delete(paneId)
        void this.capturePane(paneId)
          .then((text) => this.emit('output', paneId, new TextEncoder().encode(`\x1bc${text}`)))
          .catch(() => {})
        return
      }

      case 'exit':
        this.fail(args.trim() || 'detached', 0)
        return

      case 'config-error':
        this.emit('anomaly', 'config-error', args)
        return

      default:
        return
    }
  }
}

/** Single-quote for tmux's command lexer. Newlines are rejected upstream in command(). */
function quote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}
