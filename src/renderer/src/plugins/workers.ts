/**
 * `workerUrl`, for plugins: a Web Worker that starts in the shell's origin and runs the plugin's
 * script.
 *
 * A window may only start a worker from its own origin. The shell's is `file://` (packaged) or the
 * dev server's, and a plugin's files are served from `rigee-plugin://`, so a plugin from disk
 * cannot start one directly — the constructor throws a SecurityError. The shell therefore ships one
 * script of its own, `plugin-runtime/worker.js`, whose whole job is to `import()` the plugin's
 * script named in its query string. That import is cross-origin, which CORS permits: the plugin
 * protocol answers with `Access-Control-Allow-Origin` (see src/main/plugins/installed.ts).
 *
 * A side effect worth having: a worker started from a file:// URL gets no Content Security Policy
 * of its own, so a plugin's worker may compile WebAssembly, which the window's policy forbids.
 * pdf.js decodes JPEG 2000 and JBIG2 images that way.
 *
 * The bootstrap's address differs between `pnpm dev` and a build, and is written into this module
 * at build time by `pluginRuntime()` in electron.vite.config.ts, beside the shims it sits with.
 */

declare const __RIGEE_PLUGIN_WORKER__: string

export function workerUrl(script: string | URL): string {
  const target = new URL(String(script))
  // Only a plugin's own files. The bootstrap would import anything it was given, and a worker
  // with no CSP fetching code from the network is not something to hand out.
  if (target.protocol !== 'rigee-plugin:') {
    throw new Error(`workerUrl: ${target.href} is not one of a plugin's own files`)
  }
  const boot = new URL(__RIGEE_PLUGIN_WORKER__, document.baseURI)
  boot.searchParams.set('src', target.href)
  return boot.href
}
