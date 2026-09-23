import { useEffect, useRef, useState } from 'react'
import { editorFontSize, monoFamily } from '@renderer/fonts'
import { rpc } from '@renderer/ipc'
import { duplicatedFrom, Notice } from '@renderer/plugins/api'
import { loadMonaco, MONACO_THEME } from '@plugins/shared/monaco'
import type { PluginEditorProps } from '@renderer/plugins/bindings'
import type * as Monaco from 'monaco-editor'

type ViewState = Monaco.editor.ICodeEditorViewState | null

/**
 * Monaco lives entirely outside React state: models and editor instances are imperative,
 * long-lived and expensive, and putting them in the store would re-render the world on every
 * keystroke. React owns the container div and nothing else.
 *
 * View state (cursor, scroll, folds) is kept per TAB. Per path was the obvious reading of "lands
 * where you left it" and it was wrong the moment one file could be open twice: both panes wrote
 * the same slot on unmount, so closing one — or merely switching tabs in its group — moved the
 * cursor and the scroll of the other. Editor groups made a latent bug a routine one.
 */
const viewStates = new Map<string, ViewState>()
/**
 * The last state saved for a PATH, which is what makes ordinary reopening still work.
 *
 * A tab id dies with the tab, so keying only by tab would mean closing a file and opening it again
 * always lands at line 1. This is the fallback, never the primary: a live tab's own entry wins.
 */
const lastByPath = new Map<string, ViewState>()
/**
 * Where each MOUNTED editor is right now, asked rather than stored.
 *
 * A split copy wants the position of the pane it was split from, and that pane is still on screen
 * in the other column — nothing has saved its state since it opened, so the map above would answer
 * with whatever it had at the last tab switch, or with nothing at all.
 */
const liveStates = new Map<string, () => ViewState>()

export function MonacoEditor({ filePath, tabId, readOnly }: PluginEditorProps): React.ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [tooLarge, setTooLarge] = useState(false)
  /*
   * The tab this one was split from, read ONCE. `duplicatedFrom` is consume-once and the effect
   * below is double-invoked by StrictMode, so asking there would hand the second pass nothing.
   */
  const [splitFrom] = useState(() => duplicatedFrom(tabId))

  useEffect(() => {
    let disposed = false
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null
    let model: Monaco.editor.ITextModel | null = null
    let snapshot: (() => ViewState) | null = null

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

        // This tab's own place first; then the place of the tab it was split from, live, so
        // splitting halfway down a file opens the copy halfway down it; then the last place
        // anyone was in this file, which is what reopening a closed tab should give you.
        const saved =
          viewStates.get(tabId) ??
          (splitFrom ? (liveStates.get(splitFrom)?.() ?? viewStates.get(splitFrom)) : null) ??
          lastByPath.get(filePath)
        if (saved) editor.restoreViewState(saved)

        const live = editor
        snapshot = () => live.saveViewState()
        liveStates.set(tabId, snapshot)
        editor.focus()
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
      }
    })()

    return () => {
      disposed = true
      if (editor) {
        const state = editor.saveViewState()
        viewStates.set(tabId, state)
        // Written on every unmount, so the newest reading of the file is the one a fresh tab on it
        // inherits — a tab switch counts, which is why this cannot wait for the tab to close.
        lastByPath.set(filePath, state)
        // Compared before deleting: StrictMode builds the replacement before tearing this one
        // down, and an unconditional delete would unregister the editor that is still on screen.
        if (liveStates.get(tabId) === snapshot) liveStates.delete(tabId)
        editor.dispose()
      }
      // The model is intentionally NOT disposed: another tab or a diff may share this file, and
      // Monaco keys models by URI. They are reclaimed when the workspace closes.
    }
  }, [filePath, tabId, readOnly, splitFrom])

  if (tooLarge) return <Notice>File is too large to open in the editor.</Notice>
  if (error) return <Notice tone="error">{error}</Notice>
  return <div ref={host} style={{ height: '100%', width: '100%' }} />
}
