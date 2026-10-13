import { useEffect, useRef, useState } from 'react'
import {
  duplicatedFrom,
  editorFontSize,
  monoFamily,
  Notice,
  onRevealInFile,
  openedInBackground,
  readFile,
  setFileDirty,
  writeFile
} from '@rigee/plugin-api'
import { loadMonaco, MONACO_THEME } from '@plugins/shared/monaco'
import type { PluginEditorProps } from '@rigee/plugin-api'
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

/**
 * Save state, per FILE — a model is per file and shared by every tab showing it, so "unsaved" is a
 * property of the document, not of a tab.
 *
 * `savedVersion` is Monaco's alternative version id at the last load or save. The ALTERNATIVE id
 * rather than the plain one because undo walks it back: type a character, undo it, and the file
 * is clean again, as in every editor.
 *
 * `base` is the text as it was on disk at that same moment, exactly — byte order mark and line
 * endings included. Saving compares the disk against it, because this app's other half is a
 * terminal running an agent that edits these very files, and saving a copy that was opened before
 * it made its change would silently undo that change.
 *
 * `lossy` means the disk copy is not UTF-8, so what the model holds is a lossy decoding that must
 * never be written back. Every editor on the file goes read-only while it is set, which is why it
 * lives here, with listeners, rather than in one editor's state.
 */
interface FileState {
  savedVersion: number
  base: string
  lossy: boolean
  listeners: Set<(lossy: boolean) => void>
}
const files = new Map<string, FileState>()

const BOM = '\uFEFF'
/** Monaco's EndOfLinePreference.TextDefined and EndOfLineSequence values, which a type import cannot reach. */
const EOL_AS_IS = 0
const EOL_LF = 0
const EOL_CRLF = 1

function track(model: Monaco.editor.ITextModel, filePath: string, base: string, lossy: boolean): FileState {
  const known = files.get(filePath)
  if (known) return known
  const state: FileState = { savedVersion: model.getAlternativeVersionId(), base, lossy, listeners: new Set() }
  files.set(filePath, state)
  model.onDidChangeContent(() => report(filePath, model))
  model.onWillDispose(() => {
    files.delete(filePath)
    setFileDirty(filePath, false)
  })
  return state
}

function markLossy(state: FileState, lossy: boolean): void {
  if (state.lossy === lossy) return
  state.lossy = lossy
  state.listeners.forEach((cb) => cb(lossy))
}

function report(filePath: string, model: Monaco.editor.ITextModel): void {
  const state = files.get(filePath)
  if (!state) return
  setFileDirty(filePath, model.getAlternativeVersionId() !== state.savedVersion, {
    save: () => saveFile(filePath, model),
    discard: () => revertFile(filePath, model)
  })
}

const nameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path

/**
 * Write the file. Rejects, with a reason fit to show, when it was not written — including every
 * case where writing would clobber something: the file changed on disk since it was read, it was
 * deleted, or it grew too large to compare, and the user did not say to go ahead.
 */
async function saveFile(filePath: string, model: Monaco.editor.ITextModel): Promise<void> {
  const state = files.get(filePath)
  if (!state) return
  const name = nameOf(filePath)
  if (state.lossy) throw new Error(`${name} is not UTF-8, so it is read-only here`)

  let disk: Awaited<ReturnType<typeof readFile>> | null
  try {
    disk = await readFile(filePath)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Gone — a refactor moved or deleted it. Writing would quietly bring it back, which is how a
    // build ends up with the module it was supposed to have lost.
    if (!/ENOENT|no such file/i.test(message)) throw new Error(`could not check ${name} before saving: ${message}`)
    if (!window.confirm(`${name} has been deleted or moved on disk since it was opened here.\n\nSave it again anyway?`)) {
      throw new Error(`${name} was deleted on disk; not saved`)
    }
    disk = null
  }
  if (disk && (disk.tooLarge || disk.content !== state.base)) {
    const overwrite = window.confirm(
      `${name} has changed on disk since it was opened here — another program, or an agent in a terminal, wrote to it.\n\n` +
        'Overwrite it with the version in the editor? Cancel keeps the file on disk as it is.'
    )
    if (!overwrite) throw new Error(`${name} changed on disk; not overwritten`)
  }
  // With the byte order mark if the file on disk had one when last read — not whatever it had when
  // first opened: a tool that has since added or removed it is the one to follow. A CSV that loses
  // its mark opens as mojibake in Excel.
  const content = (state.base.startsWith(BOM) ? BOM : '') + model.getValue(EOL_AS_IS as Monaco.editor.EndOfLinePreference)
  const version = model.getAlternativeVersionId()
  await writeFile(filePath, content)
  state.savedVersion = version
  state.base = content
  report(filePath, model)
}

/**
 * Drop the unsaved changes: back to what is on disk now, or — if that cannot be read — to what it
 * was when last read or written. Either way the file is clean afterwards, so a later "Save All"
 * on the way out cannot bring back text the user chose to throw away.
 */
async function revertFile(filePath: string, model: Monaco.editor.ITextModel): Promise<void> {
  const state = files.get(filePath)
  if (!state) return
  const disk = await readFile(filePath).catch(() => null)
  if (disk && !disk.tooLarge && !disk.notUtf8) {
    replaceText(model, disk.content)
    state.base = disk.content
  } else {
    replaceText(model, state.base)
    if (disk?.notUtf8) markLossy(state, true)
  }
  state.savedVersion = model.getAlternativeVersionId()
  report(filePath, model)
}

/**
 * The file changed on disk and this copy has nothing unsaved: take the disk's version. Called
 * whenever the user comes back to the file — a tab shown, the editor clicked into, the window
 * focused, a search result opened — because nothing tells the renderer a file changed, and an
 * agent in the terminal next door may have rewritten it a minute ago.
 *
 * A disk copy that is no longer UTF-8 is not loaded — its decoding would be lossy, and a clean
 * model holding it would be saved back over the real bytes. The file goes read-only instead.
 */
async function refreshFromDisk(filePath: string, model: Monaco.editor.ITextModel): Promise<boolean> {
  const state = files.get(filePath)
  if (!state || model.getAlternativeVersionId() !== state.savedVersion) return false
  const disk = await readFile(filePath).catch(() => null)
  if (!disk || disk.tooLarge || model.isDisposed()) return false
  if (model.getAlternativeVersionId() !== state.savedVersion) return false
  if (disk.notUtf8) {
    markLossy(state, true)
    return false
  }
  let changed = false
  if (disk.content !== state.base) {
    replaceText(model, disk.content)
    state.savedVersion = model.getAlternativeVersionId()
    state.base = disk.content
    report(filePath, model)
    changed = true
  }
  markLossy(state, false)
  return changed
}

/**
 * Bring the model's text to `raw`, as an undo step of its own.
 *
 * Only the span that differs is replaced — the common beginning and end are left alone — so the
 * cursor, folds and decorations stay with their text. Replacing everything would keep the cursor at
 * the same character OFFSET, which after an agent adds three lines near the top is a different line,
 * and the next keystrokes would land in the wrong place. And the step is closed off on both sides:
 * without that, one Cmd+Z would take back the user's last typing and the agent's change together.
 *
 * Line endings follow the text by Monaco's own rule — CRLF only when most line breaks are — so a
 * reload leaves the file as opening it would. A byte order mark is not part of the text.
 */
function replaceText(model: Monaco.editor.ITextModel, raw: string): void {
  const text = raw.startsWith(BOM) ? raw.slice(1) : raw
  model.pushStackElement()
  const breaks = (text.match(/\r\n|\r|\n/g) ?? []).length
  if (breaks > 0) {
    const crlf = (text.match(/\r\n/g) ?? []).length
    const eol = crlf > breaks / 2 ? EOL_CRLF : EOL_LF
    if (model.getEndOfLineSequence() !== eol) model.pushEOL(eol as Monaco.editor.EndOfLineSequence)
  }
  const current = model.getValue()
  const next = text.replace(/\r\n|\r|\n/g, model.getEOL())
  if (current === next) return
  const max = Math.min(current.length, next.length)
  let start = 0
  while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++
  let end = 0
  while (end < max - start && current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end++
  const from = model.getPositionAt(start)
  const to = model.getPositionAt(current.length - end)
  model.pushEditOperations(
    [],
    [{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: next.slice(start, next.length - end) }],
    () => null
  )
  model.pushStackElement()
}

export function MonacoEditor({ filePath, tabId, readOnly }: PluginEditorProps): React.ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [tooLarge, setTooLarge] = useState(false)
  /** Not UTF-8: shown, but read-only, because saving the lossy decoding would destroy the file. */
  const [lossy, setLossy] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  /*
   * The tab this one was split from, read ONCE. `duplicatedFrom` is consume-once and the effect
   * below is double-invoked by StrictMode, so asking there would hand the second pass nothing.
   */
  const [splitFrom] = useState(() => duplicatedFrom(tabId))
  /*
   * Whether this pane has had its chance at the keyboard. Only the pane that has just opened takes
   * it: the effect below runs again when the file tree renames the file under it, and the keyboard
   * belongs where the user typed the new name.
   */
  const focused = useRef(false)

  useEffect(() => {
    let disposed = false
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null
    let model: Monaco.editor.ITextModel | null = null
    let snapshot: (() => ViewState) | null = null
    const cleanups: Array<() => void> = []

    void (async () => {
      try {
        const [monaco, file] = await Promise.all([loadMonaco(), readFile(filePath)])
        if (disposed || !host.current) return
        if (file.tooLarge) { setTooLarge(true); return }

        const uri = monaco.Uri.file(filePath)
        const existing = monaco.editor.getModel(uri)
        model = existing ?? monaco.editor.createModel(file.content, undefined, uri)
        const state = track(model, filePath, file.content, !!file.notUtf8)
        // A model kept from an earlier tab may be older than the file: take the disk's version,
        // unless it holds changes of its own. Anything that wants to put the cursor somewhere —
        // a search result — waits for this, or it would land on the old text's offsets.
        const synced = existing ? refreshFromDisk(filePath, existing) : Promise.resolve(false)
        setLossy(state.lossy)

        editor = monaco.editor.create(host.current, {
          model,
          theme: MONACO_THEME,
          readOnly: readOnly || state.lossy,
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
        const liveModel = model
        snapshot = () => live.saveViewState()
        liveStates.set(tabId, snapshot)

        // Every editor on this file goes read-only, with the banner, while the disk copy is not
        // UTF-8 — including ones opened before it stopped being.
        const onLossy = (lossy: boolean): void => {
          setLossy(lossy)
          live.updateOptions({ readOnly: readOnly || lossy })
        }
        state.listeners.add(onLossy)
        cleanups.push(() => state.listeners.delete(onLossy))

        // Cmd+S / Ctrl+S. An ACTION, not addCommand: Monaco's addCommand registers window-wide, the
        // last editor to register wins, and the registration outlives the editor — so with two
        // files open, Cmd+S in one saved the other. An action's keybinding is scoped to its own
        // editor and goes away with it.
        if (!readOnly) {
          const save = live.addAction({
            id: 'rigee.save',
            label: 'Save',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
            run: () => {
              // Nothing to save: write nothing. Rewriting an unchanged file only touches its mtime
              // — and restarts every watcher on it — and if an agent changed it meanwhile, offering
              // to overwrite that with this older copy is offering to lose work for no reason.
              // Take the disk's version instead.
              if (liveModel.getAlternativeVersionId() === state.savedVersion) {
                void refreshFromDisk(filePath, liveModel)
                return
              }
              saveFile(filePath, liveModel).then(
                () => setSaveError(null),
                (e: unknown) => setSaveError(e instanceof Error ? e.message : String(e))
              )
            }
          })
          cleanups.push(() => save.dispose())
        }

        // Where a search result wants the cursor. Delivered now if it was asked for before this
        // editor existed, which is the usual case: the result opened the tab that mounted it.
        //
        // Placed at once — the next keystroke may come straight after the click that opened the
        // result, and it must replace the match. And placed AGAIN if the text then turns out to
        // have changed on disk: the line and column came from the file as it is now, and a reload
        // carries a selection made on the older copy to the wrong characters.
        cleanups.push(
          onRevealInFile(tabId, (sel) => {
            const place = (): void => {
              if (disposed) return
              const range = new monaco.Range(sel.line, sel.column, sel.endLine ?? sel.line, sel.endColumn ?? sel.column)
              live.setSelection(range)
              live.revealRangeInCenterIfOutsideViewport(range)
              live.focus()
            }
            place()
            void Promise.all([synced, refreshFromDisk(filePath, liveModel)]).then(([a, b]) => { if (a || b) place() })
          })
        )

        const onBack = (): void => { void refreshFromDisk(filePath, liveModel) }
        const focusSub = live.onDidFocusEditorText(onBack)
        window.addEventListener('focus', onBack)
        cleanups.push(() => { focusSub.dispose(); window.removeEventListener('focus', onBack) })

        // Unless it was opened in the background: a single click in the file tree keeps the
        // keyboard there, so the tree's arrows and Delete go on acting on the tree.
        if (!focused.current) {
          focused.current = true
          if (!openedInBackground(tabId)) editor.focus()
        }
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
      }
    })()

    return () => {
      disposed = true
      for (const undo of cleanups) undo()
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
  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}>
      {lossy && (
        <div className="error-banner">
          This file is not UTF-8, so it is shown read-only — saving would replace every character it
          could not decode.
        </div>
      )}
      {saveError && <div className="error-banner">Not saved: {saveError}</div>}
      <div ref={host} style={{ flex: 1, minHeight: 0, width: '100%' }} />
    </div>
  )
}
