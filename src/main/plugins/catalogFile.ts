/**
 * The plugin catalog's file and its timetable: the parts of catalog.ts with no Electron, network or
 * disk in them, so `pnpm plugins:selftest` can run them under plain Node.
 */

import { marketPluginOf } from './convention'
import type { MarketPlugin } from '@shared/ipc'

export const CATALOG_FILE_VERSION = 1

/** More than GitHub's search will ever return for one query, which stops at a thousand. */
const MAX_ENTRIES = 1000

export interface CatalogTiming {
  /** From app ready to the first look: off the launch path, after the window is up. */
  firstCheck: number
  /** Between looks. A look compares two times; only a stale list costs a request. */
  checkEvery: number
  /** How old the list may get before a look fetches it again. */
  staleAfter: number
  /** After a fetch fails — offline, rate-limited, GitHub down — before a look tries again. */
  retryAfter: number
}

/**
 * A look every half hour, a fetch when the list is six hours old. New plugins are rare enough that
 * six hours is fresh, and a fetch is one of GitHub's ten anonymous searches a minute — a budget the
 * user's own Refresh shares — so the clock spends a few a day.
 */
export const DEFAULT_TIMING: CatalogTiming = {
  firstCheck: 20_000,
  checkEvery: 30 * 60_000,
  staleAfter: 6 * 60 * 60_000,
  retryAfter: 30 * 60_000
}

/**
 * Whether a look at `now` should fetch: the list is missing or stale, and the last failure, if
 * there was one, is far enough behind. A list dated in the future — the clock was put back — counts
 * as stale, or it would stay "fresh" until the clock caught up with it.
 */
export function fetchDue(
  state: { fetchedAt: number | null; failedAt: number | null },
  now: number,
  timing: CatalogTiming
): boolean {
  const { fetchedAt, failedAt } = state
  const stale = fetchedAt === null || now - fetchedAt >= timing.staleAfter || fetchedAt > now + 60_000
  const resting = failedAt !== null && now - failedAt < timing.retryAfter && failedAt <= now
  return stale && !resting
}

export function serializeCatalog(fetchedAt: number, plugins: readonly MarketPlugin[]): string {
  return `${JSON.stringify({ version: CATALOG_FILE_VERSION, fetchedAt, plugins }, null, 2)}\n`
}

/**
 * The file read back — or null when it is not one this build wrote, which is treated as no list at
 * all and fetched again rather than half-believed.
 *
 * Every entry goes back through `marketPluginOf`, the same check a search result passes, so a file
 * edited by hand or left behind by another build can drop entries but never add one that is not a
 * plugin by the convention, and the fields the renderer shows are the ones that check produces.
 */
export function parseCatalogFile(text: string): { fetchedAt: number; plugins: MarketPlugin[] } | null {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  const d = (doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>
  if (d.version !== CATALOG_FILE_VERSION) return null
  if (typeof d.fetchedAt !== 'number' || !Number.isFinite(d.fetchedAt) || !Array.isArray(d.plugins)) return null

  const seen = new Set<string>()
  const plugins: MarketPlugin[] = []
  for (const entry of d.plugins.slice(0, MAX_ENTRIES)) {
    const plugin = fromCache(entry)
    const key = plugin && `${plugin.owner.toLowerCase()}/${plugin.repo}`
    if (!plugin || !key || seen.has(key)) continue
    seen.add(key)
    plugins.push(plugin)
  }
  return { fetchedAt: d.fetchedAt, plugins }
}

/** A cached entry in the shape of the search result it came from, so the one check can judge it. */
function fromCache(entry: unknown): MarketPlugin | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  return marketPluginOf({
    name: e.repo,
    owner: { login: e.owner },
    description: e.description,
    stargazers_count: e.stars,
    pushed_at: e.updatedAt,
    license: typeof e.license === 'string' ? { spdx_id: e.license } : null,
    topics: e.topics,
    archived: false,
    fork: false,
    private: false
  })
}
