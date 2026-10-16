import { Context, type Fiber, type FiberState, type Plugin } from 'cordis'
import type { BrowserWindow, WebContents } from 'electron'
import type { PluginEventEnvelope, PluginId } from '@rigee/plugin-api/manifest'
import { CommandService } from './commands'
import { ShellService, type AskOptions } from './shell'

/**
 * The main-process plugin host.
 *
 * One cordis root Context owns every main-side plugin half. Each half gets its own child Context
 * carrying its `pluginId`, and `ctx.plugin()` gives that child a fiber: disposing the fiber
 * revokes every command the plugin registered, every event listener it attached, and anything
 * else it did through `ctx.effect`. That property is the whole reason for the framework — an
 * unload path that cannot be got wrong by forgetting a line.
 *
 * Activation is lazy and demand-driven. A half is imported when the renderer first calls one of
 * that plugin's commands, so a plugin nobody uses costs one entry in a Map. The host ITSELF is
 * lazy too: src/main/index.ts imports this module on the first `plugin:invoke`, which keeps
 * cordis's measured 10.4 ms import and 3.5 ms `new Context()` off the boot path.
 *
 * Four things here look redundant and are not. Each was verified against cordis 4.0.0-rc.10:
 *   - the `pluginId` accessor: without it, reading an absent `ctx.pluginId` THROWS rather than
 *     returning undefined, because Context is a Proxy that rejects unknown property reads;
 *   - `await this.ready`: `root.commands` is undefined for a microtask after `root.plugin()`,
 *     so dispatching on the same turn is a TypeError, not a clean error;
 *   - the ACTIVE assertion: a plugin whose `inject` cannot be satisfied sits in PENDING and its
 *     awaited fiber resolves SUCCESSFULLY, turning a missing service into a much later and much
 *     less obvious "unknown plugin command";
 *   - the logger exporter: cordis's default exporter writes to an in-memory ring buffer and
 *     prints nothing, so an exception inside a plugin's apply is otherwise completely silent.
 */

/** cordis's FiberState is an ambient const enum, which verbatimModuleSyntax forbids importing. */
const ACTIVE = 2 satisfies FiberState

export type MainPluginLoader = () => Promise<{ default: Plugin }>

export interface PluginHostDeps {
  window: () => BrowserWindow | null
  webContents: () => WebContents | null
  send: (payload: PluginEventEnvelope) => void
  ask: (options: AskOptions) => Promise<number>
}

/** Plugins that will take keyboard focus if the shell offers it. See ShellService.claimFocus. */
type FocusClaim = () => boolean

export class PluginHost {
  private readonly root = new Context()
  /** Resolves once the host's own services are provided. */
  private readonly ready: Promise<unknown>
  /** In-flight or settled activations, so two concurrent calls import the half once. */
  private readonly activations = new Map<PluginId, Promise<void>>()
  /** One fiber per activated plugin, so a single plugin can be unloaded without a root restart. */
  private readonly fibers = new Map<PluginId, Fiber>()
  private readonly focusClaims = new Set<FocusClaim>()
  private disposed = false
  private toreDown = false

  /**
   * True once `dispose()` has fully finished — not merely started.
   *
   * The distinction is the whole of the quit-time crash: source control's watchers are native, and
   * releasing one completes through a napi callback that aborts the process if it lands after Node
   * has begun tearing the environment down. `disposed` flips at the top of `dispose()` and so
   * cannot tell "teardown is running" from "teardown is done"; this flips at the bottom.
   * `smoke:shutdown` asserts it from `will-quit`, which is the point at which it must already be
   * true.
   */
  get torndown(): boolean {
    return this.toreDown
  }

  /**
   * Plugins the user has switched off.
   *
   * Enforced here as well as in the renderer, and not out of distrust: a disabled plugin's main
   * half is where the filesystem watchers and the native views live, so "disabled" has to mean
   * stopped in this process, and a command arriving from a pane that has not re-rendered yet must
   * not quietly start it again.
   */
  private disabled: ReadonlySet<PluginId>

  /**
   * @param loaders asked on every activation rather than once, because the set changes while the
   *   app runs: a plugin installed from GitHub has to be startable without a relaunch, and one
   *   uninstalled must stop being startable.
   */
  constructor(
    private readonly loaders: () => Readonly<Record<PluginId, MainPluginLoader>>,
    deps: PluginHostDeps,
    disabled: Iterable<PluginId> = []
  ) {
    this.disabled = new Set(disabled)
    this.root.accessor('pluginId', { get: () => undefined })
    this.root.logger.exporter({
      export: (message) => {
        if (message.type !== 'error') return
        console.error(`[plugin:${message.name}]`, ...message.args)
      }
    })
    this.ready = Promise.all([
      this.root.plugin(CommandService),
      this.root.plugin(ShellService, { ...deps, focusClaims: this.focusClaims })
    ])
  }

  /**
   * Offer keyboard focus to the plugins that asked for it. True if one took it.
   *
   * Called by the shell on window focus and after load. The first claim wins: only one surface
   * can hold focus, and a plugin only claims when it actually has something visible.
   */
  focusClaimed(): boolean {
    for (const claim of this.focusClaims) {
      if (claim()) return true
    }
    return false
  }

  /**
   * Route one `plugin:invoke`.
   *
   * The command's own prefix names the plugin that must own it, which is what lets activation be
   * lazy: we can tell which half to import without having imported any of them.
   */
  async invoke(command: string, payload: unknown): Promise<unknown> {
    if (this.disposed) throw new Error(`plugin host is shutting down, refusing ${command}`)
    const colon = command.indexOf(':')
    if (colon <= 0) throw new Error(`malformed plugin command: ${command}`)
    await this.ready
    await this.activate(command.slice(0, colon))
    // Checked again on the far side of the awaits: quitting between them would otherwise let a
    // `browser:create` build a fresh native view during shutdown, which is exactly the "live view
    // at quit time" that `pnpm smoke:quit` exists to prevent.
    if (this.disposed) throw new Error(`plugin host is shutting down, refusing ${command}`)
    return await this.registry().dispatch(command, payload)
  }

  /**
   * Load and start one plugin's main half.
   *
   * Public because two callers need it without a command in hand: the smoke tests, and any plugin
   * that must be running before the renderer asks it anything.
   */
  activate(id: PluginId): Promise<void> {
    if (this.disabled.has(id)) {
      return Promise.reject(new Error(`plugin "${id}" is disabled`))
    }
    const existing = this.activations.get(id)
    if (existing) return existing

    const load = this.loaders()[id]
    // Not an error worth distinguishing from an unknown command: either way the dispatch that
    // follows rejects with a message naming the command, which is the useful half of the story.
    if (!load) return Promise.resolve()

    const pending = (async () => {
      await this.ready
      const mod = await load()
      const ctx = this.root.extend({ pluginId: id })
      const fiber = await ctx.plugin(mod.default)
      if (fiber.state !== ACTIVE) {
        throw new Error(
          `plugin "${id}" loaded but did not activate (fiber state ${fiber.state}); ` +
            'a missing `inject` leaves it pending forever'
        )
      }
      // The app may have started quitting across those three awaits. `dispose()` snapshots the
      // fiber map, and this fiber was not in it yet — so recording it here would leave a plugin
      // that nothing will ever tear down, having just installed the very things teardown exists to
      // remove: an app-level 'login' listener, a filesystem watcher, a `git cat-file --batch`
      // child. Undo it instead.
      if (this.disposed) {
        await fiber.dispose()
        throw new Error(`plugin host shut down while "${id}" was loading`)
      }
      this.fibers.set(id, fiber)
    })().catch((err: unknown) => {
      // Let the next call retry rather than caching a failure forever: a plugin that failed to
      // load because a file was missing should recover once it is there.
      this.activations.delete(id)
      throw err
    })

    this.activations.set(id, pending)
    return pending
  }

  /**
   * Apply a new disabled set: stop anything that just went off.
   *
   * Enabling is lazy, as it is everywhere else — the plugin comes back the next time something
   * calls one of its commands, which is the same path a fresh launch takes.
   */
  async setDisabled(ids: Iterable<PluginId>): Promise<void> {
    this.disabled = new Set(ids)
    await Promise.all([...this.disabled].map((id) => this.deactivate(id)))
  }

  /** Which plugins have a live main half. For diagnostics and the plugin smoke test. */
  active(): PluginId[] {
    return [...this.fibers.keys()].sort()
  }

  /**
   * The command service as the shell's own class. Plugins see `ctx.commands` as the public
   * interface, which registers and does nothing else; dispatching is the host's alone.
   */
  private registry(): CommandService {
    return this.root.commands as CommandService
  }

  /** Every command any active plugin has registered. */
  commands(): string[] {
    return this.root.commands ? this.registry().names() : []
  }

  /**
   * Unload one plugin. Its commands and every effect it took are revoked with its fiber.
   *
   * Disposing the fiber we kept, rather than `ctx.registry.delete(plugin)`, because the latter
   * disposes every instance of that plugin function and we only ever want this one.
   */
  async deactivate(id: PluginId): Promise<void> {
    const fiber = this.fibers.get(id)
    this.fibers.delete(id)
    this.activations.delete(id)
    await fiber?.dispose()
  }

  /**
   * Shut every plugin down.
   *
   * Deliberately NOT `root.fiber.dispose()`: on the root fiber cordis maps dispose to *restart*,
   * which tears down the child plugins and the host's own services and then brings the root back
   * up — leaving `root.commands` undefined and the host looking alive. Disposing each plugin
   * fiber says what it means.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    // Settle first, then tear down. An activation racing the quit disposes its own fiber once it
    // sees `disposed` (see `activate`), and awaiting them here means this method does not return
    // while a plugin is still mid-start — which matters to `pnpm smoke:quit`, whose whole claim is
    // that nothing is left running.
    const inFlight = [...this.activations.values()]
    await Promise.all(inFlight.map((p) => p.catch(() => { /* reported at its own call site */ })))

    const fibers = [...this.fibers.values()]
    this.fibers.clear()
    this.activations.clear()
    await Promise.all(fibers.map((f) => f.dispose().catch(() => { /* already gone */ })))
    this.toreDown = true
  }
}
