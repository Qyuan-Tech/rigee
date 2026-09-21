import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { REQUEST_CHANNELS, EVENT_CHANNELS, type OnestopBridge } from '@shared/ipc'
import type { Platform } from '@shared/types'

/**
 * Compiled to CJS (`index.cjs`) on purpose — see electron.vite.config.ts. An ESM preload under
 * sandbox:true fails with "Cannot use import statement outside a module" and window.onestop
 * silently never appears.
 */

const REQUEST_ALLOW: ReadonlySet<string> = new Set<string>(REQUEST_CHANNELS)
const EVENT_ALLOW: ReadonlySet<string> = new Set<string>(EVENT_CHANNELS)

// ---------------------------------------------------------------------------
// Terminal MessagePorts
//
// A MessagePort cannot cross contextBridge, so it stays here in the isolated world. Main
// transfers one port per workspace; we demultiplex by pane id and hand decoded frames to
// renderer-registered sinks through an ordinary (clonable) callback.
// ---------------------------------------------------------------------------

type TerminalSink = (paneId: string, data: string) => void

const ports = new Map<string, MessagePort>()
const sinks = new Map<string, Set<TerminalSink>>()
/** Frames that arrived before the renderer registered a sink for that workspace. */
const pending = new Map<string, Array<[string, string]>>()

ipcRenderer.on('terminal:port', (e: IpcRendererEvent, meta: { workspaceId: string }) => {
  const port = e.ports[0]
  if (!port) return
  const { workspaceId } = meta

  ports.get(workspaceId)?.close()
  ports.set(workspaceId, port)

  port.onmessage = (ev: MessageEvent): void => {
    // Wire format is [paneId, bytes]; main already decoded tmux's octal escaping.
    const frame = ev.data as { paneId: string; data: string }
    const set = sinks.get(workspaceId)
    if (!set || set.size === 0) {
      let q = pending.get(workspaceId)
      if (!q) { q = []; pending.set(workspaceId, q) }
      // Bound the replay queue; a pane dumping output before the UI is ready is not worth 1 GB.
      if (q.length < 4096) q.push([frame.paneId, frame.data])
      return
    }
    for (const sink of set) sink(frame.paneId, frame.data)
  }
  port.start()
})

const api: OnestopBridge = {
  platform: process.platform as Platform,

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!REQUEST_ALLOW.has(channel)) {
      return Promise.reject(new Error(`blocked request channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },

  on(channel: string, cb: (payload: unknown) => void): () => void {
    if (!EVENT_ALLOW.has(channel)) throw new Error(`blocked event channel: ${channel}`)
    const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => { ipcRenderer.removeListener(channel, listener) }
  },

  onTerminalData(workspaceId: string, cb: TerminalSink): () => void {
    let set = sinks.get(workspaceId)
    if (!set) { set = new Set(); sinks.set(workspaceId, set) }
    set.add(cb)

    const queued = pending.get(workspaceId)
    if (queued && queued.length > 0) {
      pending.delete(workspaceId)
      for (const [paneId, data] of queued) cb(paneId, data)
    }

    return () => {
      const s = sinks.get(workspaceId)
      s?.delete(cb)
      if (s && s.size === 0) sinks.delete(workspaceId)
    }
  },

  /**
   * The filesystem path of a dropped File.
   *
   * Electron removed the non-standard `File.path` property, so a drag-and-drop of folders from
   * Finder or Explorer now yields File objects with no way to find them on disk. webUtils is the
   * replacement and it only exists in the isolated world, which is why this has to be here rather
   * than in the renderer.
   */
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  writeTerminal(workspaceId: string, paneId: string, data: string): void {
    // Keystrokes are low-rate but latency-critical: go straight down the port, never through
    // ipcRenderer.invoke.
    ports.get(workspaceId)?.postMessage({ paneId, data })
  }
}

contextBridge.exposeInMainWorld('onestop', api)
