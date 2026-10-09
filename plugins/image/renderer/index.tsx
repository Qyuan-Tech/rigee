import { ImageView } from './ImageView'
import { connect } from './rpc'
import type { Context, Plugin } from 'cordis'

/**
 * The image viewer's renderer half: park the RPC client, bind the editor. Nothing outlives a tab —
 * each pane owns its blob: URL and lets it go when it unmounts — so there is nothing else to undo.
 *
 * `inject` is mandatory and `apply` must have a braced body: reading `ctx.contributions` without
 * declaring it throws, and cordis reads a plugin's RETURN VALUE as an effect, so an arrow body that
 * returns `ctx.contributions.editor(...)` throws `TypeError: Invalid effect`.
 */
const plugin: Plugin = {
  name: 'image',
  inject: ['contributions', 'rpc'],
  apply(ctx: Context) {
    const rpc = ctx.rpc
    const invoke = rpc.invoke.bind(rpc)

    ctx.effect(() => connect(invoke), 'image rpc')
    ctx.contributions.editor('image.preview', ImageView)
  }
}

export default plugin
