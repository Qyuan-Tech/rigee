/**
 * Where each installed plugin came from: `<userData>/plugin-sources.json`.
 *
 * What makes "update" and "uninstall" possible for a plugin installed from GitHub, and what lets
 * the plugins view say "from github.com/owner/repo" rather than leaving the user to remember.
 *
 * KEPT OUT OF THE PLUGIN'S OWN DIRECTORY, which is where it would most naturally go. Trust is
 * pinned to a hash over every file in that directory, so writing a record into it would change the
 * hash of the very plugin the user just approved — and anything the plugin itself could rewrite is
 * no record of where it came from.
 *
 * Informational, never a trust input. A plugin with no entry here was put in the directory by hand
 * and is handled exactly as before; an entry that is wrong can make an update check ask the wrong
 * repository, but cannot make anything run — the hash and the user's approval decide that.
 */

import { existsSync, readFileSync } from 'node:fs'
import { writeAtomic } from '../store'
import type { PluginId } from '@rigee/plugin-api/manifest'

export interface PluginSource {
  kind: 'github'
  owner: string
  repo: string
  /** The release installed: `v1.2.0`, and the version it names. */
  tag: string
  version: string
  /** Of the tarball, as GitHub reported it and the download matched. */
  sha256: string
  installedAt: number
}

interface SourcesDocument {
  version: 1
  sources: Record<PluginId, PluginSource>
}

let cache: SourcesDocument | null = null
let path = ''

/** Point the store at its file. Called once, after app ready. */
export function initSourcesStore(filePath: string): void {
  path = filePath
  cache = null
}

function doc(): SourcesDocument {
  if (cache) return cache
  cache = { version: 1, sources: {} }
  if (!path || !existsSync(path)) return cache
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SourcesDocument> | null
    const sources = raw?.sources
    if (sources && typeof sources === 'object') cache.sources = sources
  } catch {
    // Unreadable means unknown, which only costs the update check. Nothing runs or stops on it.
  }
  return cache
}

export function sourceOf(id: PluginId): PluginSource | null {
  const s = doc().sources[id]
  return s && s.kind === 'github' && typeof s.owner === 'string' && typeof s.repo === 'string' ? s : null
}

export function allSources(): [PluginId, PluginSource][] {
  return Object.keys(doc().sources).flatMap((id) => {
    const s = sourceOf(id)
    return s ? [[id, s] as [PluginId, PluginSource]] : []
  })
}

export function recordSource(id: PluginId, source: PluginSource): void {
  doc().sources[id] = source
  flush()
}

export function forgetSource(id: PluginId): void {
  const d = doc()
  if (!(id in d.sources)) return
  delete d.sources[id]
  flush()
}

function flush(): void {
  if (path && cache) writeAtomic(path, JSON.stringify(cache, null, 2))
}
