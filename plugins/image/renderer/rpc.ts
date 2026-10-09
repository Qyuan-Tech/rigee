import { imageClient, type ImageCall } from '../protocol'

/**
 * The plugin's own line to main, reachable from a component.
 *
 * Components cannot hold `ctx` — a cordis service access costs microseconds per property read —
 * so the renderer entry captures `ctx.rpc.invoke` once at activation and parks the typed client
 * here, through `ctx.effect`: disposing the plugin unparks it, and a viewer that somehow outlives
 * its plugin gets a clear error rather than a call into a dead fiber.
 */
let live: ImageCall | null = null

export function connect(invoke: (command: string, args: unknown) => Promise<unknown>): () => void {
  live = imageClient(invoke)
  return () => { live = null }
}

export const image: ImageCall = (command, args) => {
  if (!live) return Promise.reject(new Error(`the image viewer is not active, cannot ${command}`))
  return live(command, args)
}
