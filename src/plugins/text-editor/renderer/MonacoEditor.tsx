import { useEffect, useRef, useState } from 'react'
import { editorFontSize, monoFamily } from '@renderer/fonts'
import { rpc } from '@renderer/ipc'
import { Notice } from '@renderer/plugins/api'
import { loadMonaco, MONACO_THEME } from '@plugins/shared/monaco'
import type { PluginEditorProps } from '@renderer/plugins/bindings'
import type * as Monaco from 'monaco-editor'

/**
 * Monaco lives entirely outside React state: models and editor instances are imperative,
 * long-lived and expensive, and putting them in the store would re-render the world on every
 * keystroke. React owns the container div and nothing else.
 *
 * View state (cursor, scroll, folds) is saved per path so reopening a tab lands where you left.
 */
const viewStates = new Map<string, Monaco.editor.ICodeEditorViewState | null>()

export function MonacoEditor({ filePath, readOnly }: PluginEditorProps): React.ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [tooLarge, setTooLarge] = useState(false)

  useEffect(() => {
    let disposed = false
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null
    let model: Monaco.editor.ITextModel | null = null

    void (async () => {
      try {
        const [monaco, file] = await Promise.all([loadMonaco(), rpc['fs:readFile'](filePath)])
        if (disposed || !host.current) return
        if (file.tooLarge) { setTooLarge(true); return }

        const uri = monaco.Uri.file(filePath)
        model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(file.content, undefined, uri)

        editor = monaco.editor.create(host.current, {
          model,
          theme: MONACO_THEME,
          readOnly,
          automaticLayout: true,
          fontFamily: monoFamily(),
          fontSize: editorFontSize(),
          minimap: { enabled: true },
          scrollBeyondLastLine: false,
          renderWhitespace: 'selection',
          smoothScrolling: true
        })

        const saved = viewStates.get(filePath)
        if (saved) editor.restoreViewState(saved)
        editor.focus()
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
      }
    })()

    return () => {
      disposed = true
      if (editor) {
        viewStates.set(filePath, editor.saveViewState())
        editor.dispose()
      }
      // The model is intentionally NOT disposed: another tab or a diff may share this file, and
      // Monaco keys models by URI. They are reclaimed when the workspace closes.
    }
  }, [filePath, readOnly])

  if (tooLarge) return <Notice>File is too large to open in the editor.</Notice>
  if (error) return <Notice tone="error">{error}</Notice>
  return <div ref={host} style={{ height: '100%', width: '100%' }} />
}
