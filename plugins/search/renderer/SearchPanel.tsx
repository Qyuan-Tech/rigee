import { useCallback, useEffect, useRef, useState } from 'react'
import { icons, onViewRevealed, openFile, setPluginState, useActiveWorkspace, usePluginState } from '@rigee/plugin-api'
import type { SearchFileResult, SearchMatch, SearchResult } from '../types'
import { useT } from './l10n'
import { search } from './rpc'

const PLUGIN_ID = 'search'
const VIEW_ID = 'search.panel'
/** Long enough to skip the searches for "n", "ne", "nee" on the way to "needle". */
const DEBOUNCE_MS = 220

interface Options {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

/**
 * What was typed and how, per workspace — kept in the shell's per-plugin state so it outlives the
 * panel: switching to the explorer and back, or to another project and back, finds the search as
 * it was left, which is what VS Code does and what people expect of a search box.
 */
function readOptions(state: Record<string, unknown> | undefined): Options {
  return {
    query: typeof state?.query === 'string' ? state.query : '',
    caseSensitive: state?.caseSensitive === true,
    wholeWord: state?.wholeWord === true,
    regex: state?.regex === true
  }
}

let searchSeq = 0

/**
 * Find in files: the panel.
 *
 * Searches as you type, a short pause after the last key, and every new search cancels the one
 * before it in main — so a fast typist costs one ripgrep, not one per letter. Results are grouped
 * by file; clicking a line opens the file with the match selected.
 */
export function SearchPanel({ onCollapse }: { onCollapse: () => void }): React.ReactElement {
  const { t, tn } = useT()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id ?? null
  const saved = readOptions(usePluginState(PLUGIN_ID, workspaceId))
  const [options, setOptions] = useState<Options>(saved)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const current = useRef<string | null>(null)

  // Another workspace, another search: its own, as it was left. Keyed on the workspace alone —
  // `saved` is re-read every render, and following it would undo each keystroke once it is saved.
  useEffect(() => {
    setOptions(saved)
  }, [workspaceId])

  // Cmd+Shift+F: the panel is shown by the shell; taking the keyboard is ours.
  useEffect(() => onViewRevealed(VIEW_ID, () => {
    input.current?.focus()
    input.current?.select()
  }), [])

  const roots = workspace?.folders.map((f) => f.path) ?? []
  const rootKey = roots.join('\n')

  const run = useCallback(async (opts: Options, folders: string[]) => {
    if (current.current) void search('search:cancel', { id: current.current }).catch(() => undefined)
    if (!opts.query || folders.length === 0) {
      current.current = null
      setResult(null)
      setBusy(false)
      return
    }
    const id = `s${++searchSeq}`
    current.current = id
    setBusy(true)
    try {
      const found = await search('search:find', {
        id,
        roots: folders,
        pattern: opts.query,
        caseSensitive: opts.caseSensitive,
        wholeWord: opts.wholeWord,
        regex: opts.regex
      })
      // A newer search has started since; this answer is for a question nobody is asking now.
      if (current.current !== id) return
      setResult(found)
      setCollapsed(new Set())
    } catch (err) {
      if (current.current !== id) return
      setResult({ files: [], matchCount: 0, truncated: false, engine: 'node', elapsedMs: 0, error: err instanceof Error ? err.message : String(err) })
    } finally {
      if (current.current === id) setBusy(false)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => { void run(options, roots) }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `roots` is rebuilt every render; `rootKey` is its content, which is what matters.
  }, [options, rootKey, run])

  // Remembered, but not on every keystroke's re-render: once the typing settles.
  useEffect(() => {
    if (!workspaceId) return
    const timer = setTimeout(() => setPluginState(PLUGIN_ID, workspaceId, { ...options }), 500)
    return () => clearTimeout(timer)
  }, [options, workspaceId])

  // Leaving the panel cancels whatever it was waiting for.
  useEffect(() => () => {
    if (current.current) void search('search:cancel', { id: current.current }).catch(() => undefined)
  }, [])

  const set = (patch: Partial<Options>): void => setOptions((o) => ({ ...o, ...patch }))

  /** Up and Down walk the results; Down from the box enters them. */
  const moveFocus = (from: Element | null, delta: 1 | -1): void => {
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])]
    if (rows.length === 0) return
    const i = from ? rows.indexOf(from as HTMLElement) : -1
    const next = i < 0 ? (delta > 0 ? 0 : rows.length - 1) : i + delta
    if (next < 0) input.current?.focus()
    else rows[Math.min(next, rows.length - 1)]?.focus()
  }

  const multiRoot = roots.length > 1

  return (
    <div className="search">
      <div className="section-header">
        <span className="section-header__title">{t('Search')}</span>
        <button className="icon-button" title={t('Collapse panel')} onClick={onCollapse}>
          <icons.CollapseRight size={14} />
        </button>
      </div>

      <div className="search__box">
        <input
          ref={input}
          className="search__input"
          placeholder={t('Search')}
          spellCheck={false}
          value={options.query}
          onChange={(e) => set({ query: e.target.value })}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') { e.preventDefault(); void run(options, roots) }
            else if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(null, 1) }
            else if (e.key === 'Escape' && options.query) { e.preventDefault(); set({ query: '' }) }
          }}
        />
        <Toggle label="Aa" title={t('Match case')} on={options.caseSensitive} onClick={() => set({ caseSensitive: !options.caseSensitive })} />
        <Toggle label="ab" title={t('Match whole word')} underline on={options.wholeWord} onClick={() => set({ wholeWord: !options.wholeWord })} />
        <Toggle label=".*" title={t('Use regular expression')} on={options.regex} onClick={() => set({ regex: !options.regex })} />
      </div>

      <div
        className="search__results"
        ref={list}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(document.activeElement, 1) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(document.activeElement, -1) }
        }}
      >
        {!workspace && <div className="muted search__note">{t('Open a workspace to search it.')}</div>}
        {workspace && roots.length === 0 && (
          <div className="muted search__note">{t('This workspace has no folders to search. Add one from the explorer.')}</div>
        )}
        {result?.error && <div className="search__error">{result.error}</div>}
        {result && !result.error && options.query && (
          <div className="search__summary" title={t('{engine}, {ms} ms', { engine: result.engine, ms: result.elapsedMs })}>
            {result.matchCount === 0
              ? t('No results')
              : t('{results} in {files}', {
                  results: tn(result.matchCount, '1 result', '{n} results'),
                  files: tn(result.files.length, '1 file', '{n} files')
                })}
            {result.truncated && t(' — the first ones only; narrow the search to see the rest')}
            {busy && ' …'}
          </div>
        )}
        {!result && busy && <div className="search__summary">{t('Searching…')}</div>}

        {result?.files.map((file) => (
          <FileGroup
            key={file.path}
            file={file}
            multiRoot={multiRoot}
            rootName={workspace?.folders.find((f) => f.path === file.root)?.name ?? ''}
            open={!collapsed.has(file.path)}
            onToggle={() =>
              setCollapsed((c) => {
                const next = new Set(c)
                if (next.has(file.path)) next.delete(file.path)
                else next.add(file.path)
                return next
              })
            }
          />
        ))}
      </div>
    </div>
  )
}

function Toggle({
  label,
  title,
  on,
  underline,
  onClick
}: {
  label: string
  title: string
  on: boolean
  underline?: boolean
  onClick: () => void
}): React.ReactElement {
  return (
    <button
      className={`search__toggle${on ? ' search__toggle--on' : ''}`}
      title={title}
      aria-pressed={on}
      // Keeps the keyboard in the box: toggling an option is not leaving the search.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <span style={underline ? { textDecoration: 'underline' } : undefined}>{label}</span>
    </button>
  )
}

function FileGroup({
  file,
  multiRoot,
  rootName,
  open,
  onToggle
}: {
  file: SearchFileResult
  multiRoot: boolean
  rootName: string
  open: boolean
  onToggle: () => void
}): React.ReactElement {
  const rel = relativePath(file.root, file.path)
  const slash = rel.lastIndexOf('/')
  const name = slash < 0 ? rel : rel.slice(slash + 1)
  const dir = slash < 0 ? '' : rel.slice(0, slash)
  const where = [multiRoot ? rootName : '', dir].filter(Boolean).join(' · ')

  return (
    <div className="search__file">
      <div
        className="row row--clickable search__file-row"
        data-row
        tabIndex={0}
        title={file.path}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() }
          else if (e.key === 'ArrowLeft' && open) { e.preventDefault(); onToggle() }
          else if (e.key === 'ArrowRight' && !open) { e.preventDefault(); onToggle() }
        }}
      >
        <span className="search__chevron"><icons.Chevron size={12} open={open} /></span>
        <icons.File size={13} />
        <span className="search__file-name">{name}</span>
        {where && <span className="search__file-dir">{where}</span>}
        <span className="search__count">{file.matches.length}</span>
      </div>
      {open && file.matches.map((m, i) => <MatchRow key={`${m.line}:${m.column}:${i}`} file={file} match={m} />)}
    </div>
  )
}

function MatchRow({ file, match }: { file: SearchFileResult; match: SearchMatch }): React.ReactElement {
  const openIt = (): void => {
    openFile({
      path: file.path,
      selection: { line: match.line, column: match.column, endColumn: match.column + match.length }
    })
  }
  const before = match.preview.slice(0, match.previewColumn)
  const hit = match.preview.slice(match.previewColumn, match.previewColumn + match.length)
  const after = match.preview.slice(match.previewColumn + match.length)
  return (
    <div
      className="row row--clickable search__match"
      data-row
      tabIndex={0}
      title={`${file.path}:${match.line}:${match.column}`}
      onClick={openIt}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); openIt() } }}
    >
      <span className="search__line">{match.line}</span>
      <span className="search__preview">
        {before.trimStart()}
        <mark>{hit}</mark>
        {after}
      </span>
    </div>
  )
}

/** The path under its root, with forward slashes, for display. */
function relativePath(root: string, path: string): string {
  const rel = path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]+/, '') : path
  return rel.split('\\').join('/')
}
