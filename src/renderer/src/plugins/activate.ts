import type { PluginId } from '@rigee/plugin-api/manifest'

/**
 * The shell's only door into the plugin runtime.
 *
 * Deliberately three lines and cordis-free. Everything the runtime needs — cordis, the services,
 * the plugin's own chunk — arrives through this one dynamic import, in exactly the shape
 * `lazy.ts` uses for Monaco and xterm, and for the same measured reason: a static import here
 * would put the framework in the entry chunk and make every plugin's existence cost startup time.
 *
 * A window that never opens a file, a PDF or the source control panel never evaluates a line of
 * it.
 */
let hostP: Promise<typeof import('./host')> | null = null

export function ensurePlugin(id: PluginId): Promise<void> {
  // Cleared on rejection, which is not a formality: a chunk load can fail once — the dev server
  // restarting under `pnpm dev`, a single bad read in a packaged app — and a cached rejection
  // would disable EVERY plugin for the rest of the session. The right rail stuck on an error
  // banner, every file opening to a notice instead of an editor, the globe button dead, and no way
  // back but relaunching. Both hosts drop a failed activation for the same reason.
  hostP ??= import('./host').catch((err: unknown) => {
    hostP = null
    throw err
  })
  return hostP.then((host) => host.activate(id))
}

/** Which plugins are running, or an empty list if the runtime was never loaded. */
export async function activatedPlugins(): Promise<PluginId[]> {
  if (!hostP) return []
  return (await hostP).activated()
}

/**
 * Stop a plugin's renderer half, if the runtime is even loaded.
 *
 * The `!hostP` short-circuit is the common case when switching something off: a plugin nobody has
 * used has nothing running, and loading the entire plugin runtime in order to stop it would be an
 * odd way to spend 28 kB.
 */
export async function deactivatePlugin(id: PluginId): Promise<void> {
  if (!hostP) return
  await (await hostP).deactivate(id)
}
