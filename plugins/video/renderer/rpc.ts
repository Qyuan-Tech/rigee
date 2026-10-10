import { videoClient, type VideoCall } from '../protocol'

/**
 * The plugin's own line to main, reachable from a component.
 *
 * Components cannot hold `ctx` — a cordis service access costs microseconds per property read —
 * so the renderer entry captures `ctx.rpc.invoke` once at activation and parks the typed client
 * here, through `ctx.effect`: disposing the plugin unparks it.
 */
let live: VideoCall | null = null

export function connect(invoke: (command: string, args: unknown) => Promise<unknown>): () => void {
  live = videoClient(invoke)
  return () => { live = null }
}

export const video: VideoCall = (command, args) => {
  if (!live) return Promise.reject(new Error(`the video player is not active, cannot ${command}`))
  return live(command, args)
}
