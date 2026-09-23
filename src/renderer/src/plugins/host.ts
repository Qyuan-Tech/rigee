import { Context, type Fiber, type FiberState, type Plugin } from 'cordis'
import { RENDERER_HALVES } from '@plugins/registry.renderer'
import { diskRendererUrl } from './registry'
import type { PluginId } from '@rigee/plugin-api/manifest'
import { ContributionService } from './contributions'
import { PluginRpcService } from './rpc'

/**
 * The renderer-side plugin host.
 *
 * Mirrors the main-process host: one cordis root, one child Context per plugin carrying its
 * `pluginId`, one fiber per activation so disposing a plugin revokes every component it bound and
 * every event it subscribed to.
 *
 * NOTHING IN THE SHELL MAY IMPORT THIS MODULE STATICALLY. It pulls in cordis (28 kB minified) and
 * every service; the shell reaches it through `activate.ts`, which is a memoised dynamic import in
 * the same shape as `lazy.ts`'s Monaco loader. That is what keeps the entry chunk at its current
 * size whether the app ships four plugins or forty.
 */

/** cordis's FiberState is an ambient const enum, which verbatimModuleSyntax forbids importing. */
const ACTIVE = 2 satisfies FiberState

let rootP: Promise<Context> | null = null
const activations = new Map<PluginId, Promise<void>>()
/** One fiber per running plugin, so a single plugin can be stopped without touching the others. */
const fibers = new Map<PluginId, Fiber>()

function root(): Promise<Context> {
  rootP ??= (async () => {
    const ctx = new Context()
    // Without this, reading an absent `ctx.pluginId` throws instead of yielding undefined:
    // Context is a Proxy that rejects unknown property reads. Every `no pluginId` guard in the
    // services depends on it.
    ctx.accessor('pluginId', { get: () => undefined })
    // cordis's default exporter fills an in-memory ring buffer and prints nothing, so a plugin
    // whose apply() throws would fail completely silently — no console, no DevTools, no clue.
    ctx.logger.exporter({
      export: (message) => {
        if (message.type !== 'error') return
        console.error(`[plugin:${message.name}]`, ...message.args)
      }
    })
    await Promise.all([ctx.plugin(ContributionService), ctx.plugin(PluginRpcService)])
    return ctx
  })()
  return rootP
}

/**
 * How a plugin that did not ship with the app is fetched.
 *
 * `rigee-plugin://<id>/…`, served by main, which hands over a file only for a plugin the user has
 * approved as it currently stands. The URL is undefined for anything untrusted, so this returns
 * nothing and the caller reports "no renderer half" — the same answer as for a plugin that has
 * none, which is the right one: from the renderer's point of view there is nothing to load.
 *
 * `@vite-ignore` because the specifier is a runtime value. Without it Rollup tries to resolve the
 * variable at build time, warns, and leaves behind an import that cannot work.
 *
 * The plugin's own `import 'react'` and `import '@rigee/plugin-api'` resolve through the import
 * map in index.html, to the shell's copies. That is not an optimisation: a second React means
 * hooks throw, and a second copy of the API package means a host nobody installed.
 */
function diskHalf(id: PluginId): (() => Promise<{ default: Plugin }>) | undefined {
  const url = diskRendererUrl(id)
  if (!url) return undefined
  return async () => (await import(/* @vite-ignore */ url)) as { default: Plugin }
}

/**
 * Load and start one plugin's renderer half. Idempotent, and safe to call concurrently.
 *
 * The in-flight Map is not optional: React StrictMode double-invokes every effect in development,
 * so two mounts race to activate the same plugin and would otherwise load it twice — which cordis
 * permits (it has no `reusable` concept and never dedupes) and which would throw on the second
 * plugin's attempt to bind an already-bound view type.
 */
export function activate(id: PluginId): Promise<void> {
  const existing = activations.get(id)
  if (existing) return existing

  const load = RENDERER_HALVES[id] ?? diskHalf(id)
  if (!load) return Promise.reject(new Error(`no renderer half for plugin "${id}"`))

  const pending = (async () => {
    const ctx = await root()
    const mod = await load()
    const fiber = await ctx.extend({ pluginId: id }).plugin(mod.default)
    if (fiber.state !== ACTIVE) {
      throw new Error(
        `plugin "${id}" loaded but did not activate (fiber state ${fiber.state}); ` +
          'a missing `inject` leaves it pending forever'
      )
    }
    fibers.set(id, fiber)
  })().catch((err: unknown) => {
    // Retry on the next mount rather than caching the failure for the life of the window.
    activations.delete(id)
    throw err
  })

  activations.set(id, pending)
  return pending
}

/** Which plugins have a live renderer half. For diagnostics and the plugin smoke test. */
export function activated(): PluginId[] {
  return [...activations.keys()].sort()
}

/**
 * Stop one plugin's renderer half.
 *
 * Disposing the fiber is the whole of it: every component it bound, every event it subscribed to
 * and every effect it took were registered through the context, so they are revoked together and
 * the shell re-renders without them — a panel disappears, a tab falls back to "no plugin provides
 * this". That property is why the plugin runtime is cordis and not a Map, and switching a plugin
 * off in the plugins view is the first thing that actually exercises it.
 *
 * Idempotent: stopping a plugin that never started is not an error, because the plugins view lets
 * you switch off something that was never needed in this session.
 */
export async function deactivate(id: PluginId): Promise<void> {
  const fiber = fibers.get(id)
  fibers.delete(id)
  // Dropped BEFORE the await, so a re-enable racing this teardown starts a fresh activation
  // rather than resolving against the one being torn down.
  activations.delete(id)
  await fiber?.dispose()
}
