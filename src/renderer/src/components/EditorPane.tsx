import { useEffect, useRef, useState } from 'react'
import { loadMonaco } from '../lazy'
import { editorFontSize, monoFamily } from '../fonts'
import { rpc } from '../ipc'
import type { DiffTab, EditorTab } from '@shared/types'
import type * as Monaco from 'monaco-editor'

/**
 * Monaco lives entirely outside React state: models and editor instances are imperative,
 * long-lived and expensive, and putting them in the store would re-render the world on every
 * keystroke. React owns the container div and nothing else.
 *
 * View state (cursor, scroll, folds) is saved per path so reopening a tab lands where you left.
 */
const viewStates = new Map<string, Monaco.editor.ICodeEditorViewState | null>()

export function EditorPane({ tab }: { tab: EditorTab }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [tooLarge, setTooLarge] = useState(false)

  useEffect(() => {
    let disposed = false
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null
    let model: Monaco.editor.ITextModel | null = null

    void (async () => {
      try {
        const [monaco, file] = await Promise.all([loadMonaco(), rpc['fs:readFile'](tab.filePath)])
        if (disposed || !host.current) return
        if (file.tooLarge) { setTooLarge(true); return }

        const uri = monaco.Uri.file(tab.filePath)
        model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(file.content, undefined, uri)

        editor = monaco.editor.create(host.current, {
          model,
          theme: 'vs-dark',
          readOnly: tab.readOnly,
          automaticLayout: true,
          fontFamily: monoFamily(),
          fontSize: editorFontSize(),
          minimap: { enabled: true },
          scrollBeyondLastLine: false,
          renderWhitespace: 'selection',
          smoothScrolling: true
        })

        const saved = viewStates.get(tab.filePath)
        if (saved) editor.restoreViewState(saved)
        editor.focus()
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
      }
    })()

    return () => {
      disposed = true
      if (editor) {
        viewStates.set(tab.filePath, editor.saveViewState())
        editor.dispose()
      }
      // The model is intentionally NOT disposed: another tab or a diff may share this file, and
      // Monaco keys models by URI. They are reclaimed when the workspace closes.
    }
  }, [tab.filePath, tab.readOnly])

  if (tooLarge) return <Notice>File is too large to open in the editor.</Notice>
  if (error) return <Notice tone="error">{error}</Notice>
  return <div ref={host} style={{ height: '100%', width: '100%' }} />
}

export function DiffPane({ tab }: { tab: DiffTab }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let editor: Monaco.editor.IStandaloneDiffEditor | null = null
    let original: Monaco.editor.ITextModel | null = null
    let modified: Monaco.editor.ITextModel | null = null

    void (async () => {
      try {
        const [monaco, diff] = await Promise.all([
          loadMonaco(),
          rpc['scm:diff']({ repoRoot: tab.repoId, path: tab.filePath, against: tab.against })
        ])
        if (disposed || !host.current) return
        if (diff.binary) { setError('Binary file — no text diff available.'); return }
        if (diff.tooLarge) { setError('File is too large to diff.'); return }

        // Anonymous models: these are revision snapshots, not the file on disk, so they must not
        // collide with the editable model registered under the file's URI.
        original = monaco.editor.createModel(diff.original, undefined)
        modified = monaco.editor.createModel(diff.modified, undefined)

        editor = monaco.editor.createDiffEditor(host.current, {
          theme: 'vs-dark',
          readOnly: true,
          automaticLayout: true,
          renderSideBySide: true,
          fontFamily: monoFamily(),
          fontSize: editorFontSize(),
          ignoreTrimWhitespace: false
        })
        editor.setModel({ original, modified })
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
      }
    })()

    return () => {
      disposed = true
      editor?.dispose()
      original?.dispose()
      modified?.dispose()
    }
  }, [tab.filePath, tab.repoId, tab.against])

  if (error) return <Notice tone="error">{error}</Notice>
  return <div ref={host} style={{ height: '100%', width: '100%' }} />
}

function Notice({
  children,
  tone = 'muted'
}: {
  children: React.ReactNode
  tone?: 'muted' | 'error'
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'grid',
        placeItems: 'center',
        height: '100%',
        padding: 24,
        textAlign: 'center',
        fontSize: 12,
        color: tone === 'error' ? 'var(--git-deleted)' : 'var(--fg-muted)'
      }}
    >
      {children}
    </div>
  )
}
