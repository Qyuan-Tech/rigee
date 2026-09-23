import type { Context, Plugin } from 'cordis'
import { patchPluginTab, pluginTabs } from '@rigee/plugin-api'
import { scmSubscriber } from '../protocol'
import { DiffPane } from './DiffPane'
import { diffTabKey, readDiffTabState } from './diffTab'
import { connect } from './rpc'
import { ScmPanel } from './ScmPanel'
import { setRepoStatus } from './store'
import { BranchStatusItem } from './StatusItem'
import './scm.css'

/**
 * Source control, renderer half: the panel, the diff tab and the branch item.
 *
 * `inject` is mandatory — without it, reading `ctx.contributions` throws and, worse, a half whose
 * injection cannot be satisfied sits in PENDING forever with `apply` never running. `apply` must
 * also keep its braced body: cordis reads a plugin's return value as an effect and throws
 * `TypeError: Invalid effect` for anything that is not void, a function or an (async)iterable.
 *
 * Everything below is either a binding (revoked with the fiber, so disposing the plugin empties
 * the right rail rather than leaving a component closed over a dead context) or a capture. Note
 * that the status subscription lives HERE and not in the panel: collapsing the right rail
 * unmounts the panel, and the status bar item has to keep showing a branch that is still moving.
 */
const plugin: Plugin = {
  name: 'scm',
  inject: ['contributions', 'rpc'],
  apply(ctx: Context) {
    ctx.contributions.view('scm.panel', ScmPanel)
    ctx.contributions.tab('scm.diff', DiffPane)
    ctx.contributions.statusItem('scm.branch', BranchStatusItem)

    // Captured once and parked where components can reach it, and BOUND — cordis substitutes the
    // shadow context only when a service method is called with the service proxy as its receiver,
    // so a bare `ctx.rpc.invoke` handed to something that calls it as a plain function arrives
    // with `this` undefined and throws on `this.ctx`. Measured per call on 4.0.0-rc.10:
    // `ctx.rpc.invoke()` 15.7 us, `rpc.invoke()` 4.7 us, bound 0.20 us.
    const rpc = ctx.rpc
    ctx.effect(() => connect(rpc.invoke.bind(rpc)), 'rpc client')

    const on = scmSubscriber(rpc.on.bind(rpc))
    on('status', ({ status }) => { setRepoStatus(status) })

    adoptRestoredDiffs()
  }
}

/**
 * Give diff tabs restored from an older session the identity the shell could not give them.
 *
 * A `diff` tab persisted before the plugin system arrives as a custom tab with this plugin's view
 * type and the old tab object spread into its state — but with no `key`, because inventing one
 * would have meant the shell knowing that a diff is identified by repo, path and revision pair.
 * Without a key, clicking that same file in the panel opens a SECOND diff of it instead of
 * re-activating the one already open. The plugin that owns the scheme backfills it, once, here.
 *
 * Tooltips are restored in the same pass, for the same reason.
 */
function adoptRestoredDiffs(): void {
  for (const tab of pluginTabs('scm.diff')) {
    if (tab.key) continue
    const state = readDiffTabState(tab.state)
    if (!state) continue
    patchPluginTab(tab.tabId, { key: diffTabKey(state), tooltip: state.filePath })
  }
}

export default plugin
