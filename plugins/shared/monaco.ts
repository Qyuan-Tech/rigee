/**
 * Monaco, loaded once and themed once, for whichever plugins need it.
 *
 * Three do: the text editor, the source control diff, and the Markdown preview, which borrows its
 * tokenizers to colour code blocks. They live in different folders and load in different chunks,
 * so the loader has to sit somewhere they can all reach — `plugins/shared/` is that place, and it
 * is not a plugin. Nothing here may be imported by the shell.
 *
 * MONACO MUST NEVER BE A TOP-LEVEL IMPORT. Measured on this project's stack: eager imports cost
 * +1230 ms to first paint, a 4,481 kB entry chunk and 58 MB of renderer output. The `await
 * import()` below is what keeps a 3.96 MB chunk out of startup; Rollup gives it to both plugins as
 * one shared chunk, so nothing is duplicated by there being two callers.
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

export const MONACO_THEME = 'rigee-dark'

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
      { token: 'comment', foreground: '7c8499', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c49bfb' },
      { token: 'string', foreground: '96dcab' },
      { token: 'number', foreground: 'e3bb5e' },
      { token: 'type', foreground: '4dd8ef' },
      { token: 'function', foreground: '8b9aff' },
      { token: 'variable', foreground: 'c6ccdb' }
    ],
    colors: {
      'editor.background': '#20232e',
      'editor.foreground': '#c6ccdb',
      'editorLineNumber.foreground': '#6b7287',
      'editorLineNumber.activeForeground': '#8b9aff',
      'editor.lineHighlightBackground': '#282c3966',
      'editor.selectionBackground': '#8b9aff4d',
      'editor.inactiveSelectionBackground': '#8b9aff1f',
      'editorCursor.foreground': '#8b9aff',
      'editorIndentGuide.background1': '#2b2f3d',
      'editorIndentGuide.activeBackground1': '#3a3f52',
      'editorWidget.background': '#1d1f29',
      'editorWidget.border': '#3a3f52',
      'editorGutter.background': '#20232e',
      'editorGutter.addedBackground': '#7fce97',
      'editorGutter.modifiedBackground': '#e3bb5e',
      'editorGutter.deletedBackground': '#e8848c',
      'diffEditor.insertedTextBackground': '#7fce971f',
      'diffEditor.removedTextBackground': '#e8848c1f',
      'diffEditor.border': '#2b2f3d',
      'scrollbarSlider.background': '#ffffff12',
      'scrollbarSlider.hoverBackground': '#ffffff22',
      'scrollbarSlider.activeBackground': '#ffffff2e',
      'minimap.background': '#1d1f29',
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
