/**
 * Installing a plugin from GitHub, updating one, and taking one out again.
 *
 * THE ORDER IS THE DESIGN. Everything that can be checked without running the plugin is checked
 * before the user is asked anything, so the question is about a specific, verified build and not
 * about a repository name:
 *
 *   1. the latest release follows the convention (see convention.ts), and its tarball is
 *      downloaded and matched against the SHA-256 GitHub reports for it;
 *   2. it is unpacked into a staging directory — refusing links, escapes and anything oversized —
 *      and judged by exactly the rules discovery applies at launch (disk.ts), plus the three that
 *      only an install can check: the package is the repository's, and the release, the package
 *      and the manifest agree on the version;
 *   3. only then the dialog: where it came from, that nobody reviewed it, what running it means,
 *      what it says it needs. Nothing has run yet, in any process, and on Cancel nothing will;
 *   4. on yes, one rename puts it in place, and trust is granted to the hash of the copy that was
 *      described — re-checked against what the scan then finds, so the approval cannot land on
 *      different bytes from the ones the dialog was about.
 *
 * The dialog is a native one, from main, through `ask`: the renderer can neither draw a fake one
 * nor answer it, and a smoke mode answers it the way it answers every other question plugins ask.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginId, PluginPermission } from '@rigee/plugin-api/manifest'
import { manifestText, t } from '@shared/l10n'
import { permissionLabel } from '@shared/permissions'
import { compareVersions, isOwnerName, isVersion, pluginIdOfRepo } from './convention'
import { inspectPlugin, MAX_PLUGIN_BYTES, MAX_PLUGIN_FILES, type DiskPlugin } from './disk'
import { downloadRelease, latestRelease, RateLimited, type PluginRelease } from './github'
import {
  approvePlugin,
  diskPlugin,
  discoveryRules,
  rescanDiskPlugins,
  revokePlugin
} from './installed'
import { allSources, forgetSource, recordSource, sourceOf, type PluginSource } from './sources'
import { unpackTarball } from './tarball'
import { trustStateOf } from './trust'
import type { AskOptions } from './shell'
import type { PluginInstallResult } from '@shared/ipc'

export interface InstallDeps {
  pluginsDir: string
  /** On the same volume as `pluginsDir`, so moving a checked plugin into place is one rename. */
  stagingDir: string
  ask: (options: AskOptions) => Promise<number>
  /** Stop a plugin's main half. Called before its files are replaced or removed, never after. */
  stop: (id: PluginId) => Promise<void>
}


/**
 * One at a time. Two installs racing would stage, ask and rename over each other — and two dialogs
 * at once is a good way to get the wrong one answered.
 */
let busy = false

export async function installFromGitHub(
  owner: string,
  repo: string,
  deps: InstallDeps
): Promise<PluginInstallResult> {
  if (busy) return { ok: false, reason: t('Another plugin is being installed.') }
  busy = true
  let stage: string | null = null
  try {
    if (!isOwnerName(owner)) return { ok: false, reason: t('"{owner}" is not a GitHub account name', { owner }) }
    const id = pluginIdOfRepo(repo)
    if (!id) return { ok: false, reason: t('"{repo}" is not named rigee-plugin-<id>', { repo }) }
    const rules = discoveryRules()
    if (rules.reserved.has(id)) {
      return { ok: false, reason: t('"{id}" is the id of a plugin that ships with Rigee', { id }) }
    }

    // 1. The release, and its bytes.
    const release = await latestRelease(owner, repo)
    const bytes = await downloadRelease(release, MAX_PLUGIN_BYTES)

    // 2. Unpacked where nothing will find it, and judged as discovery would.
    mkdirSync(deps.stagingDir, { recursive: true })
    stage = join(deps.stagingDir, `${id}-${randomBytes(6).toString('hex')}`)
    const unpacked = join(stage, id)
    mkdirSync(unpacked, { recursive: true })
    await unpackTarball(bytes, unpacked, { maxFiles: MAX_PLUGIN_FILES, maxBytes: MAX_PLUGIN_BYTES })

    const plugin = inspectPlugin(unpacked, rules)
    if ('reason' in plugin) return { ok: false, reason: `${repo} ${release.tag}: ${plugin.reason}` }
    const problem = mismatch(unpacked, plugin, release)
    if (problem) return { ok: false, reason: `${repo} ${release.tag}: ${problem}` }

    const previous = diskPlugin(id)
    const target = join(deps.pluginsDir, id)
    if (
      previous &&
      previous.hash === plugin.hash &&
      trustStateOf(id, previous.hash, previous.manifest.permissions ?? []).status === 'trusted'
    ) {
      return {
        ok: false,
        reason: t('{name} {version} is already installed', {
          name: manifestText(plugin.manifest, plugin.manifest.displayName),
          version: release.version
        })
      }
    }

    // 3. The question.
    const answer = await deps.ask(installQuestion(release, plugin, previous, existsSync(target)))
    if (answer !== 0) return { ok: false, cancelled: true, reason: t('Cancelled.') }

    // 4. Into place: stopped, swapped, recorded, approved.
    mkdirSync(deps.pluginsDir, { recursive: true })
    const old = join(stage, 'previous')
    if (existsSync(target)) {
      await deps.stop(id)
      renameSync(target, old)
    }
    try {
      renameSync(unpacked, target)
    } catch (err) {
      // Put the old one back rather than leave the user with neither.
      if (existsSync(old) && !existsSync(target)) renameSync(old, target)
      throw err
    }

    recordSource(id, {
      kind: 'github',
      owner,
      repo,
      tag: release.tag,
      version: release.version,
      sha256: release.asset.sha256,
      installedAt: Date.now()
    } satisfies PluginSource)
    rescanDiskPlugins()
    const approved = approvePlugin(id, plugin.hash)
    if (!approved.ok) return { ok: false, reason: approved.reason ?? t('not approved') }
    return { ok: true, id, version: release.version, updated: previous !== null }
  } catch (err) {
    return { ok: false, reason: message(err) }
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true })
    busy = false
  }
}

/**
 * The checks only an install can make: is this the package the repository says it is, at the
 * version the release says it is?
 *
 * A tarball that holds some other package, or another version, is either a mistake in the
 * author's release process or a release that is not what its tag claims — and in both cases the
 * dialog would be describing something other than what gets installed.
 */
function mismatch(dir: string, plugin: DiskPlugin, release: PluginRelease): string | null {
  let pkg: { name?: unknown; version?: unknown }
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as typeof pkg
  } catch (err) {
    return t('package.json is unreadable ({reason})', { reason: message(err) })
  }
  if (pkg.name !== release.repo) {
    return t('the package inside is named {name}, not "{repo}"', { name: JSON.stringify(pkg.name) ?? 'undefined', repo: release.repo })
  }
  if (pkg.version !== release.version || plugin.manifest.version !== release.version) {
    return t('the package says version {version} (rigee.version {manifestVersion}), but the release is {tag}', {
      version: String(pkg.version),
      manifestVersion: plugin.manifest.version,
      tag: release.tag
    })
  }
  return null
}

/**
 * The dialog. WORDED TO BE TRUE rather than reassuring, in the same spirit as the trust prompt in
 * the plugins view: it says how the plugin was found, that nobody reviewed it, and what running it
 * means — and only then lists what the author says it needs, labelled as a claim.
 */
function installQuestion(
  release: PluginRelease,
  plugin: DiskPlugin,
  previous: DiskPlugin | null,
  replacing: boolean
): AskOptions {
  const displayName = shown(manifestText(plugin.manifest, plugin.manifest.displayName))
  const { version } = plugin.manifest
  const wants = plugin.manifest.permissions ?? []
  const lines = [
    t('From github.com/{owner}/{repo}, release {tag}.', { owner: release.owner, repo: release.repo, tag: release.tag }),
    '',
    t('Rigee found this plugin by searching public GitHub repositories tagged "rigee-plugin". Anyone can publish one, and Rigee has not reviewed this one, so it cannot vouch for what the plugin does.'),
    '',
    t('Once it runs, its code has the same access Rigee has: your files, your terminals and the network.')
  ]
  if (wants.length > 0) {
    lines.push(
      '',
      t('Its author says it needs to:'),
      ...wants.map((p) => `  • ${permissionLabel(p)}`),
      t('(Declared by the author. Rigee does not enforce it.)')
    )
  }
  const added = previous ? addedPermissions(previous.manifest.permissions ?? [], wants) : []
  if (added.length > 0) {
    lines.push('', t('New in this version: {permissions}.', { permissions: added.map((p) => permissionLabel(p).toLowerCase()).join(', ') }))
  }
  if (previous || replacing) {
    const from = previous ? sourceOf(previous.id) : null
    const was = previous ? { name: shown(manifestText(previous.manifest, previous.manifest.displayName)), version: previous.manifest.version } : null
    lines.push(
      '',
      was && from
        ? t('This replaces “{name}” {version} from github.com/{owner}/{repo}.', { ...was, owner: from.owner, repo: from.repo })
        : was
          ? t('This replaces “{name}” {version}, which was not installed from GitHub.', was)
          : t('This replaces the files in plugins/{id}.', { id: plugin.id })
    )
  }
  const sha = release.asset.sha256.slice(0, 16)
  lines.push(
    '',
    release.immutable
      ? t('SHA-256 of the download: {sha}… (an immutable release)', { sha })
      : t('SHA-256 of the download: {sha}…', { sha })
  )
  const updating = previous !== null
  return {
    type: 'warning',
    // Quoted, so that whatever the author named it reads as a name and not as part of the question.
    message: updating
      ? t('Update “{name}” to {version}?', { name: displayName, version })
      : t('Install “{name}” {version}?', { name: displayName, version }),
    detail: lines.join('\n'),
    buttons: [updating ? t('Update and Run') : t('Install and Run'), t('Cancel')],
    // Return cancels. Running somebody else's code should take a deliberate click.
    defaultId: 1,
    cancelId: 1
  }
}

/**
 * A name from a manifest, made fit to stand in the dialog's own sentences.
 *
 * The plugin writes its display name, and the dialog is the one place Rigee speaks for itself about
 * that plugin — so a name carrying line breaks could append "Rigee has verified this plugin" to the
 * question, in the dialog's own voice. Control characters go, whitespace runs become one space, and
 * it is cut to a length that cannot fill the box.
 */
function shown(name: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (flat.length > 60 ? `${flat.slice(0, 59)}…` : flat) || t('(unnamed)')
}

function addedPermissions(had: readonly PluginPermission[], wants: readonly PluginPermission[]): PluginPermission[] {
  const before = new Set(had)
  return wants.filter((p) => !before.has(p))
}

/**
 * Take a plugin out: stopped, approval withdrawn, files deleted.
 *
 * Renamed out of the plugins directory BEFORE the recursive delete, so a delete interrupted half
 * way cannot leave a partial plugin where the next launch would find it and report it broken.
 */
export async function uninstallPlugin(
  id: PluginId,
  deps: InstallDeps
): Promise<{ ok: boolean; reason?: string; cancelled?: boolean }> {
  const plugin = diskPlugin(id)
  const target = join(deps.pluginsDir, id)
  if (!plugin || !existsSync(target)) return { ok: false, reason: t('no plugin "{id}" is installed', { id }) }

  const answer = await deps.ask({
    type: 'question',
    message: t('Uninstall “{name}”?', { name: shown(manifestText(plugin.manifest, plugin.manifest.displayName)) }),
    detail: t('Its files are deleted from {folder}. Tabs it shows stay open and say that no plugin provides them.', { folder: target }),
    buttons: [t('Uninstall'), t('Cancel')],
    defaultId: 0,
    cancelId: 1
  })
  if (answer !== 0) return { ok: false, cancelled: true }

  await deps.stop(id)
  revokePlugin(id)
  forgetSource(id)
  mkdirSync(deps.stagingDir, { recursive: true })
  const doomed = join(deps.stagingDir, `${id}-removed-${randomBytes(6).toString('hex')}`)
  renameSync(target, doomed)
  rmSync(doomed, { recursive: true, force: true })
  rescanDiskPlugins()
  return { ok: true }
}

export interface PluginUpdate {
  id: PluginId
  /** The release that would be installed. */
  version: string
  tag: string
}

/**
 * Newer releases of the plugins that were installed from GitHub.
 *
 * One API call per such plugin, made only when asked — see github.ts on the anonymous limit. A
 * lookup that fails is reported and the rest carry on, except for the rate limit itself: once that
 * is spent every remaining call would fail the same way, so the first such error ends the check.
 */
export async function checkForUpdates(): Promise<{ updates: PluginUpdate[]; problems: string[] }> {
  const updates: PluginUpdate[] = []
  const problems: string[] = []
  for (const [id, source] of allSources()) {
    const installed = diskPlugin(id)
    if (!installed) continue
    try {
      const release = await latestRelease(source.owner, source.repo)
      const current = installed.manifest.version
      if (isVersion(current) ? compareVersions(release.version, current) > 0 : release.version !== current) {
        updates.push({ id, version: release.version, tag: release.tag })
      }
    } catch (err) {
      problems.push(`${source.owner}/${source.repo}: ${message(err)}`)
      if (err instanceof RateLimited) break
    }
  }
  return { updates, problems }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
