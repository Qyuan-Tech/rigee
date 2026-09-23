import { openPluginTab, subscribeTabs } from '@rigee/plugin-api'
import { AuthDialog } from './AuthDialog'
import { BrowserPane, HOME_URL } from './BrowserPane'
import { bindRpc, dispatch } from './rpc'
import { adoptView, reap, subscribeVisibleViews, tabIdFor } from './views'
import './browser.css'
import type {
  AuthRequestedEvent,
  LoadErrorEvent,
  StateEvent,
  TabRequestedEvent
} from '../protocol'
import type { Context, Plugin } from 'cordis'

/**
 * The browser's renderer half: one tab type, its "new tab" button, and the auth dialog.
 *
 * Everything cordis is here and nowhere else in the plugin. The components underneath talk to
 * `rpc.ts`, which holds the invoke captured below — the framework must not be on a path a React
 * render or a ResizeObserver takes.
 */
const plugin: Plugin = {
  name: 'browser',
  // Mandatory. Reading either service undeclared throws, and an unsatisfiable injection leaves
  // the fiber PENDING forever with apply() never running.
  inject: ['contributions', 'rpc'],
  apply(ctx: Context) {
    // BOUND, not merely captured. cordis substitutes the shadow context in the apply trap only
    // `if (thisArg === outer)` — i.e. only when the method is called with the service proxy as its
    // receiver — so a bare `bindRpc(ctx.rpc.invoke)` arrives with `this === undefined` and throws
    // `Cannot read properties of undefined (reading 'ctx')` at the first navigation. Measured per
    // call: 17.7 us through ctx, 4.5 us through a held service, 0.22 us bound. setBounds rides a
    // ResizeObserver and every splitter drag, so this is the one that matters.
    const rpc = ctx.rpc
    bindRpc(rpc.invoke.bind(rpc))

    // One subscription per event for the whole plugin, registered through ctx.effect by the
    // service, and fanned out to whichever components are mounted. A pane cannot subscribe
    // through ctx itself: it has no context, and a listener taken on mount would outlive a
    // disposed plugin.
    rpc.on<StateEvent>('state', (payload) => dispatch('state', payload))
    rpc.on<AuthRequestedEvent>('authRequested', (payload) => dispatch('authRequested', payload))
    rpc.on<LoadErrorEvent>('error', (payload) => dispatch('error', payload))

    /*
     * window.open, and target=_blank.
     *
     * Main has already adopted the guest WebContents by the time this arrives — Electron creates
     * it and refusing it throws — so the view exists and is composited; all that is missing is a
     * tab pointing at it. Nothing listened to this event before the extraction either, which made
     * a popup an invisible page that lived until the app quit, even though the README has claimed
     * this works.
     *
     * Registering the view id immediately after `openPluginTab` is soon enough, and that is worth
     * being explicit about: opening a tab is a synchronous store write, but the pane it produces
     * cannot mount until React commits, which is after this handler returns. So `adoptView` always
     * wins the race against the pane's `ensureView`, which would otherwise create a SECOND view
     * and leave the adopted one composited over the window with nothing referencing it.
     *
     * The popup belongs to the group its OPENER is in, which is why the opener is looked up rather
     * than ignored. A page in the left column that opens a login window would otherwise put it in
     * whichever group happens to be active — over the file the user was reading in the right one,
     * while the page that is waiting for the popup sits in the column they are no longer looking at.
     */
    rpc.on<TabRequestedEvent>('tabRequested', ({ viewId, url, openerViewId }) => {
      const tabId = openPluginTab('browser', {
        viewType: 'browser.page',
        title: url,
        tooltip: url,
        state: { url },
        nearTabId: tabIdFor(openerViewId)
      })
      if (tabId) adoptView(tabId, viewId)
    })

    ctx.contributions.tab('browser.page', BrowserPane)
    // What the tab strip's globe button makes. It lived in TabStrip as a literal tab object; the
    // plugin that owns the tab type is the only thing that knows what an empty one looks like.
    ctx.contributions.tabFactory('browser.page', () => ({
      title: 'new tab',
      state: { url: HOME_URL }
    }))
    ctx.contributions.overlay('browser.auth', AuthDialog)

    // Reap the native views of tabs that have been closed. Through ctx.effect so the store
    // subscription dies with the plugin rather than reaping on behalf of a dead one.
    ctx.effect(() => subscribeTabs(reap), 'reap views of closed tabs')

    // And keep what is composited equal to what is mounted. The panes show and hide their own
    // views; this is the net under them, for a view that ends up on screen with no pane behind it
    // — an adopted popup whose tab never got one, a mount whose cleanup lost its own race. A page
    // is a native view over the whole window, so an orphan is not a glitch, it is the app gone.
    ctx.effect(subscribeVisibleViews, 'reconcile composited views')
  }
}

export default plugin
