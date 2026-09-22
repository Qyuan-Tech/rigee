import type { PluginManifest } from '@shared/plugin'
import { manifest as browser } from './browser/manifest'
import { manifest as pdf } from './pdf/manifest'
import { manifest as scm } from './scm/manifest'
import { manifest as textEditor } from './text-editor/manifest'

/**
 * Every plugin the app ships with.
 *
 * This barrel is the ONLY plugin code both realms load eagerly, and it must stay that way: it is
 * plain data, it imports no implementation, and it costs roughly a kilobyte in each bundle. The
 * halves are reached through `registry.main.ts` and `registry.renderer.ts`, which hold the
 * dynamic-import thunks — one per realm, because TypeScript pulls the target of a literal
 * `import()` into the program and a shared file would drag node:fs into the web project and JSX
 * into the node project.
 *
 * Order is the tie-break for equal-priority editor contributions, so it is meaningful: the text
 * editor is last because it is the fallback.
 */
export const PLUGIN_MANIFESTS: readonly PluginManifest[] = [pdf, scm, browser, textEditor]
