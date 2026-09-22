import type { Context, Plugin } from 'cordis'
import { MonacoEditor } from './MonacoEditor'

/**
 * The text editor's renderer half — and the smallest complete example of a plugin.
 *
 * Three things every half must get right, all of them verified against cordis 4.0.0-rc.10:
 *
 *   - `inject` is MANDATORY. Reading `ctx.contributions` without declaring it throws
 *     "cannot get property "contributions" without inject", and a half whose injection cannot be
 *     satisfied does not fail loudly — its fiber sits in PENDING forever. The host asserts the
 *     fiber reached ACTIVE so that turns back into a real error.
 *   - `apply` must have a BRACED body. cordis treats a plugin's return value as an effect and
 *     throws `TypeError: Invalid effect` for anything that is not void, a function or an
 *     (async)iterable — so the tempting `apply: (ctx) => ctx.contributions.editor(...)` is a trap.
 *   - Binding is an effect on this plugin's fiber, so disposing the plugin un-binds the editor.
 *     Nothing here has to remember to clean up.
 */
const plugin: Plugin = {
  name: 'text-editor',
  inject: ['contributions'],
  apply(ctx: Context) {
    ctx.contributions.editor('text-editor.monaco', MonacoEditor)
  }
}

export default plugin
