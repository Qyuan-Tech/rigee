import type { Plugin } from 'cordis'
import type { PluginId } from '@rigee/plugin-api/manifest'

/**
 * Where main finds each plugin's main half.
 *
 * Thunks, not imports: nothing here is fetched, parsed or evaluated until the renderer calls one
 * of that plugin's commands. A plugin with no main half simply has no entry — the text editor and
 * anything else that lives entirely in the renderer.
 *
 * This file is in tsconfig.node.json's include and must never be in tsconfig.web.json's: the
 * modules it names use node:fs and friends.
 */
export const MAIN_HALVES: Readonly<Record<PluginId, () => Promise<{ default: Plugin }>>> = {
  pdf: () => import('./pdf/main'),
  image: () => import('./image/main'),
  scm: () => import('./scm/main'),
  browser: () => import('./browser/main'),
  search: () => import('./search/main'),
  explorer: () => import('./explorer/main'),
  video: () => import('./video/main')
}
