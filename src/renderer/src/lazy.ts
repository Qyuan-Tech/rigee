/**
 * Monaco and xterm must never be top-level imports.
 *
 * Measured on this project's stack: eager imports cost +1230 ms to first paint, a 4,481 kB main
 * chunk and 58 MB of renderer output. Loading them when the first editor or terminal tab opens
 * costs nothing the user notices.
 */

let monacoP: Promise<typeof import('monaco-editor')> | null = null

export function loadMonaco(): Promise<typeof import('monaco-editor')> {
  monacoP ??= (async () => {
    const monaco = await import('monaco-editor')
    await configureMonacoWorkers()
    return monaco
  })()
  return monacoP
}

/**
 * Point Monaco at locally bundled workers. Without this it tries to fetch them from a CDN, which
 * fails outright under our CSP and offline.
 */
async function configureMonacoWorkers(): Promise<void> {
  // monaco-editor 0.56 ships an exports map ("./*" -> "./esm/vs/*.js"), so the specifier must NOT
  // repeat the esm/vs prefix and must keep the .js extension. The vs/language/* files are thin
  // compat shims over vs/languages/features/*; either resolves, the shim path is the stable one.
  const [editorWorker, jsonWorker, cssWorker, htmlWorker, tsWorker] = await Promise.all([
    import('monaco-editor/editor/editor.worker.js?worker'),
    import('monaco-editor/language/json/json.worker.js?worker'),
    import('monaco-editor/language/css/css.worker.js?worker'),
    import('monaco-editor/language/html/html.worker.js?worker'),
    import('monaco-editor/language/typescript/ts.worker.js?worker')
  ])

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case 'json':
          return new jsonWorker.default()
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker.default()
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker.default()
        case 'typescript':
        case 'javascript':
          return new tsWorker.default()
        default:
          return new editorWorker.default()
      }
    }
  }
}

export interface XtermBundle {
  Terminal: typeof import('@xterm/xterm').Terminal
  FitAddon: typeof import('@xterm/addon-fit').FitAddon
  WebglAddon: typeof import('@xterm/addon-webgl').WebglAddon
  SearchAddon: typeof import('@xterm/addon-search').SearchAddon
}

let xtermP: Promise<XtermBundle> | null = null

export function loadXterm(): Promise<XtermBundle> {
  xtermP ??= Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-webgl'),
    import('@xterm/addon-search')
  ]).then(([core, fit, webgl, search]) => ({
    Terminal: core.Terminal,
    FitAddon: fit.FitAddon,
    WebglAddon: webgl.WebglAddon,
    SearchAddon: search.SearchAddon
  }))
  return xtermP
}
