import type { Context, Plugin } from 'cordis'
import { connect } from './rpc'
import { SearchPanel } from './SearchPanel'
import './search.css'

/**
 * Search, renderer half: the panel. Everything it needs from main goes through the client parked
 * in rpc.ts, captured once here for the reason plugins/scm/renderer/rpc.ts gives.
 */
const plugin: Plugin = {
  name: 'search',
  inject: ['contributions', 'rpc'],
  apply(ctx: Context) {
    ctx.contributions.view('search.panel', SearchPanel)
    const rpc = ctx.rpc
    ctx.effect(() => connect(rpc.invoke.bind(rpc)), 'rpc client')
  }
}

export default plugin
