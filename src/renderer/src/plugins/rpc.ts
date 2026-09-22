import { Service, type Context } from 'cordis'
import { commandNamespace, type PluginId } from '@shared/plugin'
import { onEvent, rpc } from '../ipc'

declare module 'cordis' {
  interface Context {
    rpc: PluginRpcService
    pluginId?: PluginId
  }
}

type Listener = (payload: unknown) => void

/**
 * One listener for every plugin event, demultiplexed by plugin id.
 *
 * Installed once, when the first plugin activates, and never removed: the alternative is one
 * `ipcRenderer.on` per plugin, which is more bridge traffic for no gain since main sends every
 * envelope down the same channel anyway.
 */
const listeners = new Map<PluginId, Set<Listener>>()
let wired = false

function wire(): void {
  if (wired) return
  wired = true
  onEvent('plugin:event', ({ pluginId, event, payload }) => {
    const set = listeners.get(`${pluginId}:${event}`)
    if (!set) return
    for (const listener of set) listener(payload)
  })
}

/**
 * How a renderer half reaches its own main half.
 *
 * Deliberately narrow: a plugin can call its own commands and subscribe to its own events, and
 * nothing else. The prefix check is not a security boundary — the renderer is our own trusted
 * shell, and anything running here could call `window.onestop.invoke` directly — it is a
 * correctness one. It turns "I typo'd another plugin's command name" from a confusing remote
 * error into a local throw naming both plugins.
 *
 * Both methods are prototype methods, not fields, and that is load-bearing: cordis makes
 * `this.ctx` mean the CALLING plugin's context by swapping `thisArg` when the method is called
 * through the service proxy, and an arrow field would ignore the swap and see the root's (absent)
 * pluginId.
 *
 * On a hot path — `browser:setBounds` fires from a ResizeObserver and through every splitter drag
 * — BIND at activation: `const rpc = ctx.rpc; const invoke = rpc.invoke.bind(rpc)`. Measured per
 * call: 17,700 ns through `ctx.rpc.invoke(…)`, 4,460 ns through a held service, 219 ns bound. A
 * bare `const invoke = ctx.rpc.invoke` does not merely lose the speed, it THROWS — the shadow is
 * only substituted when the receiver is the proxy itself.
 */
export class PluginRpcService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'rpc')
  }

  async invoke<T = unknown>(command: string, payload?: unknown): Promise<T> {
    const id = this.ctx.pluginId
    if (!id) throw new Error(`rpc.invoke(${command}): called from a Context with no pluginId`)

    const prefix = commandNamespace(id)
    if (!command.startsWith(prefix)) {
      throw new Error(`plugin "${id}" may only invoke commands prefixed "${prefix}", got "${command}"`)
    }
    return (await rpc['plugin:invoke']({ command, payload })) as T
  }

  /**
   * Listen for one of this plugin's own main→renderer events.
   *
   * Registered through `ctx.effect`, so it is revoked when the plugin is disposed — a listener
   * that outlives its plugin is the classic way a reload starts producing two of everything.
   */
  on<T = unknown>(event: string, listener: (payload: T) => void): void {
    const id = this.ctx.pluginId
    if (!id) throw new Error(`rpc.on(${event}): called from a Context with no pluginId`)
    wire()

    const key = `${id}:${event}`
    this.ctx.effect(() => {
      let set = listeners.get(key)
      if (!set) { set = new Set(); listeners.set(key, set) }
      set.add(listener as Listener)
      return () => {
        const live = listeners.get(key)
        live?.delete(listener as Listener)
        if (live && live.size === 0) listeners.delete(key)
      }
    }, `event ${key}`)
  }
}
