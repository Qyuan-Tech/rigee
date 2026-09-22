import { FileExplorer } from './FileExplorer'
import type { Context, Plugin } from 'cordis'

/**
 * The explorer's renderer half. There is no main half: the tree reads directories through the
 * shell's own `fs:list`, which is not the explorer's capability to own — the workspace picker and
 * anything else that browses the disk uses it too.
 */
const plugin: Plugin = {
  name: 'explorer',
  inject: ['contributions'],
  apply(ctx: Context) {
    ctx.contributions.view('explorer.files', FileExplorer)
  }
}

export default plugin
