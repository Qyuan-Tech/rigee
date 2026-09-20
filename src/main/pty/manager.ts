import { MessageChannelMain, type MessagePortMain, type WebContents } from 'electron'
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
  cols: number
  rows: number
  /** Extra environment for this terminal, e.g. a workspace-specific variable. */
  env?: Record<string, string>
}

interface Pane {
  id: string
  pty: IPty
  workspaceId: string
  /** Bytes waiting for the next flush. */
  pending: string[]
  pendingBytes: number
}

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

    const child = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: Math.max(2, opts.cols),
      rows: Math.max(1, opts.rows),
      cwd: opts.cwd || homedir(),
      env: {
        ...process.env,
        ...opts.env,
        TERM: 'xterm-256color',
        // Tells anything that cares which terminal it is running under, the way iTerm and
        // VS Code both do.
        TERM_PROGRAM: 'onestop',
        COLORTERM: 'truecolor'
      } as Record<string, string>
    })

    const paneId = `pane${++this.seq}`
    const pane: Pane = { id: paneId, pty: child, workspaceId: opts.workspaceId, pending: [], pendingBytes: 0 }
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
