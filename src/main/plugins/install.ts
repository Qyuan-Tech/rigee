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
import { PERMISSION_LABELS, type PluginId, type PluginPermission } from '@rigee/plugin-api/manifest'
import { compareVersions, isOwnerName, isVersion, pluginIdOfRepo } from './convention'
import { inspectPlugin, MAX_PLUGIN_BYTES, MAX_PLUGIN_FILES, type DiskPlugin } from './disk'
import { downloadRelease, latestRelease, type PluginRelease } from './github'
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
  if (busy) return { ok: false, reason: 'Another plugin is being installed.' }
  busy = true
  let stage: string | null = null
  try {
    if (!isOwnerName(owner)) return { ok: false, reason: `"${owner}" is not a GitHub account name` }
    const id = pluginIdOfRepo(repo)
    if (!id) return { ok: false, reason: `"${repo}" is not named rigee-plugin-<id>` }
    const rules = discoveryRules()
    if (rules.reserved.has(id)) {
      return { ok: false, reason: `"${id}" is the id of a plugin that ships with Rigee` }
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
      return { ok: false, reason: `${plugin.manifest.displayName} ${release.version} is already installed` }
    }

    // 3. The question.
    const answer = await deps.ask(installQuestion(release, plugin, previous, existsSync(target)))
    if (answer !== 0) return { ok: false, cancelled: true, reason: 'Cancelled.' }

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
    if (!approved.ok) return { ok: false, reason: approved.reason ?? 'not approved' }
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
    return `package.json is unreadable (${message(err)})`
  }
  if (pkg.name !== release.repo) {
    return `the package inside is named ${JSON.stringify(pkg.name)}, not "${release.repo}"`
  }
  if (pkg.version !== release.version || plugin.manifest.version !== release.version) {
    return `the package says version ${String(pkg.version)} (rigee.version ${plugin.manifest.version}), ` +
      `but the release is ${release.tag}`
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
  const { displayName, version } = plugin.manifest
  const wants = plugin.manifest.permissions ?? []
  const lines = [
    `From github.com/${release.owner}/${release.repo}, release ${release.tag}.`,
    '',
    'Rigee found this plugin by searching public GitHub repositories tagged "rigee-plugin". ' +
      'Anyone can publish one, and Rigee has not reviewed this one, so it cannot vouch for what ' +
      'the plugin does.',
    '',
    'Once it runs, its code has the same access Rigee has: your files, your terminals and the network.'
  ]
  if (wants.length > 0) {
    lines.push('', 'Its author says it needs to:', ...wants.map((p) => `  • ${PERMISSION_LABELS[p]}`), '(Declared by the author. Rigee does not enforce it.)')
  }
  const added = previous ? addedPermissions(previous.manifest.permissions ?? [], wants) : []
  if (added.length > 0) {
    lines.push('', `New in this version: ${added.map((p) => PERMISSION_LABELS[p].toLowerCase()).join(', ')}.`)
  }
  if (previous || replacing) {
    const was = previous ? `${previous.manifest.displayName} ${previous.manifest.version}` : `the files in plugins/${plugin.id}`
    const from = previous ? sourceOf(previous.id) : null
    const where = from ? ` from github.com/${from.owner}/${from.repo}` : previous ? ', which was not installed from GitHub' : ''
    lines.push('', `This replaces ${was}${where}.`)
  }
  lines.push(
    '',
    `SHA-256 of the download: ${release.asset.sha256.slice(0, 16)}…${release.immutable ? ' (an immutable release)' : ''}`
  )
  const updating = previous !== null
  return {
    type: 'warning',
    message: updating ? `Update ${displayName} to ${version}?` : `Install ${displayName} ${version}?`,
    detail: lines.join('\n'),
    buttons: [updating ? 'Update and Run' : 'Install and Run', 'Cancel'],
    // Return cancels. Running somebody else's code should take a deliberate click.
    defaultId: 1,
    cancelId: 1
  }
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
  if (!plugin || !existsSync(target)) return { ok: false, reason: `no plugin "${id}" is installed` }

  const answer = await deps.ask({
    type: 'question',
    message: `Uninstall ${plugin.manifest.displayName}?`,
    detail: `Its files are deleted from ${target}. Tabs it shows stay open and say that no plugin provides them.`,
    buttons: ['Uninstall', 'Cancel'],
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
      if (/limit/i.test(message(err))) break
    }
  }
  return { updates, problems }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
