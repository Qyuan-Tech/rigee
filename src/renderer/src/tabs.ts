/**
 * Pure tab-strip logic.
 *
 * Extracted from the component and the store for the same reason `paneTree.ts` and the prefix
 * state machine in `keys.ts` were: the failure modes here are quiet ones. A bulk close that
 * sweeps up a terminal takes a running process with it, and a selection rule that is off by one
 * lands the user on a tab they did not ask for — neither throws, and both are tedious to
 * reproduce by hand once tabs, splits and a browser are in play.
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
 * The bulk-close commands are scoped to these. Terminals and browser tabs share the strip but are
 * not documents — closing a terminal kills a shell that may be running something, and "close
 * everything to the right" is not a bargain anyone wants to make with a running process.
 */
export function isFileTab(tab: Tab, isDocument: DocumentPredicate): boolean {
  if (tab.kind === 'editor') return true
  if (tab.kind === 'custom') return isDocument(tab.viewType)
  return false
}

export type CloseCommand =
  /** Every other file tab, wherever it sits. */
  | 'others'
  /** File tabs positioned after this one. Position is the strip order, which the user can drag. */
  | 'right'
  /** Every file tab, this one included. */
  | 'all'

export function tabsToClose(
  tabs: readonly Tab[],
  tabId: TabId,
  command: CloseCommand,
  isDocument: DocumentPredicate
): TabId[] {
  const index = tabs.findIndex((t) => t.id === tabId)
  if (index < 0) return []

  // Pinned tabs sit out the two "sweep up everything around me" commands but not an explicit
  // close-all, which is what VSCode does and what `TabBase.pinned` already promises. Nothing in
  // the UI sets the flag yet; honouring it here means whoever adds the toggle gets the behaviour
  // rather than having to remember this file.
  const sweepable = (t: Tab): boolean => isFileTab(t, isDocument) && !t.pinned

  switch (command) {
    case 'others':
      return tabs.filter((t) => t.id !== tabId && sweepable(t)).map((t) => t.id)
    case 'right':
      // Counted over the whole strip, not over the file tabs alone: a terminal sitting between
      // two editors is skipped, not treated as the boundary.
      return tabs.slice(index + 1).filter(sweepable).map((t) => t.id)
    case 'all':
      return tabs.filter((t) => isFileTab(t, isDocument)).map((t) => t.id)
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
