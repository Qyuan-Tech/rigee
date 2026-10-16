import { Service, type Context } from 'cordis'
import { viewNamespace, type ViewType } from '@rigee/plugin-api/manifest'
import type { PluginContributionsService } from '@rigee/plugin-api/context'
import {
  bind,
  type PluginEditorComponent,
  type PluginOverlayComponent,
  type PluginStatusItemComponent,
  type PluginTabComponent,
  type PluginTabFactory,
  type PluginViewComponent
} from './bindings'
import { ownerOf } from './registry'

// `ctx.contributions` and `ctx.pluginId` are declared on Context by @rigee/plugin-api (context.ts),
// as the interface this class implements — so a plugin from another repository binds against the
// same declaration the bundled ones do.

/**
 * How a renderer half supplies the components its manifest promised.
 *
 * The manifest is the source of truth for what exists and who owns it; this service only accepts
 * the implementations. Two checks on every bind, both of which exist because the failure they
 * prevent is silent: binding a view type nobody declared would produce a component the shell can
 * never route to, and binding another plugin's view type would let the last plugin loaded quietly
 * take over the first one's UI.
 *
 * Every bind goes through `ctx.effect`, so disposing a plugin removes its components from the
 * shell — a tab showing one falls back to the "no viewer" notice instead of rendering a closure
 * over a dead context.
 */
export class ContributionService extends Service implements PluginContributionsService {
  constructor(ctx: Context) {
    super(ctx, 'contributions')
  }

  /** A viewer for files an `editors` contribution claimed. */
  editor(viewType: ViewType, component: PluginEditorComponent): void {
    this.attach('editor', viewType, component)
  }

  /** The body of a tab type this plugin owns. */
  tab(viewType: ViewType, component: PluginTabComponent): void {
    this.attach('tab', viewType, component)
  }

  /**
   * What a fresh tab of this type looks like, for the tab strip's "new one of these" button.
   *
   * Separate from `tab` because the shell asks for it before there is anything to render: the
   * button exists from the manifest alone, and pressing it activates the plugin and calls this.
   */
  tabFactory(viewType: ViewType, factory: PluginTabFactory): void {
    this.attach('tabFactory', viewType, factory)
  }

  /** A side-bar panel. */
  view(id: ViewType, component: PluginViewComponent): void {
    this.attach('view', id, component)
  }

  /** A status bar item. Rendered only while the plugin is active; it never forces activation. */
  statusItem(id: ViewType, component: PluginStatusItemComponent): void {
    this.attach('statusItem', id, component)
  }

  /** A component mounted at the shell root for as long as this plugin lives. */
  overlay(id: ViewType, component: PluginOverlayComponent): void {
    this.attach('overlay', id, component)
  }

  private attach(
    slot: 'editor' | 'tab' | 'view' | 'statusItem' | 'overlay' | 'tabFactory',
    id: ViewType,
    value: unknown
  ): void {
    const pluginId = this.ctx.pluginId
    if (!pluginId) throw new Error(`contributions.${slot}(${id}): no pluginId on this Context`)

    const prefix = viewNamespace(pluginId)
    if (!id.startsWith(prefix)) {
      throw new Error(`plugin "${pluginId}" may only bind ids prefixed "${prefix}", got "${id}"`)
    }
    const owner = ownerOf(id)
    if (!owner) throw new Error(`plugin "${pluginId}" binds "${id}", which no manifest declares`)
    if (owner !== pluginId) {
      throw new Error(`"${id}" belongs to plugin "${owner}", not "${pluginId}"`)
    }

    this.ctx.effect(() => bind(slot, id, value), `${slot} ${id}`)
  }
}
