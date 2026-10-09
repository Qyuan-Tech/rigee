import type { Plugin } from 'cordis'
import type { PluginId } from '@rigee/plugin-api/manifest'

/**
 * Where the renderer finds each plugin's renderer half.
 *
 * Every entry is a dynamic import, so Rollup gives each plugin its own chunk and the startup
 * graph stays exactly what it is today: one script, one modulepreload. Opening a PDF fetches
 * 437 kB of pdf.js; never opening one costs zero bytes and zero milliseconds.
 *
 * Do NOT name any of these chunks in `manualChunks`. Doing so pulls them into the entry's static
 * graph and Vite emits a modulepreload for them — the documented regression that once took
 * dom-ready from 0.83 s to 14.6 s with Monaco.
 *
 * This file is in tsconfig.web.json's include and must never be in tsconfig.node.json's: the
 * modules it names are .tsx.
 */
export const RENDERER_HALVES: Readonly<Record<PluginId, () => Promise<{ default: Plugin }>>> = {
  pdf: () => import('./pdf/renderer'),
  image: () => import('./image/renderer'),
  scm: () => import('./scm/renderer'),
  browser: () => import('./browser/renderer'),
  explorer: () => import('./explorer/renderer'),
  search: () => import('./search/renderer'),
  'text-editor': () => import('./text-editor/renderer')
}
