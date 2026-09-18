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
    defineTheme(monaco)
    return monaco
  })()
  return monacoP
}

export const MONACO_THEME = 'onestop-dark'

/**
 * Monaco's built-in vs-dark paints #1e1e1e, which sits visibly lighter than the panes around it.
 * Nothing makes an editor look unfinished faster than three surfaces disagreeing about their
 * background, so the editor is given the app's own tokens rather than the other way round.
 */
function defineTheme(monaco: typeof import('monaco-editor')): void {
  monaco.editor.defineTheme(MONACO_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '5a6272', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c084fc' },
      { token: 'string', foreground: '8fd6a0' },
      { token: 'number', foreground: 'e2b344' },
      { token: 'type', foreground: '22d3ee' },
      { token: 'function', foreground: '7c8cff' },
      { token: 'variable', foreground: 'c8cfdd' }
    ],
    colors: {
      'editor.background': '#0e1118',
      'editor.foreground': '#c8cfdd',
      'editorLineNumber.foreground': '#3c4354',
      'editorLineNumber.activeForeground': '#7c8cff',
      'editor.lineHighlightBackground': '#151a2480',
      'editor.selectionBackground': '#7c8cff33',
      'editor.inactiveSelectionBackground': '#7c8cff1f',
      'editorCursor.foreground': '#7c8cff',
      'editorIndentGuide.background1': '#1a1f2b',
      'editorIndentGuide.activeBackground1': '#252c3a',
      'editorWidget.background': '#0b0e15',
      'editorWidget.border': '#252c3a',
      'editorGutter.background': '#0e1118',
      'editorGutter.addedBackground': '#6dc48a',
      'editorGutter.modifiedBackground': '#e2b344',
      'editorGutter.deletedBackground': '#e06c75',
      'diffEditor.insertedTextBackground': '#6dc48a1f',
      'diffEditor.removedTextBackground': '#e06c751f',
      'diffEditor.border': '#1a1f2b',
      'scrollbarSlider.background': '#ffffff12',
      'scrollbarSlider.hoverBackground': '#ffffff22',
      'scrollbarSlider.activeBackground': '#ffffff2e',
      'minimap.background': '#0b0e15',
      'editorOverviewRuler.border': '#00000000'
    }
  })
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
