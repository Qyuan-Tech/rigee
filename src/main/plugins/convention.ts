/**
 * What a GitHub repository has to look like for Rigee to find a plugin in it and install one.
 *
 * This is a published contract, not an implementation detail: plugin authors arrange their
 * repositories to match it, so every rule here is one somebody outside this codebase depends on.
 * Change it the way you would change an API.
 *
 *   found by     the topic `rigee-plugin`. GitHub's search cannot match a prefix of a repository's
 *                name, so the topic is the only key a search can actually use.
 *   named        `rigee-plugin-<id>`. The name is what says which plugin a repository holds BEFORE
 *                anything is downloaded — and the id is the plugin's install directory and the
 *                namespace of everything it registers, so two repositories cannot both be "pdf"
 *                in one installation without the user being asked which. A repository carrying the
 *                topic but not the name is not a plugin, whatever it says about itself.
 *   installed    from its LATEST RELEASE: a tag `v<version>`, carrying the asset
 *                `rigee-plugin-<id>-<version>.tgz` — which is exactly the file `npm pack` writes,
 *                because a plugin is an ordinary npm package and installing one is an unpack.
 *
 * Pure on purpose: no Electron, no network, no disk. The self-test runs it under plain Node.
 */

import type { PluginId } from '@rigee/plugin-api/manifest'
import type { MarketPlugin } from '@shared/ipc'

export const PLUGIN_TOPIC = 'rigee-plugin'
export const REPO_PREFIX = 'rigee-plugin-'

/**
 * The organisation Rigee itself is published from. Its plugins are marked as Rigee's own.
 *
 * Not a trust decision — they go through the same download, checks and dialog as anybody's. It is
 * there so a user can tell `Qyuan-Tech/rigee-plugin-pdf` from `Qyuan-Tecch/rigee-plugin-pdf` at a
 * glance, which is the one impersonation a name-based convention invites.
 */
export const OFFICIAL_OWNER = 'Qyuan-Tech'

/** Ids are directory names and URL authorities. Keep them boring. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** A GitHub login: letters, digits and single inner hyphens, at most 39 characters. */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/

/** The id a repository's name declares, or null when the name is not a plugin's. */
export function pluginIdOfRepo(repo: string): PluginId | null {
  if (!repo.startsWith(REPO_PREFIX)) return null
  const id = repo.slice(REPO_PREFIX.length)
  return ID_PATTERN.test(id) ? id : null
}

export function isOwnerName(owner: string): boolean {
  return OWNER_PATTERN.test(owner)
}

/** semver.org's own expression, less build metadata, which a release tag has no use for. */
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/

export function isVersion(value: string): boolean {
  return VERSION.test(value)
}

/** `v1.2.0` -> `1.2.0`. Null for anything that is not `v` and a version. */
export function versionOfTag(tag: string): string | null {
  return tag.startsWith('v') && isVersion(tag.slice(1)) ? tag.slice(1) : null
}

/** The one asset a release must carry: what `npm pack` names the package's tarball. */
export function assetName(repo: string, version: string): string {
  return `${repo}-${version}.tgz`
}

/**
 * semver precedence: negative when `a` is older than `b`, zero when they are the same release.
 *
 * Written out rather than taken from a library because it is twenty lines and the cases that
 * matter are the ones Rigee's own versions exercise: its 0.0.1-alpha.N releases, where numeric
 * identifiers compare as numbers so alpha.10 is newer than alpha.9, against 1.1.0 and after; and
 * a pre-release such as `1.2.0-beta.1` against `1.2.0`, which it comes before.
 *
 * Throws on something that is not a version, rather than ordering it somewhere: a comparison that
 * quietly answered for `latest` or `1.2` would decide whether code runs on a guess.
 */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION.exec(a)
  const pb = VERSION.exec(b)
  if (!pa) throw new Error(`"${a}" is not a version`)
  if (!pb) throw new Error(`"${b}" is not a version`)

  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d !== 0) return Math.sign(d)
  }
  const ra = pa[4]
  const rb = pb[4]
  if (ra === undefined || rb === undefined) {
    // A release outranks any of its own pre-releases.
    return ra === rb ? 0 : ra === undefined ? 1 : -1
  }
  const xa = ra.split('.')
  const xb = rb.split('.')
  for (let i = 0; i < Math.min(xa.length, xb.length); i++) {
    const d = compareIdentifier(xa[i]!, xb[i]!)
    if (d !== 0) return d
  }
  return Math.sign(xa.length - xb.length)
}

function compareIdentifier(a: string, b: string): number {
  const na = /^\d+$/.test(a)
  const nb = /^\d+$/.test(b)
  if (na && nb) return Math.sign(Number(a) - Number(b))
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (na !== nb) return na ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * One item of GitHub's repository search, checked into a `MarketPlugin` — or null when it is not a
 * plugin by this convention.
 *
 * Everything is checked because everything is somebody else's data. The search already asked for
 * the topic, but the item is checked for it again: a query the user typed can carry its own
 * qualifiers, and the topic is part of the contract, not a hint.
 */
export function marketPluginOf(item: unknown): MarketPlugin | null {
  if (!item || typeof item !== 'object') return null
  const r = item as Record<string, unknown>
  const owner = (r.owner as Record<string, unknown> | null | undefined)?.login
  const repo = r.name
  if (typeof owner !== 'string' || !isOwnerName(owner)) return null
  if (typeof repo !== 'string') return null
  const id = pluginIdOfRepo(repo)
  if (!id) return null
  if (!Array.isArray(r.topics) || !r.topics.includes(PLUGIN_TOPIC)) return null
  if (r.archived === true || r.fork === true || r.private === true) return null

  const license = (r.license as Record<string, unknown> | null | undefined)?.spdx_id
  return {
    owner,
    repo,
    id,
    description: typeof r.description === 'string' ? r.description.slice(0, 500) : null,
    stars: typeof r.stargazers_count === 'number' ? r.stargazers_count : 0,
    updatedAt: typeof r.pushed_at === 'string' ? r.pushed_at : '',
    license: typeof license === 'string' && license !== 'NOASSERTION' ? license : null,
    url: `https://github.com/${owner}/${repo}`,
    official: owner.toLowerCase() === OFFICIAL_OWNER.toLowerCase()
  }
}
