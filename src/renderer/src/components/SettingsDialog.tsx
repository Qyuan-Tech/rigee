import { useEffect, useMemo, useRef, useState } from 'react'
import { isMac, platform, rpc } from '../ipc'
import { formatChord, matchesChord, parseChord } from '../keys'
import {
  ACTIONS,
  actionLabel,
  buildKeymap,
  defaultBinds,
  diffKeymap,
  formatTrigger,
  lookupBinding,
  sameBinding,
  splitAction,
  triggerAliases,
  triggerFromEvent,
  triggerId,
  type ActionGroup,
  type Binding,
  type Keymap,
  type Trigger
} from '@shared/keymap'
import { lookupShortcut, unshiftedKey } from '../shortcuts'
import { rowOf, useApp } from '../store'
import { getTerminal, paneKey } from '../terminals'
import { DEFAULT_KEYBINDINGS, type AppSettings } from '@shared/types'
import { namedWorkspaceFile, workspaceFilesDirProblem } from '@shared/workspaceFiles'

type Page = 'general' | 'shortcuts'

const PAGES: ReadonlyArray<readonly [Page, string]> = [
  ['general', 'General'],
  ['shortcuts', 'Keyboard Shortcuts']
]

/** Where the dialog was last left, so it opens there again — for the rest of this session. */
let lastPage: Page = 'general'

/**
 * Settings: the General page, and the keyboard shortcuts.
 *
 * Both pages are drafts until Save, and one Save keeps both — two buttons that each kept half of
 * what was changed would be a trap for whoever edits one page and leaves from the other.
 *
 * On the shortcuts page, chords are captured by pressing them rather than typed as text — writing
 * a chord out is a guessing game about spelling, and pressing it is unambiguous. The text box at
 * the bottom is for the other direction: pasting `keybind = …` lines straight out of a Ghostty
 * config.
 *
 * What is edited there is the list of the user's CHANGES, as Ghostty lines on top of the
 * platform's defaults; the table is that list applied. Keeping the list as the source of truth is
 * what lets the two views agree, and what gets saved — so a default that improves in a later
 * release still reaches every key the user never touched.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const stored = useApp((s) => s.keybindings)
  const setKeybindings = useApp((s) => s.setKeybindings)
  const storedSettings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)
  const [page, setPage] = useState<Page>(lastPage)
  const [filesDir, setFilesDir] = useState(storedSettings.workspaceFilesDir ?? '')
  const dirProblem = workspaceFilesDirProblem(filesDir)
  const mac = isMac()
  const defaultLines = defaultBinds(platform())
  const defaults = useMemo(() => buildKeymap(defaultLines, []).keymap, [defaultLines])

  const [lines, setLines] = useState<string[]>(() => stored.binds ?? [])
  const { keymap: draft, errors } = useMemo(() => buildKeymap(defaultLines, lines), [defaultLines, lines])
  /** Lines this version cannot read — a newer build's action, a typo. Kept, never silently lost. */
  const unreadable = useMemo(() => errors.map((e) => e.line), [errors])

  const [prefix, setPrefix] = useState({
    prefix: stored.prefix,
    splitRight: stored.splitRight,
    splitDown: stored.splitDown,
    closePane: stored.closePane
  })
  const [capture, setCapture] = useState<{ kind: 'action'; action: string } | { kind: 'prefix' } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  /** The text box, while the user is typing in it; null shows the lines as they stand. */
  const [text, setText] = useState<string | null>(null)
  /** The unusable lines the last Save stopped to point out; the next Save goes ahead with them. */
  const [warned, setWarned] = useState<string | null>(null)
  const filterInput = useRef<HTMLInputElement>(null)
  const dirInput = useRef<HTMLInputElement>(null)

  const showPage = (next: Page): void => {
    lastPage = next
    setPage(next)
    // A chord half-captured, or a remark about one, belongs to the page being left.
    setCapture(null)
    setNotice(null)
  }

  // Take the keyboard, and give it back on the way out. Opened with Cmd+, from a terminal, the
  // terminal would otherwise still have it and the first thing typed would go to the shell behind
  // the dialog; closed, the field that had it disappears, and without this the keyboard is left
  // on <body> — the terminal the dialog was opened from would hear nothing until clicked.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    return () => {
      // Only somewhere that takes typing — a terminal, an editor, a text box — and only in the
      // column the user is working in now. A button clicked to get here (the gear) would keep the
      // keyboard on itself; a terminal in ANOTHER column — the user having since clicked into a
      // web page — would take the next Enter, or the next Cmd+W, meant for somewhere else.
      if (previous && previous.isConnected && takesTyping(previous) && inActiveColumn(previous)) previous.focus()
      else focusActiveTerminal()
    }
  }, [])

  // Declared after the effect above, so that one has seen where the keyboard was before this moves
  // it: to the first field of whichever page is showing.
  useEffect(() => {
    ;(page === 'shortcuts' ? filterInput : dirInput).current?.focus()
  }, [page])

  /** Replace the table with an edited copy of it, stored as the difference from the defaults. */
  const commit = (next: Map<string, Binding>): void => {
    setLines([...diffKeymap(defaults, next), ...unreadable])
    setText(null)
  }

  useEffect(() => {
    if (!capture) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        setCapture(null)
        return
      }
      // A modifier on its own: wait for the key it modifies.
      if (['Control', 'Meta', 'Alt', 'Shift', 'CapsLock', 'AltGraph'].includes(e.key)) return

      if (capture.kind === 'prefix') {
        const parts: string[] = []
        if (e.ctrlKey) parts.push('ctrl')
        if (e.altKey) parts.push('alt')
        if (e.shiftKey) parts.push('shift')
        if (e.metaKey) parts.push('cmd')
        // What the key types unshifted, not `e.key`: Option composes on a Mac, and `alt+å` is not
        // what anybody pressed. The terminal matches it the same way (keys.ts, matchesChord).
        const base = (e.code && unshiftedKey(e.code)) || e.key
        parts.push(base === ' ' ? 'space' : base.toLowerCase())
        const spec = parts.join('+')
        setPrefix((p) => ({ ...p, prefix: spec }))
        const shadowed = lookupBinding(draft, e, unshiftedKey)
        setNotice(
          shadowed
            ? `${formatChord(spec, mac)} is also “${actionLabel(shadowed.action)}”. In a terminal the prefix comes first, so that shortcut will not work there.`
            : null
        )
        setCapture(null)
        return
      }

      const trigger = triggerFromEvent(e, unshiftedKey)
      if (!trigger) return
      const refusal = refuse(trigger)
      if (refusal) {
        setNotice(`${formatTrigger(trigger, mac)} ${refusal} — add ${mac ? '⌘, ⌃ or ⌥' : 'Ctrl or Alt'}.`)
        return
      }
      const prefixChord = parseChord(prefix.prefix)
      if (prefixChord && matchesChord(e, prefixChord, e.code ? unshiftedKey(e.code) : undefined)) {
        setNotice(`${formatTrigger(trigger, mac)} is the tmux-style prefix. Change or turn off the prefix first.`)
        return
      }

      const next = new Map(draft)
      // Whatever this keypress does now, it stops doing: looked up the way a real keypress is, so
      // `super+1` and `super+digit_1` are recognised as the same key.
      const previous = lookupBinding(draft, e, unshiftedKey)
      if (previous) next.delete(triggerId(previous.trigger))
      next.delete(triggerId(trigger))
      next.set(triggerId(trigger), {
        trigger,
        action: capture.action,
        performable: flagsFor(defaults, capture.action),
        unconsumed: false
      })
      commit(next)
      setNotice(
        previous && previous.action !== capture.action
          ? `${formatTrigger(trigger, mac)} did “${actionLabel(previous.action)}”. It now does “${actionLabel(capture.action)}”.`
          : null
      )
      setCapture(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // `commit` is rebuilt every render; what it reads — `draft`, `defaults`, `unreadable` — is here.
  }, [capture, draft, defaults, mac, unreadable, prefix.prefix])

  // Escape closes, and so does whatever closes a pane or tab — Cmd+W, the way a settings window is
  // dismissed on a Mac. Answered here because the window listener stands down while the dialog is
  // open, and a Cmd+W nobody cancels is one Electron's menu would take as "close the window".
  useEffect(() => {
    if (capture) return
    const onKey = (e: KeyboardEvent): void => {
      // An Escape mid-composition cancels the input method's candidates, not the dialog.
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return
      const action = splitAction(lookupShortcut(e)?.action ?? '')[0]
      if (e.key === 'Escape' || action === 'close_surface' || action === 'close_tab') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [capture, onClose])

  const remove = (...bs: Binding[]): void => {
    const next = new Map(draft)
    for (const b of bs) next.delete(triggerId(b.trigger))
    commit(next)
    setNotice(null)
  }

  const resetAction = (action: string): void => {
    const next = new Map(draft)
    for (const [id, b] of draft) if (b.action === action) next.delete(id)
    const moved: string[] = []
    for (const [id, d] of defaults) {
      if (d.action !== action) continue
      // The default's key may have gone to another action since, possibly spelled differently —
      // `super+1` for what the default calls `super+digit_1`. It comes back here, and says so.
      for (const alias of triggerAliases(d.trigger)) {
        const other = next.get(alias)
        // Only somebody else's: the same key spelled twice for THIS action (the digit row and the
        // keypad, `super+digit_1` and `super+1`) is exactly what the defaults are putting back.
        if (!other || other.action === action) continue
        moved.push(`${formatTrigger(d.trigger, mac)} no longer does “${actionLabel(other.action)}”`)
        next.delete(alias)
      }
      next.set(id, d)
    }
    commit(next)
    setNotice(moved.length ? `${moved.join('; ')}.` : null)
  }

  const applyText = (): void => {
    if (text === null) return
    setLines(text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== ''))
    setText(null)
  }

  const prefixValid =
    (prefix.prefix === '' || parseChord(prefix.prefix) !== null) &&
    [prefix.splitRight, prefix.splitDown, prefix.closePane].every((k) => k.length === 1)

  const save = (): void => {
    if (!prefixValid) return
    // A folder that cannot be used is pointed out where it was typed, not saved.
    if (dirProblem) {
      showPage('general')
      return
    }
    const binds = text !== null
      ? text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '')
      : lines
    // A line typed in this session that Rigee cannot use is something the user has not been told
    // about yet — the list renders in the same click that would close the dialog. So the first
    // Save stops and says so; the second saves, skipping those lines, the way Ghostty loads a
    // config with lines it does not understand. A pasted Ghostty block is full of actions Rigee
    // has no use for (new_window, quit, inspector), and refusing to save it at all would make
    // "paste your Ghostty keybinds" a promise the dialog does not keep. Lines that came from disk
    // are never counted: a newer build may have written them.
    const fresh = buildKeymap(defaultLines, binds).errors.filter((e) => !(stored.binds ?? []).includes(e.line))
    const warning = fresh.map((e) => e.line).join('\n')
    if (fresh.length > 0 && warned !== warning) {
      setLines(binds)
      setText(null)
      setWarned(warning)
      // Said where the lines are, which need not be the page Save was pressed on.
      lastPage = 'shortcuts'
      setPage('shortcuts')
      setNotice(`${fresh.length === 1 ? 'One line' : `${fresh.length} lines`} in “Your changes” cannot be used and will be skipped — see the list under it. Save again to save anyway.`)
      return
    }
    const next = { ...stored, ...prefix, binds }
    setKeybindings(next)
    void rpc['state:saveKeybindings']({ keybindings: next })
    const settings = withFilesDir(storedSettings, filesDir)
    setSettings(settings)
    void rpc['state:saveSettings']({ settings })
    onClose()
  }

  const rows = useMemo(() => tableRows(defaults, draft), [defaults, draft])
  const needle = filter.trim().toLowerCase()
  const shown = rows.filter(
    (r) =>
      !needle ||
      actionLabel(r.action).toLowerCase().includes(needle) ||
      r.action.toLowerCase().includes(needle) ||
      r.bindings.some((b) => formatTrigger(b.trigger, mac).toLowerCase().includes(needle))
  )

  return (
    <div className="modal__scrim" onMouseDown={onClose}>
      <div className="modal modal--settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings__head">
          <div className="modal__title">Settings</div>
          <div className="settings__tabs" role="tablist">
            {PAGES.map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={page === id}
                className={`settings__tab${page === id ? ' settings__tab--active' : ''}`}
                onClick={() => showPage(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {page === 'general' ? (
          <GeneralPage dir={filesDir} problem={dirProblem} inputRef={dirInput} onChange={setFilesDir} />
        ) : (
          <>
            <div className="shortcuts__intro">
              The defaults are Ghostty’s, so the same keys work in both. Press + to add a key to an
              action, hover a key to remove it.
            </div>
            <input
              ref={filterInput}
              className="shortcuts__filter"
              placeholder="Filter by action or key"
              value={filter}
              spellCheck={false}
              onChange={(e) => setFilter(e.target.value)}
            />

            <div className="shortcuts__scroll">
              {GROUP_ORDER.map((group) => {
                const inGroup = shown.filter((r) => ACTIONS[splitAction(r.action)[0]]?.group === group)
                if (inGroup.length === 0) return null
                return (
                  <div key={group}>
                    <div className="shortcuts__group">{group}</div>
                    {inGroup.map((r) => (
                      <div key={r.action} className={`shortcuts__row${r.changed ? ' shortcuts__row--changed' : ''}`}>
                        <span className="shortcuts__label">
                          {actionLabel(r.action)}
                          <small>{r.action}</small>
                        </span>
                        <span className="shortcuts__keys">
                          {chips(r.bindings, mac).map(({ label, bindings }) => (
                            <span key={label} className="shortcuts__chip">
                              {label}
                              <button title="Remove" onClick={() => remove(...bindings)}>×</button>
                            </span>
                          ))}
                          {capture?.kind === 'action' && capture.action === r.action ? (
                            <span className="shortcuts__chip shortcuts__chip--capturing">press keys… Esc cancels</span>
                          ) : (
                            <button className="shortcuts__add" title="Add a key" onClick={() => { setNotice(null); setCapture({ kind: 'action', action: r.action }) }}>
                              +
                            </button>
                          )}
                        </span>
                        {r.changed && (
                          <button className="shortcuts__reset" title="Back to the default" onClick={() => resetAction(r.action)}>
                            ↺
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )
              })}

              <div className="shortcuts__section">
                <div className="shortcuts__group">tmux-style prefix</div>
                <div className="shortcuts__intro">
                  Press the prefix, let go, then one key. Pressing the prefix twice sends it to the shell.
                </div>
                <div className="shortcuts__prefix">
                  <span>Prefix</span>
                  <button className="btn" onClick={() => { setNotice(null); setCapture({ kind: 'prefix' }) }}>
                    {capture?.kind === 'prefix'
                      ? 'press a key combination…'
                      : prefix.prefix
                        ? formatChord(prefix.prefix, mac)
                        : 'none'}
                  </button>
                  {prefix.prefix && (
                    <button className="btn" title="Turn the prefix off" onClick={() => setPrefix((p) => ({ ...p, prefix: '' }))}>
                      Off
                    </button>
                  )}
                  <PrefixKey label="split right" value={prefix.splitRight} onChange={(v) => setPrefix((p) => ({ ...p, splitRight: v }))} />
                  <PrefixKey label="split down" value={prefix.splitDown} onChange={(v) => setPrefix((p) => ({ ...p, splitDown: v }))} />
                  <PrefixKey label="close pane" value={prefix.closePane} onChange={(v) => setPrefix((p) => ({ ...p, closePane: v }))} />
                </div>
              </div>

              <div className="shortcuts__section">
                <div className="shortcuts__group">Your changes, as Ghostty config</div>
                <div className="shortcuts__intro">
                  One per line, applied over the defaults — <code>super+k=unbind</code>,{' '}
                  <code>performable:super+c=copy_to_clipboard</code>. Lines copied from a Ghostty config,
                  <code> keybind = …</code> and all, work as they are.
                </div>
                <textarea
                  className="shortcuts__text"
                  spellCheck={false}
                  value={text ?? lines.join('\n')}
                  placeholder="No changes — every key does what it does in Ghostty."
                  onChange={(e) => setText(e.target.value)}
                  onBlur={applyText}
                />
                {errors.length > 0 && (
                  <div className="shortcuts__errors">
                    {errors.map((e, i) => (
                      <div key={i}>skipped “{e.line}”: {e.message}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {notice && <div className="shortcuts__notice">{notice}</div>}

        <div className="modal__actions">
          {/* Every key back to Ghostty's. Only beside the keys: on the General page it would read
              as resetting everything there too. */}
          {page === 'shortcuts' && (
            <button
              className="btn"
              onClick={() => {
                setLines([])
                setText(null)
                setPrefix({
                  prefix: DEFAULT_KEYBINDINGS.prefix,
                  splitRight: DEFAULT_KEYBINDINGS.splitRight,
                  splitDown: DEFAULT_KEYBINDINGS.splitDown,
                  closePane: DEFAULT_KEYBINDINGS.closePane
                })
                setNotice(null)
              }}
            >
              Reset all
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={!prefixValid} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  )
}

/**
 * The General page: where saved workspaces go.
 *
 * A text box as well as a picker. Picking is how most people will set it, but a path typed or
 * pasted — `~/Workspaces` — is quicker for anyone who already knows where they want it, and the
 * picker can make the folder too.
 */
function GeneralPage({
  dir,
  problem,
  inputRef,
  onChange
}: {
  dir: string
  problem: string | null
  inputRef: React.RefObject<HTMLInputElement | null>
  onChange: (dir: string) => void
}): React.ReactElement {
  const choose = async (): Promise<void> => {
    const picked = await rpc['workspace:pickFolder']({
      message: 'Choose the folder workspaces are saved in',
      defaultPath: dir.trim() || undefined
    })
    if (picked) onChange(picked)
  }
  const example = namedWorkspaceFile(dir, 'myworkspace', platform() === 'win32' ? '\\' : '/')

  return (
    <div className="shortcuts__scroll">
      <div className="shortcuts__group">Workspace files</div>
      <div className="shortcuts__intro">
        Where <b>Save Workspace As…</b> puts a workspace: in a folder of its own, named after the
        workspace, so the repos it brings together can stay wherever they already are.
      </div>
      <div className="settings__field">
        <input
          ref={inputRef}
          className="settings__path"
          value={dir}
          spellCheck={false}
          placeholder="Not set — ask where, every time"
          onChange={(e) => onChange(e.target.value)}
        />
        <button className="btn" onClick={() => void choose()}>Choose…</button>
        {dir && (
          <button className="btn" title="Ask where, every time" onClick={() => onChange('')}>
            Clear
          </button>
        )}
      </div>
      {problem ? (
        <div className="settings__note settings__note--error">{problem}</div>
      ) : dir.trim() ? (
        <div className="settings__note">
          A workspace named <code>myworkspace</code> is saved as <code>{example}</code>
        </div>
      ) : (
        <div className="settings__note">Save Workspace As… asks where to save, every time.</div>
      )}
    </div>
  )
}

/** The stored settings with this folder in them — or without one, when the box was emptied. */
function withFilesDir(settings: AppSettings, dir: string): AppSettings {
  const next = { ...settings }
  if (dir.trim()) next.workspaceFilesDir = dir.trim()
  else delete next.workspaceFilesDir
  return next
}

function PrefixKey({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (v: string) => void
}): React.ReactElement {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <input value={value} maxLength={1} spellCheck={false} onChange={(e) => onChange(e.target.value.slice(-1))} />
      {label}
    </label>
  )
}

const GROUP_ORDER: readonly ActionGroup[] = ['Clipboard', 'Editing', 'Font', 'Screen', 'Tabs', 'Splits', 'Search', 'Window']

/**
 * Actions offered in the table although nothing binds them by default on this platform, so they
 * can be given a key without knowing their Ghostty name. Anything else is a line in the text box.
 */
const EXTRA_ROWS: readonly string[] = [
  ...Object.entries(ACTIONS)
    .filter(([name, spec]) => !spec.param && name !== 'ignore')
    .map(([name]) => name),
  'close_tab:other', 'close_tab:right',
  'new_split:right', 'new_split:down', 'new_split:left', 'new_split:up', 'new_split:auto',
  'goto_split:previous', 'goto_split:next',
  'goto_split:up', 'goto_split:down', 'goto_split:left', 'goto_split:right',
  'resize_split:up,10', 'resize_split:down,10', 'resize_split:left,10', 'resize_split:right,10',
  'navigate_search:next', 'navigate_search:previous',
  'text:\\x01', 'text:\\x05', 'text:\\x15', 'esc:b', 'esc:f'
]

interface Row {
  action: string
  bindings: Binding[]
  /** Differs from the defaults for this action, in keys or in flags. */
  changed: boolean
}

function tableRows(defaults: Keymap, draft: Keymap): Row[] {
  const order: string[] = []
  const seen = new Set<string>()
  const add = (a: string): void => { if (!seen.has(a)) { seen.add(a); order.push(a) } }
  for (const b of defaults.values()) add(b.action)
  for (const b of draft.values()) add(b.action)
  for (const a of EXTRA_ROWS) add(a)

  return order.map((action) => {
    const bindings = [...draft.values()].filter((b) => b.action === action)
    const originals = [...defaults.values()].filter((b) => b.action === action)
    const changed =
      bindings.length !== originals.length ||
      !bindings.every((b) => originals.some((d) => sameBinding(b, d)))
    return { action, bindings, changed }
  })
}

/**
 * One chip per key as the user sees it. `super+digit_1` and `super+1` are both ⌘1 — the digit row
 * and the keypad — and two identical chips side by side would read as a mistake; removing the
 * chip removes both.
 */
function chips(bindings: Binding[], mac: boolean): Array<{ label: string; bindings: Binding[] }> {
  const out: Array<{ label: string; bindings: Binding[] }> = []
  for (const b of bindings) {
    const label = formatTrigger(b.trigger, mac)
    const hit = out.find((c) => c.label === label)
    if (hit) hit.bindings.push(b)
    else out.push({ label, bindings: [b] })
  }
  return out
}

/**
 * Why a captured key cannot be a shortcut, if it cannot: it is how something gets TYPED. A letter,
 * a digit, Space, Enter, Tab, Backspace, an arrow — bound on their own, the terminal and every text
 * box would lose them. Shift+letter is typing too; Shift+Enter or Shift+arrow is not.
 */
function refuse(t: Trigger): string | null {
  if (t.mods.super || t.mods.ctrl || t.mods.alt) return null
  const types = !t.physical || t.key === 'space' || (t.key.startsWith('numpad_') && t.key !== 'numpad_enter')
  if (types) return 'types a character'
  if (t.mods.shift) return null
  if (/^(enter|numpad_enter|tab|backspace|delete|arrow_|home$|end$|page_|insert$)/.test(t.key)) return 'is how text is edited'
  return null
}

/** Somewhere the keyboard is useful to hand back to: a text field, an editor, a terminal. */
function takesTyping(el: HTMLElement): boolean {
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || !!el.closest('.monaco-editor')
}

function inActiveColumn(el: HTMLElement): boolean {
  const s = useApp.getState()
  const column = el.closest<HTMLElement>('[data-group-id]')
  // Outside the columns altogether — the sidebar, the find bar's panel — is nobody else's.
  if (!column || !s.activeWorkspaceId) return true
  return column.dataset.groupId === rowOf(s, s.activeWorkspaceId).activeGroupId
}

/**
 * The keyboard back to the active column's terminal, when there is nothing better. Anything else
 * there — a browser page, which takes it back itself when it is shown again — gets the focus
 * dropped rather than left on a button.
 */
function focusActiveTerminal(): void {
  const s = useApp.getState()
  if (!s.activeWorkspaceId) return
  const row = rowOf(s, s.activeWorkspaceId)
  const group = row.groups.find((g) => g.id === row.activeGroupId)
  const tab = group?.tabs.find((t) => t.id === group.activeTabId)
  if (tab?.kind === 'terminal') getTerminal(paneKey(tab.id, tab.activeLeafId))?.term.focus()
  else (document.activeElement as HTMLElement | null)?.blur()
}

/**
 * The flags a newly added key gets: whatever the action's defaults have. A second key for Copy
 * should still go through to the program when nothing is selected, exactly as the first does.
 */
function flagsFor(defaults: Keymap, action: string): boolean {
  for (const b of defaults.values()) if (b.action === action) return b.performable
  return false
}
