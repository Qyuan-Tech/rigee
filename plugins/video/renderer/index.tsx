import { connect } from './rpc'
import { VideoView } from './VideoView'
import type { Context, Plugin } from 'cordis'

/**
 * The video player's renderer half: park the RPC client, bind the editor. Each player asks for its
 * own URL and releases it when it closes; anything one forgets, main revokes with the plugin.
 *
 * `inject` is mandatory and `apply` must have a braced body: cordis reads a plugin's RETURN VALUE
 * as an effect, so an arrow body that returns `ctx.contributions.editor(...)` throws.
 */
const plugin: Plugin = {
  name: 'video',
  inject: ['contributions', 'rpc'],
  apply(ctx: Context) {
    const rpc = ctx.rpc
    const invoke = rpc.invoke.bind(rpc)

    ctx.effect(() => connect(invoke), 'video rpc')
    ctx.contributions.editor('video.player', VideoView)
  }
}

export default plugin
