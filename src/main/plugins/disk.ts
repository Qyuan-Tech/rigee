/**
 * Plugins that did not ship with the app.
 *
 * `<userData>/plugins/<id>/package.json`, with the manifest under a `rigee` key — the same layout
 * npm already produces, so a plugin is an ordinary package and installing one is an unpack.
 *
 * The bundled plugins do NOT come through here, and that is deliberate rather than transitional.
 * They are in the build's module graph, so Rollup gives each its own chunk, the manifests cost a
 * kilobyte, and a launch that opens nothing loads none of them. Routing them through disk would
 * trade that for a directory scan and a hash of every file at boot, to solve a problem they do not
 * have. Two sources, one registry, and the rest of the system cannot tell which is which.
 *
 * EVERYTHING HERE IS DEFENSIVE, because everything here is somebody else's data. A manifest is
 * whatever JSON happened to be in the file: fields may be missing, may be the wrong type, may be
 * enormous, may be hostile. Nothing is trusted into a type without being checked, and a plugin
 * that fails a check is reported with the reason rather than dropped — a plugin that silently does
 * not appear is indistinguishable from one that did not install.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import {
  PLUGIN_API_VERSION,
  viewNamespace,
  type DiskPluginManifest,
  type PluginContributions,
  type PluginId,
  type PluginPermission
} from '@rigee/plugin-api/manifest'

/** Ids are directory names and URL authorities. Keep them boring. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Ceiling on what will be hashed for one plugin.
 *
 * The hash is what pins trust to the exact bytes the user approved, so it has to cover every file
 * — but "every file" is attacker-controlled, and a plugin directory containing a 4 GB file would
 * otherwise stall the boot path reading it. Past the ceiling the plugin is rejected rather than
 * partially hashed: a hash over some of the files would be a trust decision about code nobody
 * looked at.
 */
const MAX_PLUGIN_BYTES = 64 * 1024 * 1024
const MAX_PLUGIN_FILES = 5000

const PERMISSIONS = new Set<string>(['files:read', 'files:write', 'process:spawn', 'net'])

export interface DiskPlugin {
  id: PluginId
  /** Absolute path of the plugin's own directory. Every file it serves must resolve inside it. */
  dir: string
  manifest: DiskPluginManifest
  /**
   * SHA-256 over the plugin's entire contents.
   *
   * What trust is pinned to. A plugin that changes on disk — an update, or something rewriting it
   * — no longer matches the grant, and is inert until the user approves it again.
   */
  hash: string
}

/** A directory that looked like a plugin and is not usable. Surfaced, never swallowed. */
export interface RejectedPlugin {
  /** The directory name, which is all we can rely on when the manifest is the broken part. */
  id: string
  dir: string
  reason: string
}

export interface Discovery {
  plugins: DiskPlugin[]
  rejected: RejectedPlugin[]
}

/**
 * Scan the plugins directory once.
 *
 * Synchronous on purpose. It runs before the first window shows and the renderer's registry cannot
 * be built without it — an async scan would mean the activity bar renders, then gains icons a
 * moment later, which looks like a glitch. The cost is one readdir plus a hash per plugin, and a
 * plugin directory that does not exist (the overwhelmingly common case) is a single failed stat.
 */
export function discoverDiskPlugins(pluginsDir: string): Discovery {
  const plugins: DiskPlugin[] = []
  const rejected: RejectedPlugin[] = []

  let entries: string[]
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    // No directory is the normal state, not an error worth reporting to anybody.
    return { plugins, rejected }
  }

  const seen = new Set<PluginId>()
  for (const name of entries) {
    const dir = join(pluginsDir, name)
    const result = readPlugin(dir, name)
    if ('reason' in result) {
      rejected.push({ id: name, dir, reason: result.reason })
      continue
    }
    // Two directories claiming one id: take neither silently. The id namespaces commands, view
    // types and events, so letting the alphabetically-first one win would mean an install could
    // shadow a plugin the user already trusts just by picking its name.
    if (seen.has(result.id)) {
      rejected.push({ id: name, dir, reason: `another directory already declares the id "${result.id}"` })
      continue
    }
    seen.add(result.id)
    plugins.push(result)
  }
  return { plugins, rejected }
}

function readPlugin(dir: string, dirName: string): DiskPlugin | { reason: string } {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch (err) {
    return { reason: `package.json is missing or not valid JSON (${message(err)})` }
  }

  const section = (raw as { rigee?: unknown } | null)?.rigee
  if (!section || typeof section !== 'object') {
    return { reason: 'package.json has no "rigee" section' }
  }
  const m = section as Record<string, unknown>

  const id = m.id
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return { reason: 'rigee.id must be lower-case letters, digits and hyphens' }
  }
  // The directory name IS the id, because the id is also the authority of every
  // `rigee-plugin://<id>/…` URL. If the two could differ, serving a file would mean a lookup from
  // id to directory, and a second plugin could claim the first one's URLs by declaring its id.
  if (id !== dirName) {
    return { reason: `rigee.id is "${id}" but the directory is named "${dirName}"` }
  }

  if (m.apiVersion !== PLUGIN_API_VERSION) {
    return {
      reason:
        `built for plugin API ${String(m.apiVersion)}, this Rigee implements ${PLUGIN_API_VERSION}`
    }
  }
  if (typeof m.version !== 'string' || typeof m.displayName !== 'string') {
    return { reason: 'rigee.version and rigee.displayName are required strings' }
  }

  const main = entryPath(dir, m.main)
  if ('reason' in main) return { reason: `rigee.main: ${main.reason}` }
  const renderer = entryPath(dir, m.renderer)
  if ('reason' in renderer) return { reason: `rigee.renderer: ${renderer.reason}` }
  if (!main.value && !renderer.value) {
    return { reason: 'declares neither a main nor a renderer entry, so it can never do anything' }
  }

  const permissions: PluginPermission[] = []
  for (const p of Array.isArray(m.permissions) ? m.permissions : []) {
    if (typeof p !== 'string' || !PERMISSIONS.has(p)) {
      return { reason: `unknown permission ${JSON.stringify(p)}` }
    }
    permissions.push(p as PluginPermission)
  }

  const contributes = checkContributions(m.contributes, id)
  if (typeof contributes === 'string') return { reason: contributes }

  const hash = hashDirectory(dir)
  if (typeof hash !== 'string') return { reason: hash.reason }

  return {
    id,
    dir,
    hash,
    manifest: {
      id,
      version: m.version,
      displayName: m.displayName,
      description: typeof m.description === 'string' ? m.description : undefined,
      permissions,
      apiVersion: PLUGIN_API_VERSION,
      ...(main.value ? { main: main.value } : {}),
      ...(renderer.value ? { renderer: renderer.value } : {}),
      contributes
    }
  }
}

/**
 * One entry point, validated for containment.
 *
 * `../../../../etc/passwd`, an absolute path and a symlink out of the directory are all the same
 * attack, and all three are caught by resolving and comparing prefixes rather than by inspecting
 * the string. Checked here as well as in the protocol handler: this is the cheap check that keeps
 * a bad plugin from being registered at all, that one is the check that cannot be bypassed.
 */
function entryPath(dir: string, value: unknown): { value: string | null } | { reason: string } {
  if (value === undefined || value === null) return { value: null }
  if (typeof value !== 'string' || value.length === 0) return { reason: 'must be a string' }

  const full = resolve(dir, value)
  if (!contains(dir, full)) return { reason: 'points outside the plugin directory' }
  try {
    if (!statSync(full).isFile()) return { reason: 'is not a file' }
  } catch {
    return { reason: `file not found (${value})` }
  }
  // Stored relative and POSIX-separated, because it becomes a URL path.
  return { value: relative(dir, full).split(sep).join('/') }
}

/**
 * Contributions, with the namespace rule enforced here rather than at bind time.
 *
 * The renderer refuses to bind a component to a view type the plugin does not own, so a violation
 * would be caught eventually — but eventually means "after the user trusted it", and the manifest
 * is read long before that. A plugin that declares `scm.diff` is trying to take over source
 * control's tab type and should never reach the list, let alone the dialog.
 */
function checkContributions(value: unknown, id: PluginId): PluginContributions | string {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object') return 'rigee.contributes must be an object'

  const c = value as Record<string, unknown>
  const prefix = viewNamespace(id)
  const out: PluginContributions = {}

  for (const [key, idField] of [
    ['editors', 'viewType'],
    ['tabs', 'viewType'],
    ['views', 'id'],
    ['statusBar', 'id'],
    ['overlays', 'id']
  ] as const) {
    const list = c[key]
    if (list === undefined) continue
    if (!Array.isArray(list)) return `rigee.contributes.${key} must be an array`
    for (const entry of list) {
      const declared = (entry as Record<string, unknown> | null)?.[idField]
      if (typeof declared !== 'string' || !declared.startsWith(prefix)) {
        return `rigee.contributes.${key}: "${String(declared)}" must start with "${prefix}"`
      }
    }
    // Shape beyond the id is the renderer's problem: it reads these defensively already, and a
    // manifest that gets a slot name wrong produces a panel nobody can open rather than a hazard.
    Object.assign(out, { [key]: list })
  }
  return out
}

/**
 * SHA-256 over every file in the directory, path included.
 *
 * Paths are hashed alongside the bytes and the walk is sorted, so the digest is stable across
 * machines and changes if a file is renamed or moved — renaming `harmless.js` over `main.js` is a
 * content change even though no bytes differ.
 */
function hashDirectory(dir: string): string | { reason: string } {
  const hash = createHash('sha256')
  let files = 0
  let bytes = 0

  const walk = (current: string): string | null => {
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch (err) {
      return `cannot read ${relative(dir, current) || '.'} (${message(err)})`
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name)
      // Symlinks are not followed and not hashed. Following one would let a plugin's contents
      // change without its hash changing, which is the one thing the hash exists to prevent.
      if (entry.isSymbolicLink()) return `contains a symbolic link (${relative(dir, full)})`
      if (entry.isDirectory()) {
        const err = walk(full)
        if (err) return err
        continue
      }
      if (!entry.isFile()) continue

      if (++files > MAX_PLUGIN_FILES) return `more than ${MAX_PLUGIN_FILES} files`
      let data: Buffer
      try {
        data = readFileSync(full)
      } catch (err) {
        return `cannot read ${relative(dir, full)} (${message(err)})`
      }
      bytes += data.length
      if (bytes > MAX_PLUGIN_BYTES) return `larger than ${MAX_PLUGIN_BYTES} bytes`
      hash.update(relative(dir, full).split(sep).join('/'))
      hash.update('\0')
      hash.update(data)
    }
    return null
  }

  const failure = walk(dir)
  return failure === null ? hash.digest('hex') : { reason: failure }
}

/** Whether `child` is `parent` or sits inside it. Both must already be resolved. */
export function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
