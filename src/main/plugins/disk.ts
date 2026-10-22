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
import { basename, join, relative, resolve, sep } from 'node:path'
import {
  PLUGIN_API_VERSION,
  viewNamespace,
  type DiskPluginManifest,
  type PluginContributions,
  type PluginId,
  type PluginPermission
} from '@rigee/plugin-api/manifest'
import type { Translations } from '@rigee/plugin-api/l10n'
import { t } from '@shared/l10n'
import { compareVersions, ID_PATTERN, isVersion } from './convention'

/**
 * Ceiling on what will be hashed for one plugin.
 *
 * The hash is what pins trust to the exact bytes the user approved, so it has to cover every file
 * — but "every file" is attacker-controlled, and a plugin directory containing a 4 GB file would
 * otherwise stall the boot path reading it. Past the ceiling the plugin is rejected rather than
 * partially hashed: a hash over some of the files would be a trust decision about code nobody
 * looked at.
 */
export const MAX_PLUGIN_BYTES = 64 * 1024 * 1024
export const MAX_PLUGIN_FILES = 5000

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

/** What the running app contributes to the decision, beyond the plugin's own files. */
export interface DiscoveryRules {
  /**
   * Ids no plugin on disk may take: the bundled plugins', and the shell's own.
   *
   * The id namespaces commands, view types, events and persisted state, so a plugin on disk that
   * declared `scm` would not sit beside source control — it would BE source control, as far as
   * the registry could tell, and merely being installed untrusted would switch the real one off.
   */
  reserved: ReadonlySet<PluginId>
  /** This build's version, for `minAppVersion`. */
  appVersion: string
}

/**
 * Scan the plugins directory once.
 *
 * Synchronous on purpose. It runs before the first window shows and the renderer's registry cannot
 * be built without it — an async scan would mean the activity bar renders, then gains icons a
 * moment later, which looks like a glitch. The cost is one readdir plus a hash per plugin, and a
 * plugin directory that does not exist (the overwhelmingly common case) is a single failed stat.
 */
export function discoverDiskPlugins(pluginsDir: string, rules: DiscoveryRules): Discovery {
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
    const result = readPlugin(dir, name, rules)
    if ('reason' in result) {
      rejected.push({ id: name, dir, reason: result.reason })
      continue
    }
    // Two directories claiming one id: take neither silently. The id namespaces commands, view
    // types and events, so letting the alphabetically-first one win would mean an install could
    // shadow a plugin the user already trusts just by picking its name.
    if (seen.has(result.id)) {
      rejected.push({ id: name, dir, reason: t('another directory already declares the id "{id}"', { id: result.id }) })
      continue
    }
    seen.add(result.id)
    plugins.push(result)
  }
  return { plugins, rejected }
}

/**
 * One directory, judged exactly as discovery would judge it, for a plugin that is not installed
 * yet: an install unpacks into a staging directory named after the id, and nothing is moved into
 * place unless this accepts it.
 */
export function inspectPlugin(dir: string, rules: DiscoveryRules): DiskPlugin | { reason: string } {
  return readPlugin(dir, basename(dir), rules)
}

function readPlugin(dir: string, dirName: string, rules: DiscoveryRules): DiskPlugin | { reason: string } {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch (err) {
    return { reason: t('package.json is missing or not valid JSON ({reason})', { reason: message(err) }) }
  }

  const section = (raw as { rigee?: unknown } | null)?.rigee
  if (!section || typeof section !== 'object') {
    return { reason: t('package.json has no "rigee" section') }
  }
  const m = section as Record<string, unknown>

  const id = m.id
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return { reason: t('rigee.id must be lower-case letters, digits and hyphens') }
  }
  // The directory name IS the id, because the id is also the authority of every
  // `rigee-plugin://<id>/…` URL. If the two could differ, serving a file would mean a lookup from
  // id to directory, and a second plugin could claim the first one's URLs by declaring its id.
  if (id !== dirName) {
    return { reason: t('rigee.id is "{id}" but the directory is named "{dir}"', { id, dir: dirName }) }
  }
  if (rules.reserved.has(id)) {
    return { reason: t('the id "{id}" belongs to a plugin that ships with Rigee', { id }) }
  }

  if (m.apiVersion !== PLUGIN_API_VERSION) {
    return {
      reason: t('built for plugin API {theirs}, this Rigee implements {ours}', {
        theirs: String(m.apiVersion),
        ours: PLUGIN_API_VERSION
      })
    }
  }
  if (typeof m.version !== 'string' || typeof m.displayName !== 'string') {
    return { reason: t('rigee.version and rigee.displayName are required strings') }
  }
  let minAppVersion: string | undefined
  if (m.minAppVersion !== undefined) {
    if (typeof m.minAppVersion !== 'string' || !isVersion(m.minAppVersion)) {
      return { reason: t('rigee.minAppVersion must be a version such as 1.1.0') }
    }
    // A build whose own version is not one (a hand-edited package.json) cannot say it is new
    // enough, and is not asked: refusing every plugin on that account would be the worse failure.
    if (isVersion(rules.appVersion) && compareVersions(rules.appVersion, m.minAppVersion) < 0) {
      return { reason: t('needs Rigee {needs} or later; this is {this}', { needs: m.minAppVersion, this: rules.appVersion }) }
    }
    minAppVersion = m.minAppVersion
  }

  const main = entryPath(dir, m.main)
  if ('reason' in main) return { reason: `rigee.main: ${main.reason}` }
  const renderer = entryPath(dir, m.renderer)
  if ('reason' in renderer) return { reason: `rigee.renderer: ${renderer.reason}` }
  if (!main.value && !renderer.value) {
    return { reason: t('declares neither a main nor a renderer entry, so it can never do anything') }
  }

  const permissions: PluginPermission[] = []
  for (const p of Array.isArray(m.permissions) ? m.permissions : []) {
    if (typeof p !== 'string' || !PERMISSIONS.has(p)) {
      return { reason: t('unknown permission {permission}', { permission: JSON.stringify(p) ?? String(p) }) }
    }
    permissions.push(p as PluginPermission)
  }

  const contributes = checkContributions(m.contributes, id)
  if (typeof contributes === 'string') return { reason: contributes }

  const l10n = checkTranslations(m.l10n)
  if (typeof l10n === 'string') return { reason: l10n }

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
      ...(minAppVersion ? { minAppVersion } : {}),
      ...(main.value ? { main: main.value } : {}),
      ...(renderer.value ? { renderer: renderer.value } : {}),
      contributes,
      ...(l10n ? { l10n } : {})
    }
  }
}

/** Ceilings on a manifest's translations: they are read at boot and sent to the window whole. */
const MAX_LANGUAGES = 32
const MAX_TRANSLATED = 256
const MAX_WORDS = 1024

/**
 * The manifest's own translations, checked as everything else in it is: languages by tag, each a
 * table of strings — the words of a manifest, so a few dozen at most, and bounded well above that.
 *
 * Built with `Object.fromEntries`, which DEFINES each key: a table assembled by assignment would
 * take a key called `__proto__` as an instruction rather than as a string to translate.
 */
function checkTranslations(value: unknown): Translations | null | string {
  if (value === undefined || value === null) return null
  const invalid = t('rigee.l10n must map languages to tables of strings')
  if (typeof value !== 'object' || Array.isArray(value)) return invalid
  const languages = Object.entries(value)
  if (languages.length > MAX_LANGUAGES) return invalid
  const out: [string, Record<string, string>][] = []
  for (const [locale, table] of languages) {
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)) return invalid
    if (!table || typeof table !== 'object' || Array.isArray(table)) return invalid
    const entries = Object.entries(table)
    if (entries.length > MAX_TRANSLATED) return invalid
    for (const [words, translated] of entries) {
      if (typeof translated !== 'string' || words.length > MAX_WORDS || translated.length > MAX_WORDS) return invalid
    }
    out.push([locale, Object.fromEntries(entries) as Record<string, string>])
  }
  return Object.fromEntries(out)
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
  if (typeof value !== 'string' || value.length === 0) return { reason: t('must be a string') }

  const full = resolve(dir, value)
  if (!contains(dir, full)) return { reason: t('points outside the plugin directory') }
  try {
    if (!statSync(full).isFile()) return { reason: t('is not a file') }
  } catch {
    return { reason: t('file not found ({file})', { file: value }) }
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
  if (typeof value !== 'object') return t('rigee.contributes must be an object')

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
    if (!Array.isArray(list)) return t('rigee.contributes.{key} must be an array', { key })
    for (const entry of list) {
      const declared = (entry as Record<string, unknown> | null)?.[idField]
      if (typeof declared !== 'string' || !declared.startsWith(prefix)) {
        return t('rigee.contributes.{key}: "{id}" must start with "{prefix}"', { key, id: String(declared), prefix })
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
      return t('cannot read {file} ({reason})', { file: relative(dir, current) || '.', reason: message(err) })
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name)
      // Symlinks are not followed and not hashed. Following one would let a plugin's contents
      // change without its hash changing, which is the one thing the hash exists to prevent.
      if (entry.isSymbolicLink()) return t('contains a symbolic link ({file})', { file: relative(dir, full) })
      if (entry.isDirectory()) {
        const err = walk(full)
        if (err) return err
        continue
      }
      if (!entry.isFile()) continue

      if (++files > MAX_PLUGIN_FILES) return t('more than {n} files', { n: MAX_PLUGIN_FILES })
      let data: Buffer
      try {
        data = readFileSync(full)
      } catch (err) {
        return t('cannot read {file} ({reason})', { file: relative(dir, full), reason: message(err) })
      }
      bytes += data.length
      if (bytes > MAX_PLUGIN_BYTES) return t('larger than {n} bytes', { n: MAX_PLUGIN_BYTES })
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
