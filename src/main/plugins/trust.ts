/**
 * Which third-party plugins the user has agreed to run, and on what terms.
 *
 * WHAT THIS IS. A plugin found on disk is inert. It is listed, its manifest is read, and nothing
 * of it is imported — not in main, not in the renderer — until the user has approved that exact
 * build. The grant records three things, and a change to any of them revokes it:
 *
 *   hash         the plugin's contents. An update, or anything else rewriting the directory,
 *                means the code is not the code that was approved.
 *   permissions  what it DECLARED it needs. Nothing enforces a declaration at the call site — see
 *                PluginPermission in @rigee/plugin-api — but a change in it is enforced here: a
 *                version that wants to run programs when the last one only read files does not
 *                load until the user has been asked again. That is the case worth catching,
 *                because nobody re-reads a plugin they already trusted.
 *   version      recorded for the UI, not enforced. A plugin can change its contents without
 *                bumping its version, and the hash is what notices.
 *
 * WHAT THIS IS NOT. It is not a sandbox, and the dialog it drives must not imply otherwise. A main
 * half is an ES module in the main process and imports `node:fs` for itself; a renderer half runs
 * in the shell's own JavaScript context and can reach `window.rigee` directly. Neither is confined
 * by anything in its manifest. What this buys is that untrusted code does not run AT ALL, and that
 * code which changes has to be approved again — which is a real property, and a different one from
 * "the plugin can only do what it declared".
 *
 * The honest framing, and the one the install dialog uses: approving a plugin runs its code with
 * the application's privileges, so the question is whether you trust where it came from.
 *
 * Real isolation means a separate context per plugin — a worker for the logic, a locked-down frame
 * for the UI, and every contribution point becoming a message. That is a much larger change and is
 * not pretended at here.
 */

import { existsSync, readFileSync } from 'node:fs'
import { writeAtomic } from '../store'
import type { PluginId, PluginPermission } from '@rigee/plugin-api/manifest'

export interface TrustGrant {
  /** SHA-256 of the plugin directory at the moment the user approved it. */
  hash: string
  /** Exactly what was shown in the dialog, sorted, so comparison is order-independent. */
  permissions: PluginPermission[]
  /** For the UI: "you approved version 1.2.0". Not part of the check. */
  version: string
  grantedAt: number
}

interface TrustDocument {
  version: 1
  grants: Record<PluginId, TrustGrant>
}

const EMPTY: TrustDocument = { version: 1, grants: {} }

let cache: TrustDocument | null = null
let path = ''

/** Point the store at `<userData>/plugin-trust.json`. Called once, after app ready. */
export function initTrustStore(filePath: string): void {
  path = filePath
  cache = null
}

function doc(): TrustDocument {
  if (cache) return cache
  if (!path || !existsSync(path)) {
    cache = { ...EMPTY, grants: {} }
    return cache
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const grants = (raw as TrustDocument | null)?.grants
    cache = { version: 1, grants: grants && typeof grants === 'object' ? grants : {} }
  } catch {
    // A trust file we cannot read means nothing is trusted. Failing OPEN here would run
    // third-party code because a JSON file got truncated, which is the one direction this must
    // never fail in.
    cache = { ...EMPTY, grants: {} }
  }
  return cache
}

export type TrustState =
  | { status: 'trusted' }
  /** Never approved. */
  | { status: 'untrusted' }
  /** Approved, but not this build — the files changed since. */
  | { status: 'changed'; approvedVersion: string }
  /** Approved, but it now wants more than it was given. */
  | { status: 'needs-permissions'; added: PluginPermission[] }

/**
 * Compare a plugin on disk against what the user approved.
 *
 * Four outcomes rather than a boolean, because the three failures want different words in the UI:
 * "install this?", "this changed, review it again", and "this update wants to run programs" are
 * not the same question, and collapsing them into "not trusted" is how a user learns to click yes.
 */
export function trustStateOf(
  id: PluginId,
  hash: string,
  wants: readonly PluginPermission[]
): TrustState {
  const grant = doc().grants[id]
  if (!grant) return { status: 'untrusted' }
  if (grant.hash !== hash) return { status: 'changed', approvedVersion: grant.version }

  const granted = new Set(grant.permissions)
  const added = wants.filter((p) => !granted.has(p))
  if (added.length > 0) return { status: 'needs-permissions', added }
  return { status: 'trusted' }
}

/** Record approval of one exact build. */
export function grantTrust(
  id: PluginId,
  hash: string,
  permissions: readonly PluginPermission[],
  version: string
): void {
  const d = doc()
  d.grants[id] = {
    hash,
    permissions: [...permissions].sort(),
    version,
    grantedAt: Date.now()
  }
  flush()
}

/** Withdraw approval. The plugin stays installed and becomes inert. */
export function revokeTrust(id: PluginId): void {
  const d = doc()
  if (!(id in d.grants)) return
  delete d.grants[id]
  flush()
}

function flush(): void {
  if (path && cache) writeAtomic(path, JSON.stringify(cache, null, 2))
}
