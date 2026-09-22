import type { IpcEvents, IpcRequests, OnestopBridge } from '@shared/ipc'
import type { Platform } from '@shared/types'

declare global {
  interface Window {
    onestop: OnestopBridge
  }
}

type Client = {
  [K in keyof IpcRequests]: (
    ...args: Parameters<IpcRequests[K]>
  ) => Promise<Awaited<ReturnType<IpcRequests[K]>>>
}

/**
 * A Proxy is legal on this side of the bridge — it is never passed through contextBridge, which
 * can only clone plain data and functions.
 *
 *   const info = await rpc['app:getPlatformInfo']()
 *   const off  = onEvent('terminal:exit', ({ paneId }) => ...)
 */
export const rpc = new Proxy({} as Client, {
  get:
    (_target, channel: string) =>
    (...args: unknown[]) =>
      window.onestop.invoke(channel, ...args)
})

export function onEvent<K extends keyof IpcEvents>(
  channel: K,
  cb: (payload: IpcEvents[K]) => void
): () => void {
  return window.onestop.on(channel, cb as (p: unknown) => void)
}

export const platform = (): Platform => window.onestop.platform
export const isMac = (): boolean => window.onestop.platform === 'darwin'
