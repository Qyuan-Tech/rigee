import { FileExplorer } from './FileExplorer'
import { connect, onChanged } from './listings'
import { explorerSubscriber } from '../protocol'
import type { Context, Plugin } from 'cordis'

/**
 * The explorer's renderer half: the tree, and the line to the main half that watches the
 * workspace's folders. Directories are still read through the shell's own `fs:list`; what main
 * adds is only the news that a listing has gone stale.
 *
 * The subscription lives here rather than in the tree, which unmounts whenever another view takes
 * the left panel; the listings it invalidates are module state and outlive the tree.
 */
const plugin: Plugin = {
  name: 'explorer',
  inject: ['contributions', 'rpc'],
  apply(ctx: Context) {
    ctx.contributions.view('explorer.files', FileExplorer)

    // Captured once and bound: a detached cordis service method has no `this`.
    const rpc = ctx.rpc
    ctx.effect(() => connect(rpc.invoke.bind(rpc)), 'rpc client')
    const on = explorerSubscriber(rpc.on.bind(rpc))
    on('changed', ({ dirs }) => { onChanged(dirs) })
  }
}

export default plugin
