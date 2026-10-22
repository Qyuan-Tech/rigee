/**
 * Reading the cached plugin catalog: which plugins match what was typed, and how old the list is.
 *
 * In shared because the plugins view filters with it and `pnpm plugins:selftest` holds it to what
 * GitHub's own search would have matched. Pure string work, no node:*, so the renderer loads it.
 */

import type { MarketPlugin } from './ipc'
import { t, tn } from './l10n'

/**
 * Whether a plugin matches the words typed: every word, in any order, somewhere in its id, its
 * repository and owner, its description or its topics — the fields GitHub's repository search looks
 * in by default, which is what typing in this box used to ask GitHub. No words matches everything.
 */
export function matchesPluginQuery(plugin: MarketPlugin, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = [plugin.id, plugin.repo, plugin.owner, plugin.description ?? '', ...plugin.topics]
    .join(' ')
    .toLowerCase()
  return words.every((w) => haystack.includes(w))
}

/** `just now`, `5 minutes ago`, `3 hours ago`, `2 days ago` — how old a list fetched at `then` is. */
export function ageText(then: number, now: number): string {
  const seconds = Math.max(0, (now - then) / 1000)
  if (seconds < 45) return t('just now')
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return tn(minutes, '1 minute ago', '{n} minutes ago')
  const hours = Math.round(minutes / 60)
  if (hours < 36) return tn(hours, '1 hour ago', '{n} hours ago')
  const days = Math.round(hours / 24)
  return tn(days, '1 day ago', '{n} days ago')
}
