/**
 * The plugin catalog: every plugin on GitHub, fetched by itself every few hours and kept in
 * `<userData>/plugin-catalog.json`.
 *
 * The plugins view used to ask GitHub every time somebody searched in it. That made browsing cost
 * one of GitHub's ten anonymous searches a minute per question, showed no list at all until
 * somebody typed, and nothing whatever offline. Main keeps the whole list instead — a repository
 * tagged rigee-plugin is a few hundred bytes, and there are a handful — and the view filters it.
 *
 * THE CLOCK. A first look shortly after launch, then one every half hour. A look fetches only when
 * the list is six hours old, and not again for half an hour after a fetch fails; everything else
 * about a look is comparing two times. Each look reads the clock rather than trusting the timer, so
 * a laptop that slept through a refresh fetches at its next look, and the timers are unref'd, so
 * they never keep the process alive. Opening the plugins view is a look too, so a stale list starts
 * refreshing the moment somebody comes to read it. Refresh in the view fetches whatever the age.
 *
 * A failed fetch keeps the list it had: an old list says how old it is, and is far more use than an
 * empty one. Only a fetch that lands replaces it, and only then is the file written.
 */

import { existsSync, readFileSync } from 'node:fs'
import { writeAtomic } from '../store'
import { DEFAULT_TIMING, fetchDue, parseCatalogFile, serializeCatalog, type CatalogTiming } from './catalogFile'
import { fetchCatalog } from './github'
import type { MarketPlugin, PluginCatalog } from '@shared/ipc'

interface CatalogOptions {
  file: string
  /** Told whenever the catalog changes: a fetch starting, landing or failing. */
  notify: (catalog: PluginCatalog) => void
  /**
   * Whether fetching by itself is allowed right now — the clock's and the view's. Refresh, which
   * somebody pressed, is never asked. False in a smoke mode with no stand-in for GitHub: a check
   * that went to the real one would depend on the network and spend the developer's rate limit.
   */
  mayFetch: () => boolean
  timing?: CatalogTiming
}

let options: CatalogOptions | null = null
let timing: CatalogTiming = DEFAULT_TIMING
let plugins: MarketPlugin[] = []
let fetchedAt: number | null = null
let failedAt: number | null = null
let error: string | null = null
let inFlight: Promise<void> | null = null
let timer: NodeJS.Timeout | null = null

/** Read the file and start the clock. Once, at app ready: a small synchronous read, and no request. */
export function initCatalog(o: CatalogOptions): void {
  options = o
  timing = o.timing ?? DEFAULT_TIMING
  if (existsSync(o.file)) {
    try {
      const read = parseCatalogFile(readFileSync(o.file, 'utf8'))
      if (read) {
        plugins = read.plugins
        fetchedAt = read.fetchedAt
      }
    } catch {
      // Unreadable is no list, which the first look fetches again.
    }
  }
  schedule(timing.firstCheck)
}

export function catalogSnapshot(): PluginCatalog {
  return { plugins, fetchedAt, refreshing: inFlight !== null, error }
}

/** The cached list, for the view that just opened — and, when it is due, a fetch started behind it. */
export function catalogForView(): PluginCatalog {
  look()
  return catalogSnapshot()
}

/**
 * Fetch now. One fetch at a time: asking again while one is under way waits for that one, so a
 * Refresh pressed twice, or pressed as the clock fires, spends one search, not two.
 */
export async function refreshCatalog(): Promise<PluginCatalog> {
  if (!inFlight) {
    inFlight = fetchAndKeep().finally(() => {
      inFlight = null
      notify()
    })
    notify()
  }
  await inFlight
  return catalogSnapshot()
}

/** Never rejects: a failure is kept as `error`, beside the list that was there before it. */
async function fetchAndKeep(): Promise<void> {
  try {
    const list = await fetchCatalog()
    plugins = list
    fetchedAt = Date.now()
    failedAt = null
    error = null
    if (options) {
      try {
        writeAtomic(options.file, serializeCatalog(fetchedAt, plugins))
      } catch (err) {
        // The list in memory is still right; the next launch fetches instead of reading it.
        console.warn('[plugins] could not keep the catalog:', err)
      }
    }
  } catch (err) {
    failedAt = Date.now()
    error = err instanceof Error ? err.message : String(err)
  }
}

function look(): void {
  if (!options?.mayFetch() || inFlight) return
  if (fetchDue({ fetchedAt, failedAt }, Date.now(), timing)) void refreshCatalog()
}

function schedule(delay: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    look()
    schedule(timing.checkEvery)
  }, delay)
  timer.unref()
}

function notify(): void {
  options?.notify(catalogSnapshot())
}
