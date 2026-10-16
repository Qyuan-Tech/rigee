import { revealView } from '../editing'

/**
 * A GitHub search the plugins view should run — what "Find a plugin on GitHub" asks for, from a tab
 * whose viewer is not installed.
 *
 * Held here, in the entry, because the plugins view is fetched when it is first shown: the button
 * cannot reach into a module that may not be loaded, so it leaves the search here and shows the
 * view, and the view takes the search as it mounts — or at once, if it is already on screen.
 */

let pending: string | null = null
const listeners = new Set<(query: string) => void>()

export function searchPluginsFor(query: string): void {
  if (listeners.size > 0) listeners.forEach((listener) => listener(query))
  else pending = query
  revealView('shell.plugins')
}

export function onPluginSearch(listener: (query: string) => void): () => void {
  listeners.add(listener)
  if (pending !== null) {
    const query = pending
    pending = null
    listener(query)
  }
  return () => { listeners.delete(listener) }
}
