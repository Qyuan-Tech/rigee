import { useSyncExternalStore } from 'react'
import { explorerClient, type ExplorerCall } from '../protocol'
import type { FileStat } from '@rigee/plugin-api'

/**
 * Directory listings, cached by absolute path outside React — and told when they have gone stale.
 *
 * Shared rather than per-node so that switching workspaces and coming back does not re-read every
 * directory, and so "expand all" knows what the tree looks like without a storm of reads. A cache
 * that is never told anything shows a deleted file for ever, which is what it used to do; now the
 * main half's watcher names the directories that changed and only those are read again. Each one
 * carries a generation the tree subscribes to, so a node re-reads exactly when its own listing
 * moved, and keeps showing the old one until the new one arrives rather than flashing empty.
 */
export const listings = new Map<string, FileStat[]>()

const generations = new Map<string, number>()
const listeners = new Set<() => void>()
let generation = 0

/** Forget these listings, so any open node showing one reads it again. Unknown paths are ignored. */
export function invalidate(dirs: Iterable<string>): void {
  let any = false
  for (const dir of dirs) {
    if (!listings.delete(dir)) continue
    generations.set(dir, ++generation)
    any = true
  }
  if (any) for (const l of listeners) l()
}

/** Every listing read so far: the refresh button. */
export const invalidateAll = (): void => invalidate([...listings.keys()])

/** Changes for the node showing `path`: when it does, the listing has been forgotten. */
export function useListingGeneration(path: string): number {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l) },
    () => generations.get(path) ?? 0
  )
}

export function onChanged(dirs: string[]): void {
  invalidate(dirs)
}

let call: ExplorerCall | null = null
/** Whether main is watching anything, so that nothing has to be asked to stop. */
let watching = false

export function connect(invoke: (command: string, args: unknown) => Promise<unknown>): () => void {
  call = explorerClient(invoke)
  return () => { call = null }
}

/**
 * Watch these folders, and only these. Failing to is not fatal: the refresh button still works.
 *
 * Nothing is sent for nothing to watch while nothing is watched — Scratch, at launch. The first
 * call to a plugin's main half builds main's plugin host, which is kept off the launch path until
 * something actually needs it, and `pnpm smoke:plugins` holds it to that.
 */
export function watchFolders(roots: string[]): void {
  if (roots.length === 0 && !watching) return
  watching = roots.length > 0
  void call?.('explorer:watch', { roots }).catch((e: unknown) => console.warn('[explorer] watch failed', e))
}
