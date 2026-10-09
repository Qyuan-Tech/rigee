/**
 * Pure tab-strip logic.
 *
 * Extracted from the component and the store for the same reason `paneTree.ts` and the prefix
 * state machine in `keys.ts` were: the failure modes here are quiet ones. A bulk close that
 * sweeps up the wrong tabs takes a running process or a page with it, and a selection rule that
 * is off by one lands the user on a tab they did not ask for — neither throws, and both are
 * tedious to reproduce by hand once tabs, splits and a browser are in play.
 */

import type { Tab, TabId } from '@shared/types'

/**
 * Whether a plugin-owned view type counts as a document.
 *
 * Injected rather than imported so this module stays pure: the answer comes from the plugin
 * manifests, and reaching for them here would drag the registry — and with it the whole plugin
 * barrel — into a file whose entire value is being testable on its own (`pnpm panes:selftest`
 * bundles it with esbuild and no aliases).
 */
export type DocumentPredicate = (viewType: string) => boolean

/**
 * A tab showing a document: an editor, or a plugin tab that says it is one (a diff).
 *
 * What the strip draws as a file. It used to also be all the bulk-close commands would reach;
 * they reach every tab now, the way they do in VS Code, and a running program a sweep would stop
 * is asked about first instead (see `closeTabsSafely`).
 */
export function isFileTab(tab: Tab, isDocument: DocumentPredicate): boolean {
  if (tab.kind === 'editor') return true
  if (tab.kind === 'custom') return isDocument(tab.viewType)
  return false
}

export type CloseCommand =
  /** Every other tab, wherever it sits. */
  | 'others'
  /** Tabs positioned after this one. Position is the strip order, which the user can drag. */
  | 'right'
  /** Every tab, this one included. */
  | 'all'

export const isCloseCommand = (s: string): s is CloseCommand => s === 'others' || s === 'right' || s === 'all'

/**
 * The tabs a bulk close takes, of every kind alike — terminal, page and file. One strip, one set
 * of commands: a menu that offered "Close to the Right" on a file but nothing on the terminal
 * beside it read as a strip with two kinds of tab in it, which is exactly what it should not be.
 */
export function tabsToClose(tabs: readonly Tab[], tabId: TabId, command: CloseCommand): TabId[] {
  const index = tabs.findIndex((t) => t.id === tabId)
  if (index < 0) return []

  // Pinned tabs sit out the two "sweep up everything around me" commands but not an explicit
  // close-all, which is what VSCode does and what `TabBase.pinned` already promises. Nothing in
  // the UI sets the flag yet; honouring it here means whoever adds the toggle gets the behaviour
  // rather than having to remember this file.
  const sweepable = (t: Tab): boolean => !t.pinned

  switch (command) {
    case 'others':
      return tabs.filter((t) => t.id !== tabId && sweepable(t)).map((t) => t.id)
    case 'right':
      return tabs.slice(index + 1).filter(sweepable).map((t) => t.id)
    case 'all':
      return tabs.map((t) => t.id)
  }
}

/**
 * Where selection lands after `doomed` closes: the nearest survivor to the right, falling back to
 * the left. Matches VSCode.
 *
 * Computed once over the whole set rather than per tab. Closing one at a time would move the
 * selection onto a tab that is itself about to close, so it would walk the strip and settle
 * somewhere arbitrary.
 */
export function nextActiveTab(
  tabs: readonly Tab[],
  active: TabId | null,
  doomed: ReadonlySet<TabId>
): TabId | null {
  if (active === null || !doomed.has(active)) return active
  const index = tabs.findIndex((t) => t.id === active)
  const right = tabs.slice(index + 1).find((t) => !doomed.has(t.id))
  const left = tabs.slice(0, index).findLast((t) => !doomed.has(t.id))
  return right?.id ?? left?.id ?? null
}
