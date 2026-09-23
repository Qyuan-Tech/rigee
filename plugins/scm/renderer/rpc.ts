import { scmClient, type ScmCall } from '../protocol'

/**
 * The plugin's own line to main, reachable from a component.
 *
 * Components cannot hold `ctx`: a cordis service access rebuilds a shadow context on every
 * property read — 15 us against 8 ns for a plain call — and a diff tab does one per click. So the
 * renderer entry captures `ctx.rpc.invoke` ONCE at activation and parks the typed client here,
 * and every component imports `scm` directly. This is the same separation as the shell's
 * `bindings.ts`: cordis on the activation path, plain functions on the render path.
 *
 * Parked through `ctx.effect`, so disposing the plugin unparks it and a component that somehow
 * outlives its plugin gets a clear error rather than a call into a dead fiber.
 */
let live: ScmCall | null = null

export function connect(invoke: (command: string, args: unknown) => Promise<unknown>): () => void {
  live = scmClient(invoke)
  return () => { live = null }
}

export const scm: ScmCall = (command, args) => {
  if (!live) return Promise.reject(new Error(`source control is not active, cannot ${command}`))
  return live(command, args)
}
