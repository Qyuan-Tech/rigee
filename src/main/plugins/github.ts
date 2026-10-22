/**
 * Talking to GitHub: finding plugins, reading a plugin's latest release, and downloading it.
 *
 * UNAUTHENTICATED, on purpose. Asking every user for a token so they can browse plugins would be
 * an odd price, and a token Rigee held would be a credential worth stealing from it. The cost is
 * GitHub's anonymous limits, measured on the API itself: 10 searches a minute and 60 other calls an
 * hour, per IP address. So the design spends calls carefully — the list of every plugin costs one
 * search per hundred plugins and is fetched every six hours and kept (catalog.ts), so typing in the
 * plugins view costs nothing; installing costs one (the release; the download itself is not an API
 * call); and checking for updates costs one per plugin installed from GitHub and happens only when
 * asked. When the limit is hit anyway, the error says when it resets rather than "403".
 *
 * Through Electron's `net`, not Node's fetch: `net` is Chromium's network stack, so it uses the
 * system's proxy settings and certificate store. On a corporate network Node's fetch is the one
 * that cannot get out.
 *
 * WHAT IS VERIFIED, AND WHAT IS NOT. The download is checked against the SHA-256 GitHub itself
 * reports for the asset, so what is unpacked is byte for byte what the author uploaded — nothing
 * between here and GitHub changed it. That is ALL it proves. It says nothing about whether the
 * author is honest, and the install dialog does not pretend otherwise.
 */

import { net } from 'electron'
import { createHash } from 'node:crypto'
import { t } from '@shared/l10n'
import { assetName, marketPluginOf, PLUGIN_TOPIC, versionOfTag } from './convention'
import type { MarketPlugin } from '@shared/ipc'

/**
 * GitHub's limit for requests without an account, spent: every request fails the same way until it
 * resets, so whoever is making several stops at the first. Told apart by its class, not its words,
 * which are in whatever language Rigee is in.
 */
export class RateLimited extends Error {}

/**
 * The API's base URL. Only ever github.com — except under a smoke mode, which points it at a
 * local stand-in so the install path can be tested without the network or GitHub's rate limit.
 * Honoured ONLY there: an environment variable that could redirect where plugins are downloaded
 * from is not something a normal launch should listen to.
 */
const GITHUB_API = 'https://api.github.com'

function apiBase(): string {
  const override = process.env.RIGEE_SMOKE ? process.env.RIGEE_GITHUB_API : undefined
  return override || GITHUB_API
}

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28'
}

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  let res: Response
  try {
    res = await net.fetch(`${apiBase()}${path}`, { headers: HEADERS })
  } catch (err) {
    throw new Error(t('could not reach GitHub ({reason})', { reason: message(err) }))
  }
  if (res.status === 403 || res.status === 429) {
    // GitHub answers a spent rate limit with either status, and says so in the headers. Anything
    // else under these statuses is a real refusal and is reported as one.
    if (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')) {
      throw new RateLimited(rateLimitMessage(res.headers))
    }
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // An error page, a proxy's login screen. The status is what gets reported.
  }
  return { status: res.status, body }
}

function rateLimitMessage(headers: Headers): string {
  const reset = Number(headers.get('x-ratelimit-reset'))
  const retry = Number(headers.get('retry-after'))
  const seconds = Number.isFinite(retry) && retry > 0
    ? retry
    : Number.isFinite(reset) && reset > 0 ? Math.max(0, reset - Date.now() / 1000) : NaN
  if (!Number.isFinite(seconds)) return t("GitHub's limit for requests without an account has been reached. Try again later.")
  return seconds < 90
    ? t("GitHub's limit for requests without an account has been reached. Try again in about {n} seconds.", { n: Math.ceil(seconds) })
    : t("GitHub's limit for requests without an account has been reached. Try again in about {n} minutes.", { n: Math.ceil(seconds / 60) })
}

const githubError = (status: number, body: unknown): string => {
  const detail = (body as { message?: unknown } | null)?.message
  return typeof detail === 'string' ? t('GitHub answered {status}: {detail}', { status, detail }) : t('GitHub answered {status}', { status })
}

/** A hundred is the most GitHub returns a page; five pages is five hundred plugins, a long way off. */
const CATALOG_PAGE = 100
const CATALOG_PAGES = 5

/**
 * Every repository tagged `rigee-plugin`, most starred first: the whole catalog, which the plugins
 * view then filters by itself. One search per page, and a page short of full is the last.
 *
 * Every item is re-checked against the convention (`marketPluginOf`), so a result that does not
 * follow it is dropped rather than shown as something it is not.
 */
export async function fetchCatalog(): Promise<MarketPlugin[]> {
  const out: MarketPlugin[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= CATALOG_PAGES; page++) {
    const params = new URLSearchParams({
      q: `topic:${PLUGIN_TOPIC} archived:false`,
      sort: 'stars',
      order: 'desc',
      per_page: String(CATALOG_PAGE),
      page: String(page)
    })
    const { status, body } = await getJson(`/search/repositories?${params}`)
    if (status !== 200) throw new Error(githubError(status, body))

    const items = (body as { items?: unknown } | null)?.items
    if (!Array.isArray(items)) throw new Error(t('GitHub sent a search result Rigee cannot read'))
    for (const item of items) {
      const plugin = marketPluginOf(item)
      // Stars change between pages, so a repository can sit on two of them.
      const key = plugin && `${plugin.owner.toLowerCase()}/${plugin.repo}`
      if (!plugin || !key || seen.has(key)) continue
      seen.add(key)
      out.push(plugin)
    }
    if (items.length < CATALOG_PAGE) break
  }
  // Rigee's own first, then most starred first, which is the order GitHub sent them in.
  return out.sort((a, b) => Number(b.official) - Number(a.official))
}

/** A release that follows the convention, reduced to what installing needs. */
export interface PluginRelease {
  owner: string
  repo: string
  tag: string
  version: string
  /** The release's page, for the install dialog. */
  url: string
  /** Whether GitHub forbids changing it after publication. Shown, not required. */
  immutable: boolean
  asset: {
    name: string
    size: number
    url: string
    /** Lower-case hex SHA-256, as GitHub computed it when the asset was uploaded. */
    sha256: string
  }
}

/**
 * The latest published release, checked against the convention.
 *
 * `releases/latest` is GitHub's own answer to "the newest release that is neither a draft nor a
 * pre-release", so publishing a pre-release is how an author tests one without offering it to
 * everybody.
 */
export async function latestRelease(owner: string, repo: string): Promise<PluginRelease> {
  const { status, body } = await getJson(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`
  )
  if (status === 404) throw new Error(t('{owner}/{repo} has no published release', { owner, repo }))
  if (status !== 200) throw new Error(githubError(status, body))

  const r = body as Record<string, unknown> | null
  const tag = r?.tag_name
  if (typeof tag !== 'string') throw new Error(t('GitHub sent a release Rigee cannot read'))
  const version = versionOfTag(tag)
  if (!version) throw new Error(t('the latest release is tagged "{tag}", not v<version>', { tag }))

  const want = assetName(repo, version)
  const asset = (Array.isArray(r?.assets) ? r.assets : []).find(
    (a): a is Record<string, unknown> => (a as Record<string, unknown> | null)?.name === want
  )
  if (!asset) throw new Error(t('release {tag} has no {asset}', { tag, asset: want }))

  const size = asset.size
  const url = asset.browser_download_url
  const digest = asset.digest
  if (typeof size !== 'number' || typeof url !== 'string') {
    throw new Error(t('GitHub sent an asset Rigee cannot read ({asset})', { asset: want }))
  }
  // Downloaded from the release's own address on github.com and nowhere else: GitHub redirects that
  // to its storage, and the checksum covers what arrives, but an address elsewhere is not this
  // repository's release whatever the response says. The smoke stand-in serves its own addresses.
  const expected = `https://github.com/${owner}/${repo}/releases/download/`
  if (apiBase() === GITHUB_API && !url.toLowerCase().startsWith(expected.toLowerCase())) {
    throw new Error(t("{asset} is not offered from {owner}/{repo}'s own releases", { asset: want, owner, repo }))
  }
  // GitHub has reported a digest for every asset uploaded since June 2025. One without it was
  // uploaded before that, and there would be nothing to check the download against.
  const sha256 = typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(digest)
    ? digest.slice('sha256:'.length).toLowerCase()
    : null
  if (!sha256) throw new Error(t('GitHub reports no SHA-256 for {asset}; upload it again to get one', { asset: want }))

  return {
    owner,
    repo,
    tag,
    version,
    url: typeof r?.html_url === 'string' ? r.html_url : `https://github.com/${owner}/${repo}/releases/tag/${tag}`,
    immutable: r?.immutable === true,
    asset: { name: want, size, url, sha256 }
  }
}

/**
 * Download the release's tarball, refusing anything larger than `maxBytes` and anything whose
 * SHA-256 is not the one GitHub reported.
 *
 * Read as a stream and counted as it arrives: `size` and Content-Length are both claims, and a
 * response that keeps going past the ceiling is cut off there rather than buffered whole.
 */
export async function downloadRelease(release: PluginRelease, maxBytes: number): Promise<Buffer> {
  const { asset } = release
  const tooLarge = (): Error => new Error(t('{asset} is larger than {max} bytes', { asset: asset.name, max: maxBytes }))
  if (asset.size > maxBytes) throw tooLarge()

  let res: Response
  try {
    res = await net.fetch(asset.url)
  } catch (err) {
    throw new Error(t('could not download {asset} ({reason})', { asset: asset.name, reason: message(err) }))
  }
  if (!res.ok || !res.body) throw new Error(t('downloading {asset}: HTTP {status}', { asset: asset.name, status: res.status }))

  const hash = createHash('sha256')
  const chunks: Buffer[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw tooLarge()
    }
    hash.update(value)
    chunks.push(Buffer.from(value))
  }
  const got = hash.digest('hex')
  if (got !== asset.sha256) {
    throw new Error(t('{asset} does not match the checksum GitHub reports for it', { asset: asset.name }))
  }
  return Buffer.concat(chunks, total)
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
