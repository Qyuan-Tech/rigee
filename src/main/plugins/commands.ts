import { Service, type Context } from 'cordis'
import { commandNamespace } from '@rigee/plugin-api/manifest'
import type { PluginCommandsService } from '@rigee/plugin-api/context'

// `ctx.commands` and `ctx.pluginId` are declared on Context by @rigee/plugin-api (context.ts), as
// the interface this class implements — so a plugin from another repository types against the same
// declaration. `pluginId` is what makes the guards below reachable: cordis rebinds `this.ctx`
// inside a service method to the CALLING plugin's context, which the host stamped with its id.

export type CommandHandler = (payload: unknown) => unknown | Promise<unknown>

/**
 * The main-side half of the plugin RPC.
 *
 * A plugin registers named commands here; the renderer reaches them through the single
 * `plugin:invoke` channel. Nothing else in main is exposed to plugins by default — if a plugin
 * wants to touch the filesystem it writes the read itself, in its own main half, where it is
 * ordinary Node code subject to ordinary review. That is a deliberate difference from handing
 * plugins a generic `fs` service: the capability a plugin needs is almost never "the filesystem",
 * it is "this one file, bounded".
 *
 * CONSUMERS MUST DECLARE `inject: ['commands']`. cordis throws `cannot get property "commands"
 * without inject` otherwise, and a plugin whose injection is missing does not fail loudly — its
 * fiber sits in PENDING, apply never runs, and the symptom surfaces later as "unknown plugin
 * command". The host asserts the fiber reached ACTIVE to turn that back into a real error.
 */
export class CommandService extends Service implements PluginCommandsService {
  private handlers = new Map<string, CommandHandler>()

  constructor(ctx: Context) {
    super(ctx, 'commands')
  }

  /**
   * Register one command. Returns nothing: the registration is an effect on the calling plugin's
   * fiber, so it is revoked when that plugin is disposed. Forgetting to clean up is not possible,
   * which is the entire reason the host is cordis and not a Map.
   */
  register(name: string, handler: CommandHandler): void {
    const id = this.ctx.pluginId
    if (!id) throw new Error(`commands.register(${name}): called from a Context with no pluginId`)

    // A plugin may only claim its own namespace. Without this, the first plugin to register
    // `fs:read` would silently intercept every other plugin's call to it.
    const prefix = commandNamespace(id)
    if (!name.startsWith(prefix)) {
      throw new Error(`plugin "${id}" may only register commands prefixed "${prefix}", got "${name}"`)
    }
    if (this.handlers.has(name)) {
      throw new Error(`command "${name}" is already registered`)
    }

    this.ctx.effect(() => {
      this.handlers.set(name, handler)
      return () => { this.handlers.delete(name) }
    }, `command ${name}`)
  }

  /**
   * Dispatch. Throws for an unregistered command rather than returning undefined — this is the
   * authorisation point for everything arriving on `plugin:invoke`, and a silent undefined is
   * indistinguishable from a command that legitimately returns nothing.
   */
  async dispatch(name: string, payload: unknown): Promise<unknown> {
    const handler = this.handlers.get(name)
    if (!handler) throw new Error(`unknown plugin command: ${name}`)
    return await handler(payload)
  }

  /** Every registered command name. For diagnostics and the plugin smoke test. */
  names(): string[] {
    return [...this.handlers.keys()].sort()
  }
}
