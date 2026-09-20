import { useEffect, useState } from 'react'
import { isMac, rpc } from '../ipc'
import { formatChord, parseChord } from '../keys'
import { useApp } from '../store'
import { DEFAULT_KEYBINDINGS, type KeyBindings } from '@shared/types'

/**
 * Key binding settings.
 *
 * The prefix is captured by listening for a real keypress rather than asking the user to type
 * `ctrl+a` as text — writing a chord out is a guessing game about spelling, and pressing it is
 * unambiguous. The action keys are single characters, so a plain text field is the right control
 * for those.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const stored = useApp((s) => s.keybindings)
  const setKeybindings = useApp((s) => s.setKeybindings)
  const [draft, setDraft] = useState<KeyBindings>(stored)
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      // Ignore a modifier pressed on its own; wait for the key it modifies.
      if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return
      const parts: string[] = []
      if (e.ctrlKey) parts.push('ctrl')
      if (e.altKey) parts.push('alt')
      if (e.shiftKey) parts.push('shift')
      if (e.metaKey) parts.push('cmd')
      parts.push(e.key.toLowerCase())
      setDraft((d) => ({ ...d, prefix: parts.join('+') }))
      setCapturing(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing])

  const valid = parseChord(draft.prefix) !== null &&
    [draft.splitRight, draft.splitDown, draft.closePane].every((k) => k.length === 1)

  const save = (): void => {
    if (!valid) return
    setKeybindings(draft)
    void rpc['state:saveKeybindings']({ keybindings: draft })
    onClose()
  }

  return (
    <div className="modal__scrim" onMouseDown={onClose}>
      <div className="modal" style={{ width: 420 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__title">Terminal key bindings</div>
        <div className="modal__body">
          Press the prefix, release it, then the action key — the way tmux works.
        </div>

        <label className="modal__field">
          <span>Prefix</span>
          <button
            className="btn"
            style={{ width: '100%', justifyContent: 'flex-start' }}
            onClick={() => setCapturing(true)}
          >
            {capturing ? 'press a key combination…' : formatChord(draft.prefix, isMac())}
          </button>
        </label>

        <Field
          label="Split right"
          value={draft.splitRight}
          onChange={(v) => setDraft((d) => ({ ...d, splitRight: v }))}
          prefix={draft.prefix}
        />
        <Field
          label="Split down"
          value={draft.splitDown}
          onChange={(v) => setDraft((d) => ({ ...d, splitDown: v }))}
          prefix={draft.prefix}
        />
        <Field
          label="Close pane"
          value={draft.closePane}
          onChange={(v) => setDraft((d) => ({ ...d, closePane: v }))}
          prefix={draft.prefix}
        />

        <div className="modal__actions">
          <button className="btn" onClick={() => setDraft({ ...DEFAULT_KEYBINDINGS })}>
            Reset
          </button>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={!valid} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  prefix
}: {
  label: string
  value: string
  onChange: (v: string) => void
  prefix: string
}): React.ReactElement {
  return (
    <label className="modal__field">
      <span>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="menu__hint" style={{ whiteSpace: 'nowrap' }}>
          {formatChord(prefix, isMac())} then
        </span>
        <input
          value={value}
          maxLength={1}
          spellCheck={false}
          style={{ width: 52, textAlign: 'center', fontFamily: 'var(--font-mono)' }}
          onChange={(e) => onChange(e.target.value.slice(-1))}
        />
      </div>
    </label>
  )
}
