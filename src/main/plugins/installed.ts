/**
 * The disk plugins, as the rest of the app sees them: a list, a trust decision, and a way in.
 *
 * Three consumers, and they must agree exactly, because a disagreement between any two of them is
 * a security hole rather than a bug:
 *
 *   the plugin host   imports a trusted plugin's main half
 *   the protocol      serves a trusted plugin's renderer half to the window
 *   the plugins view  lists everything and asks the user about what is not trusted yet
 *
 * So the check lives in one function, `servable`, and all three call it.
 *
 * THE SCAN IS TAKEN ONCE, at boot, and held. Re-reading the directory per request would mean the
 * bytes served are not necessarily the bytes hashed — a plugin could pass the trust check and then
 * swap its files before the renderer fetched them. One snapshot, one hash, one decision.
 */

import { protocol, net, type CustomScheme } from 'electron'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { contains, discoverDiskPlugins, type DiskPlugin, type RejectedPlugin } from './disk'
import { grantTrust, revokeTrust, trustStateOf, type TrustState } from './trust'
import type { MainPluginLoader } from './host'
import type { PluginId, PluginManifest, PluginPermission } from '@rigee/plugin-api/manifest'

export const PLUGIN_SCHEME = 'rigee-plugin'

/**
 * The scheme's declaration, for the one `registerSchemesAsPrivileged` call Electron allows — made
 * in src/main/index.ts before `app.whenReady()`, together with the media scheme's.
 *
 * Every privilege here is load-bearing and was added because its absence broke something:
 *
 *   standard          makes `rigee-plugin://hello/dist/renderer.js` parse with an authority and a
 *                     path rather than as an opaque URL, which is what a relative import inside
 *                     the plugin's own bundle needs in order to resolve.
 *   secure            puts it in a secure context. Without it the renderer refuses to import from
 *                     it at all.
 *   supportFetchAPI   a dynamic `import()` fetches, and this is what makes fetch accept the scheme.
 *   corsEnabled       the packaged renderer is a `file://` document, so ANY other scheme is cross
 *                     origin. Without this Chromium rejects the import before the handler is ever
 *                     called: "Cross origin requests are only supported for protocol schemes:
 *                     chrome, chrome-extension, …, http, https". With it the scheme joins that
 *                     list and the handler's `Access-Control-Allow-Origin` is honoured.
 */
export const pluginScheme: CustomScheme = {
  scheme: PLUGIN_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}

export interface InstalledPlugin {
  manifest: PluginManifest
  trust: TrustState
  /** What it declares it needs. See PluginPermission: a declaration, not a capability. */
  permissions: PluginPermission[]
  version: string
}

let snapshot: { plugins: DiskPlugin[]; rejected: RejectedPlugin[] } = { plugins: [], rejected: [] }
let byId = new Map<PluginId, DiskPlugin>()

/** Take the one scan. Returns what was found, including what was refused and why. */
export function scanDiskPlugins(pluginsDir: string): { found: number; rejected: RejectedPlugin[] } {
  snapshot = discoverDiskPlugins(pluginsDir)
  byId = new Map(snapshot.plugins.map((p) => [p.id, p]))
  for (const r of snapshot.rejected) {
    console.warn(`[plugins] ignoring ${r.dir}: ${r.reason}`)
  }
  return { found: snapshot.plugins.length, rejected: snapshot.rejected }
}

/**
 * The disk plugins and their trust state. Drives the plugins view.
 *
 * Untrusted ones are INCLUDED, manifest and all. Their contributions have to be visible for the
 * view to say "this adds a panel called X" before the user decides, and the renderer filters them
 * out of every live lookup exactly as it does a disabled plugin. A manifest is inert data; it is
 * the halves that are withheld.
 *
 * DISK ONLY, and the bundled ones are deliberately not here. Partly because there is nothing to
 * say about them — they ship with the app, so "trusted" is not a decision anybody made — and
 * partly because they cannot cross the bridge: a manifest may hold a `match` PREDICATE for its
 * file selector (the text editor claims everything with one), and contextBridge answers a function
 * with "An object could not be cloned", which arrives as a rejected IPC call naming no cause at
 * all. The renderer already has those manifests statically; it composes the two lists itself.
 */
export function installedPlugins(): InstalledPlugin[] {
  return snapshot.plugins.map((p) => ({
    manifest: p.manifest,
    trust: trustStateOf(p.id, p.hash, p.manifest.permissions ?? []),
    permissions: [...(p.manifest.permissions ?? [])],
    version: p.manifest.version
  }))
}

/**
 * The one check. A plugin's code may be read only if it is installed AND trusted as it stands.
 *
 * Returns the record rather than a boolean so callers cannot accidentally use a plugin they did
 * not check — there is no way to reach `dir` without going through here.
 */
function servable(id: PluginId): DiskPlugin | null {
  const plugin = byId.get(id)
  if (!plugin) return null
  return trustStateOf(id, plugin.hash, plugin.manifest.permissions ?? []).status === 'trusted'
    ? plugin
    : null
}

/**
 * Main-half loaders for the trusted disk plugins, in the shape the host already takes.
 *
 * Built fresh on each call rather than cached, so approving a plugin makes it loadable without a
 * restart, and revoking one stops it being loadable again.
 */
export function diskLoaders(): Record<PluginId, MainPluginLoader> {
  const out: Record<PluginId, MainPluginLoader> = {}
  for (const p of snapshot.plugins) {
    const entry = p.manifest.main
    if (!entry) continue
    out[p.id] = async () => {
      // Re-checked at load time, not at registry-build time: trust can be revoked between the two,
      // and the revoke has to mean the code does not run rather than "does not run next launch".
      const live = servable(p.id)
      if (!live) throw new Error(`plugin "${p.id}" is not trusted, refusing to load its main half`)
      const url = pathToFileURL(join(live.dir, entry)).href
      return (await import(/* @vite-ignore */ url)) as { default: import('cordis').Plugin }
    }
  }
  return out
}

/** Approve one exact build, after the user has read what it asks for. */
export function approvePlugin(id: PluginId): { ok: boolean; reason?: string } {
  const plugin = byId.get(id)
  if (!plugin) return { ok: false, reason: `no plugin "${id}" is installed` }
  grantTrust(id, plugin.hash, plugin.manifest.permissions ?? [], plugin.manifest.version)
  return { ok: true }
}

export function revokePlugin(id: PluginId): void {
  revokeTrust(id)
}

// ---------------------------------------------------------------------------
// Serving a plugin's renderer half to the window
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
}

/**
 * `rigee-plugin://<id>/<path>` -> a file inside that plugin's directory.
 *
 * Called once after app ready. Three refusals, in this order, and the order is the point: an
 * unknown or untrusted id is rejected before any path is resolved, so a traversal attempt cannot
 * even be used to probe for which directories exist.
 *
 * Containment is checked on the RESOLVED path, after decoding. The URL is decoded before it is
 * joined — it has to be, paths may be percent-encoded — so `%2e%2e%2f%2e%2e%2f` would otherwise
 * walk straight out of the plugin directory and hand any file on disk to whatever can reach this
 * scheme, which under this app includes a page open in a browser tab.
 */
export function registerPluginProtocol(): void {
  protocol.handle(PLUGIN_SCHEME, (request) => {
    const url = new URL(request.url)
    const plugin = servable(url.hostname)
    if (!plugin) return new Response('not found', { status: 404 })

    let rel: string
    try {
      rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    } catch {
      return new Response('bad request', { status: 400 })
    }
    const file = resolve(plugin.dir, rel)
    if (!contains(plugin.dir, file)) return new Response('forbidden', { status: 403 })

    return net
      .fetch(pathToFileURL(file).href)
      .then(
        (res) =>
          new Response(res.body, {
            status: res.status,
            headers: {
              'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
              // The renderer is a `file://` document, whose origin serialises to "null", so there
              // is no useful origin to name and `*` is the only value that works. It is not a
              // loosening: reaching this handler at all requires the scheme, which only this
              // application's own windows can address, and the trust check has already run above.
              'Access-Control-Allow-Origin': '*',
              // A plugin's files are immutable for as long as its hash is: changing them revokes
              // trust, which forces the user through approval again anyway.
              'Cache-Control': 'no-cache'
            }
          })
      )
      .catch(() => new Response('not found', { status: 404 }))
  })
}

/** The URL the renderer imports a trusted plugin's renderer half from, or null. */
export function rendererEntryUrl(id: PluginId): string | null {
  const plugin = servable(id)
  const entry = plugin?.manifest.renderer
  return plugin && entry ? `${PLUGIN_SCHEME}://${id}/${entry}` : null
}
