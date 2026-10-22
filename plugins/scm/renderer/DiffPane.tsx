import { useEffect, useMemo, useRef, useState } from 'react'
import { editorFontSize, monoFamily } from '@rigee/plugin-api'
import { Notice } from '@rigee/plugin-api'
import { loadMonaco, MONACO_THEME } from '@plugins/shared/monaco'
import { HunkView } from './HunkView'
import { readDiffTabState, type DiffTabState } from './diffTab'
import { useT } from './l10n'
import { scm } from './rpc'
import type { PluginTabProps } from '@rigee/plugin-api'
import type * as Monaco from 'monaco-editor'

/**
 * A diff tab shows the selectable hunk view by default and Monaco's side-by-side on demand.
 * Reading a change and acting on it want different things: Monaco is better for understanding a
 * large rewrite, the hunk list is the only one of the two that can stage a single line.
 *
 * The tab's persisted state is validated before anything reads it — see diffTab.ts for what can
 * arrive here from an old workspace file.
 */
export function DiffPane({ state }: PluginTabProps): React.ReactElement {
  const { t } = useT()
  const [mode, setMode] = useState<'hunks' | 'split'>('hunks')
  const [nonce, setNonce] = useState(0)

  // Memoised on the persisted state, not recomputed per render: `against` is an object, and a
  // fresh one each render would re-run MonacoDiff's effect and rebuild the diff editor every time
  // anything in this tab changed.
  const target = useMemo(() => readDiffTabState(state), [state])
  if (!target) return <Notice tone="error">{t('This diff tab is missing the file it pointed at.')}</Notice>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="hunks__bar" style={{ gap: 4 }}>
        <span className="hunks__count" title={target.filePath}>{target.filePath}</span>
        <button
          className={mode === 'hunks' ? 'btn btn--primary' : 'btn'}
          onClick={() => setMode('hunks')}
        >
          {t('Hunks')}
        </button>
        <button
          className={mode === 'split' ? 'btn btn--primary' : 'btn'}
          onClick={() => setMode('split')}
        >
          {t('Side by side')}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {mode === 'hunks' ? (
          <HunkView target={target} onApplied={() => setNonce((n) => n + 1)} />
        ) : (
          <MonacoDiff target={target} key={nonce} />
        )}
      </div>
    </div>
  )
}

function MonacoDiff({ target }: { target: DiffTabState }): React.ReactElement {
  const { t } = useT()
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  // Why main would not diff the file, kept as a reason rather than a sentence: put into words when
  // it is shown, it is said in the language the window is in then, not the one it was in on load.
  const [refused, setRefused] = useState<'binary' | 'tooLarge' | null>(null)

  useEffect(() => {
    let disposed = false
    let editor: Monaco.editor.IStandaloneDiffEditor | null = null
    let original: Monaco.editor.ITextModel | null = null
    let modified: Monaco.editor.ITextModel | null = null

    void (async () => {
      try {
        const [monaco, diff] = await Promise.all([
          loadMonaco(),
          scm('scm:diff', {
            repoRoot: target.repoId,
            path: target.filePath,
            against: target.against
          })
        ])
        if (disposed || !host.current) return
        if (diff.binary) { setRefused('binary'); return }
        if (diff.tooLarge) { setRefused('tooLarge'); return }

        // Anonymous models: these are revision snapshots, not the file on disk, so they must not
        // collide with the editable model registered under the file's URI.
        original = monaco.editor.createModel(diff.original, undefined)
        modified = monaco.editor.createModel(diff.modified, undefined)

        editor = monaco.editor.createDiffEditor(host.current, {
          theme: MONACO_THEME,
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
  }, [target.filePath, target.repoId, target.against])

  if (refused === 'binary') return <Notice tone="error">{t('Binary file — no text diff available.')}</Notice>
  if (refused === 'tooLarge') return <Notice tone="error">{t('File is too large to diff.')}</Notice>
  if (error) return <Notice tone="error">{error}</Notice>
  return <div ref={host} style={{ height: '100%', width: '100%' }} />
}
