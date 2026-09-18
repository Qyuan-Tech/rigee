import { ipcMain, type WebContents } from 'electron'
import type { IpcEvents, IpcRequests } from '@shared/ipc'

/**
 * Typed wrappers over ipcMain. The channel name constrains both the argument tuple and the
 * return type, so a mismatch between main and renderer is a compile error rather than an
 * undefined at runtime.
 */

export function handle<K extends keyof IpcRequests>(
  channel: K,
  fn: (
    ...args: Parameters<IpcRequests[K]>
  ) => ReturnType<IpcRequests[K]> | Promise<ReturnType<IpcRequests[K]>>
): void {
  ipcMain.handle(channel as string, async (_event, ...args) => {
    try {
      return await fn(...(args as Parameters<IpcRequests[K]>))
    } catch (err) {
      // Let the renderer see a real message instead of "Error invoking remote method".
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`${channel}: ${message}`)
    }
  })
}

export function emit<K extends keyof IpcEvents>(
  wc: WebContents | null,
  channel: K,
  payload: IpcEvents[K]
): void {
  if (wc && !wc.isDestroyed()) wc.send(channel as string, payload)
}
