import { MessageChannelMain, app, type MessagePortMain, type WebContents } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { TmuxClient } from './client'
import type { TmuxConnectionState, TmuxPane, TmuxWindow, WorkspaceId } from '@shared/types'

/**
 * Owns one TmuxClient per workspace and the MessagePort that carries pane bytes to the renderer.
 *
 * Terminal output does not go through ipcMain/ipcRenderer. At a measured 4.5 MB/s ceiling and
 * ~20k output lines per firehose, every frame would be a structured-clone hop through the single
 * ipcRenderer channel queue, competing with every other IPC message in the app. A MessagePort is
 * a direct pipe between the two processes.
 *
 * Output is coalesced per flush tick rather than posted per line: at 20k lines/s the postMessage
 * overhead dominates, while xterm.js is happy to receive one large write.
 */

/** Flush cadence. Long enough to coalesce a firehose, short enough to be invisible when typing. */
const FLUSH_MS = 6

/** Per-pane cap between flushes. Beyond this we flush early rather than grow. */
const FLUSH_BYTES = 64 * 1024

interface Entry {
  client: TmuxClient
  port: MessagePortMain | null
  /** paneId -> queued chunks awaiting the next flush. */
  queue: Map<string, Uint8Array[]>
  queuedBytes: number
  timer: NodeJS.Timeout | null
  state: TmuxConnectionState
  lastState?: { windows: TmuxWindow[]; panes: TmuxPane[] }
}

export class TmuxManager {
  private readonly entries = new Map<WorkspaceId, Entry>()

  constructor(private readonly shell: () => WebContents | null) {}

  /** Private socket directory: we must never be able to reach the user's default tmux server. */
  private socketPath(workspaceId: WorkspaceId): string {
    const dir = join(app.getPath('userData'), 'tmux')
    mkdirSync(dir, { recursive: true })
    return join(dir, `${workspaceId}.sock`)
  }

  connectionState(workspaceId: WorkspaceId): TmuxConnectionState {
    return this.entries.get(workspaceId)?.state ?? { status: 'disconnected' }
  }

  async connect(
    workspaceId: WorkspaceId,
    sessionName: string,
    cwd: string,
    cols: number,
    rows: number
  ): Promise<TmuxConnectionState> {
    const existing = this.entries.get(workspaceId)
    if (existing && existing.state.status === 'connected') return existing.state

    const client = new TmuxClient({
      sessionName,
      cwd,
      socketPath: this.socketPath(workspaceId),
      cols,
      rows,
      useWsl: process.platform === 'win32'
    })

    const entry: Entry = {
      client,
      port: null,
      queue: new Map(),
      queuedBytes: 0,
      timer: null,
      state: { status: 'connecting' }
    }
    this.entries.set(workspaceId, entry)

    client.on('output', (paneId, data) => this.enqueue(entry, paneId, data))
    client.on('state', (windows, panes) => this.pushState(workspaceId, entry, windows, panes))
    client.on('paneExit', (paneId) => {
      this.send('tmux:paneExit', { workspaceId, paneId })
    })
    client.on('exit', (reason) => {
      entry.state = { status: 'failed', error: reason }
      this.pushState(workspaceId, entry, [], [])
    })
    client.on('anomaly', (reason, sample) => {
      // Anomalies are protocol-level surprises. They are never expected; surface them rather than
      // letting the terminal quietly diverge from what tmux thinks it is showing.
      console.warn(`[tmux:${workspaceId}] anomaly ${reason}: ${sample.slice(0, 200)}`)
    })

    try {
      await client.start()
      entry.state = { status: 'connected', sessionId: sessionName }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      entry.state = /ENOENT/.test(message)
        ? { status: 'unavailable', reason: process.platform === 'win32' ? 'WSL or tmux not found' : 'tmux not found on PATH' }
        : { status: 'failed', error: message }
    }
    return entry.state
  }

  disconnect(workspaceId: WorkspaceId): void {
    const entry = this.entries.get(workspaceId)
    if (!entry) return
    this.entries.delete(workspaceId)
    if (entry.timer) clearTimeout(entry.timer)
    entry.port?.close()
    entry.client.dispose()
  }

  disposeAll(): void {
    for (const id of [...this.entries.keys()]) this.disconnect(id)
  }

  client(workspaceId: WorkspaceId): TmuxClient | null {
    return this.entries.get(workspaceId)?.client ?? null
  }

  listState(workspaceId: WorkspaceId): { windows: TmuxWindow[]; panes: TmuxPane[] } {
    const entry = this.entries.get(workspaceId)
    if (!entry) return { windows: [], panes: [] }
    return entry.lastState ?? { windows: [], panes: [] }
  }

  // -------------------------------------------------------------------------
  // Byte transport
  // -------------------------------------------------------------------------

  /** Hand the renderer one end of a dedicated channel for this workspace's terminal bytes. */
  establishPort(workspaceId: WorkspaceId): void {
    const entry = this.entries.get(workspaceId)
    const wc = this.shell()
    if (!entry || !wc) return

    entry.port?.close()
    const { port1, port2 } = new MessageChannelMain()
    entry.port = port1

    port1.on('message', (event) => {
      // Renderer -> pane keystrokes take the same channel back, so typing never queues behind
      // whatever else ipcRenderer is doing.
      const msg = event.data as { paneId: string; data: string }
      if (!msg || typeof msg.paneId !== 'string') return
      void entry.client.write(msg.paneId, new TextEncoder().encode(msg.data)).catch(() => {})
    })
    port1.start()

    wc.postMessage('terminal:port', { workspaceId }, [port2])
  }

  private enqueue(entry: Entry, paneId: string, data: Uint8Array): void {
    let chunks = entry.queue.get(paneId)
    if (!chunks) { chunks = []; entry.queue.set(paneId, chunks) }
    chunks.push(data)
    entry.queuedBytes += data.length

    if (entry.queuedBytes >= FLUSH_BYTES) {
      this.flush(entry)
      return
    }
    entry.timer ??= setTimeout(() => this.flush(entry), FLUSH_MS)
  }

  private flush(entry: Entry): void {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    entry.queuedBytes = 0
    const port = entry.port
    if (!port) { entry.queue.clear(); return }

    for (const [paneId, chunks] of entry.queue) {
      if (chunks.length === 0) continue
      const total = chunks.reduce((n, c) => n + c.length, 0)
      const merged = new Uint8Array(total)
      let off = 0
      for (const c of chunks) { merged.set(c, off); off += c.length }
      chunks.length = 0
      port.postMessage({ paneId, data: merged })
    }
    entry.queue.clear()
  }

  private pushState(
    workspaceId: WorkspaceId,
    entry: Entry,
    windows: TmuxWindow[],
    panes: TmuxPane[]
  ): void {
    entry.lastState = { windows, panes }
    this.send('tmux:state', { workspaceId, connection: entry.state, windows, panes })
  }

  private send(channel: 'tmux:state' | 'tmux:paneExit', payload: unknown): void {
    const wc = this.shell()
    if (wc && !wc.isDestroyed()) wc.send(channel, payload)
  }
}
