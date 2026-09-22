import type { ComponentType } from 'react'
import { pluginUiChanged } from './signal'
import type { ViewType } from '@shared/plugin'

/**
 * Where a plugin's components actually live, once it has activated.
 *
 * Plain Maps and a version counter, with no idea that cordis exists. That separation is the point:
 * reading a service off a cordis Context rebuilds a shadow context on every property access —
 * measured at ~15 us against 8 ns for a plain property — so the framework must never be on the
 * path a React render takes. The cordis services write here during activation; the shell reads
 * here on every render.
 *
 * Nothing in this module may be imported by a plugin. Plugins go through `ctx.contributions`,
 * which enforces the namespace rules and revokes the binding when the plugin is disposed.
 */

/** What every plugin-contributed editor receives. Kept to the two things a viewer cannot infer. */
export interface PluginEditorProps {
  /** Absolute path of the file to show. */
  filePath: string
  /** The tab this instance belongs to; the right key for any per-tab state a viewer keeps. */
  tabId: string
  readOnly: boolean
}

/** What a plugin-owned tab receives: its own persisted state, and the way to change it. */
export interface PluginTabProps {
  tabId: string
  state: Record<string, unknown>
  /** Merged into the tab's state and persisted with it. */
  patchState: (patch: Record<string, unknown>) => void
  /**
   * Rename the tab in the strip, and optionally give it a hover tooltip.
   *
   * The tooltip is a second argument rather than a second function because the two always change
   * together: a page navigates and both its title and its URL are new.
   */
  setTitle: (title: string, tooltip?: string) => void
}

/** What a side-bar panel receives. The shell owns the rail and the collapse affordance. */
export interface PluginViewProps {
  onCollapse: () => void
}

export type PluginEditorComponent = ComponentType<PluginEditorProps>
export type PluginTabComponent = ComponentType<PluginTabProps>
export type PluginViewComponent = ComponentType<PluginViewProps>
/**
 * No props at all. `Record<never, never>` rather than `Record<string, never>`: the latter carries
 * an index signature, and React's JSX check then rejects the `key` the shell has to put on every
 * item it maps over.
 */
export type PluginStatusItemComponent = ComponentType<Record<never, never>>
export type PluginOverlayComponent = ComponentType<Record<never, never>>

/** What a plugin returns when the shell asks it for a fresh tab of its own type. */
export type PluginTabFactory = () => {
  title: string
  state: Record<string, unknown>
  key?: string
}

const editors = new Map<ViewType, PluginEditorComponent>()
const tabs = new Map<ViewType, PluginTabComponent>()
const views = new Map<ViewType, PluginViewComponent>()
const statusItems = new Map<ViewType, PluginStatusItemComponent>()
const overlays = new Map<ViewType, PluginOverlayComponent>()
const tabFactories = new Map<ViewType, PluginTabFactory>()

/** Binding and unbinding are half of what makes the plugin UI move; see signal.ts for the rest. */
const changed = pluginUiChanged

export const editorComponent = (viewType: ViewType): PluginEditorComponent | undefined =>
  editors.get(viewType)
export const tabComponent = (viewType: ViewType): PluginTabComponent | undefined =>
  tabs.get(viewType)
export const viewComponent = (id: ViewType): PluginViewComponent | undefined => views.get(id)
export const statusItemComponent = (id: ViewType): PluginStatusItemComponent | undefined =>
  statusItems.get(id)
export const overlayComponent = (id: ViewType): PluginOverlayComponent | undefined =>
  overlays.get(id)

export const tabFactory = (viewType: ViewType): PluginTabFactory | undefined =>
  tabFactories.get(viewType)

/** Every bound overlay, for the shell to mount. Sorted so the order cannot depend on timing. */
export function boundOverlays(): [ViewType, PluginOverlayComponent][] {
  return [...overlays].sort(([a], [b]) => a.localeCompare(b))
}

type Slot = 'editor' | 'tab' | 'view' | 'statusItem' | 'overlay' | 'tabFactory'

const slots: Record<Slot, Map<ViewType, unknown>> = {
  editor: editors,
  tab: tabs,
  view: views,
  statusItem: statusItems,
  overlay: overlays,
  tabFactory: tabFactories
}

/**
 * Bind a component (or a tab factory), returning the undo.
 *
 * The undo is what `ctx.effect` holds, so a disposed plugin's components disappear from the shell
 * rather than lingering as stale closures over a dead context.
 */
export function bind(slot: Slot, id: ViewType, value: unknown): () => void {
  const map = slots[slot]
  map.set(id, value)
  changed()
  return () => {
    // Only if it is still ours: a plugin reloaded while the old fiber was disposing would
    // otherwise have its fresh binding removed by the old one's teardown.
    if (map.get(id) === value) {
      map.delete(id)
      changed()
    }
  }
}
