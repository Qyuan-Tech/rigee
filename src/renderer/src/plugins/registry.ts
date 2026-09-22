import { PLUGIN_MANIFESTS } from '@plugins/index'
import {
  matchesSelector,
  type EditorContribution,
  type IconName,
  type OverlayContribution,
  type PluginContributions,
  type PluginId,
  type StatusBarContribution,
  type TabContribution,
  type ViewContribution,
  type ViewType
} from '@shared/plugin'

/**
 * Everything the shell can know about plugins without loading one.
 *
 * This is the declarative half of the plugin system, and the reason startup is unaffected by how
 * many plugins exist: the tables below are built once from plain manifest data, and answering
 * "who opens a .pdf", "what goes in the right rail", "which icon does this tab want" costs an
 * array scan over a handful of entries.
 *
 * MUST NOT IMPORT CORDIS, or any plugin implementation. It is statically imported by the shell,
 * so anything it reaches lands in the entry chunk — which is exactly what the split in
 * @shared/plugin exists to prevent.
 */

type Owned<T> = T & { owner: PluginId }

/** Flatten one contribution point across every manifest, stamping each entry with its owner. */
function collect<T>(pick: (c: PluginContributions) => readonly T[] | undefined): Owned<T>[] {
  const out: Owned<T>[] = []
  for (const manifest of PLUGIN_MANIFESTS) {
    for (const contribution of pick(manifest.contributes ?? {}) ?? []) {
      out.push({ ...contribution, owner: manifest.id })
    }
  }
  return out
}

/**
 * Editors, highest priority first, so resolution is a plain `find`.
 *
 * `sort` is stable (guaranteed since ES2019), so equal priorities keep manifest order rather than
 * whatever order the engine happens to produce.
 */
const editors: Owned<EditorContribution>[] = collect((c) => c.editors).sort(
  (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
)
const tabs: Owned<TabContribution>[] = collect((c) => c.tabs)
const views: Owned<ViewContribution>[] = collect((c) => c.views).sort(
  (a, b) => (a.order ?? 0) - (b.order ?? 0)
)
const statusItems: Owned<StatusBarContribution>[] = collect((c) => c.statusBar).sort(
  (a, b) => (a.order ?? 0) - (b.order ?? 0)
)
const overlays: Owned<OverlayContribution>[] = collect((c) => c.overlays)

/**
 * Which plugin owns a view type, tab type, view or status item.
 *
 * Read off the manifest rather than split from the dotted id, so an id that does not belong to
 * anybody is `null` instead of a plausible-looking plugin name nothing will ever activate.
 */
export function ownerOf(id: ViewType): PluginId | null {
  return (
    editors.find((c) => c.viewType === id)?.owner ??
    tabs.find((c) => c.viewType === id)?.owner ??
    views.find((c) => c.id === id)?.owner ??
    statusItems.find((c) => c.id === id)?.owner ??
    overlays.find((c) => c.id === id)?.owner ??
    null
  )
}

/** Which editor should open this path. Never null: the text editor claims everything. */
export function resolveViewType(absolutePath: string): ViewType | null {
  return editors.find((c) => matchesSelector(c.selector, absolutePath))?.viewType ?? null
}

/** Every editor that claims this path, best first. The "Open with" list. */
export function editorsFor(absolutePath: string): Owned<EditorContribution>[] {
  return editors.filter((c) => matchesSelector(c.selector, absolutePath))
}

/**
 * The editor of last resort for this path — the lowest-priority claimant, which is the text
 * editor unless someone contributes something even less specific.
 *
 * What "Open as text" opens, and what the shell offers when the viewer a tab names has gone away.
 * Derived rather than hard-coded: the shell must not know that a plugin called `text-editor`
 * exists, or the fallback becomes a second, invisible dependency on it.
 */
export function fallbackViewType(absolutePath: string): ViewType | null {
  const claimants = editorsFor(absolutePath)
  return claimants[claimants.length - 1]?.viewType ?? null
}

export const editorContribution = (viewType: ViewType): Owned<EditorContribution> | null =>
  editors.find((c) => c.viewType === viewType) ?? null

export const tabContribution = (viewType: ViewType): Owned<TabContribution> | null =>
  tabs.find((c) => c.viewType === viewType) ?? null

/** Tab types offering a "new one of these" button in the tab strip. */
export const creatableTabs = (): Owned<TabContribution>[] => tabs.filter((c) => c.creatable)

/**
 * Whether a plugin tab is a document, for the bulk-close commands.
 *
 * Unknown view types are not documents: a tab whose plugin has vanished should not be swept up by
 * "Close All Files" on a guess.
 */
export const isDocumentViewType = (viewType: string): boolean =>
  tabs.find((c) => c.viewType === viewType)?.isDocument === true

/**
 * The view type a tab kind from an older persisted state becomes.
 *
 * Before the plugin system the shell had `diff` and `browser` tab kinds of its own. It does not
 * any more, and rather than teach it about them again the plugins that took them over declare
 * `legacyKind` — so the migration disappears with the last plugin that needs it.
 */
export const viewTypeForLegacyKind = (kind: string): ViewType | null =>
  tabs.find((c) => c.legacyKind === kind)?.viewType ?? null

export const viewsIn = (slot: 'left' | 'right'): Owned<ViewContribution>[] =>
  views.filter((v) => v.slot === slot)

export const statusItemsIn = (align: 'left' | 'right'): Owned<StatusBarContribution>[] =>
  statusItems.filter((s) => s.align === align)

export const overlayIds = (): ViewType[] => overlays.map((o) => o.id)

/** The icon a tab of this view type wants, if it asked for one. */
export function iconFor(viewType: ViewType | undefined): IconName | null {
  if (!viewType) return null
  return (
    editors.find((c) => c.viewType === viewType)?.icon ??
    tabs.find((c) => c.viewType === viewType)?.icon ??
    null
  )
}

/** The human name for a view type, for tooltips and the "no viewer" notice. */
export function displayNameOf(viewType: ViewType): string | null {
  return (
    editors.find((c) => c.viewType === viewType)?.displayName ??
    tabs.find((c) => c.viewType === viewType)?.displayName ??
    null
  )
}
