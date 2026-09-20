/**
 * Chord parsing for the terminal's tmux-style prefix bindings.
 *
 * A chord is written the way a user would type it: `ctrl+a`, `cmd+shift+p`, `alt+`` `. Only the
 * prefix is a chord; the keys pressed after it are single characters, because that is what tmux
 * does and what the muscle memory expects.
 */

export interface Chord {
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  /** Lower-cased, as `KeyboardEvent.key` reports it without Shift applied to letters. */
  key: string
}

export function parseChord(spec: string): Chord | null {
  const parts = spec
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null

  const chord: Chord = { ctrl: false, meta: false, alt: false, shift: false, key: '' }
  for (const part of parts) {
    switch (part) {
      case 'ctrl':
      case 'control': chord.ctrl = true; break
      case 'cmd':
      case 'meta':
      case 'command': chord.meta = true; break
      case 'alt':
      case 'option': chord.alt = true; break
      case 'shift': chord.shift = true; break
      default: chord.key = part
    }
  }
  return chord.key ? chord : null
}

export function matchesChord(e: KeyboardEvent, chord: Chord): boolean {
  return (
    e.ctrlKey === chord.ctrl &&
    e.metaKey === chord.meta &&
    e.altKey === chord.alt &&
    // Shift is not compared for punctuation, where the key itself already encodes it.
    (chord.shift ? e.shiftKey : true) &&
    e.key.toLowerCase() === chord.key
  )
}

/**
 * The bytes a chord would have sent to the shell had we not swallowed it, so that pressing the
 * prefix twice delivers a literal one — the same escape hatch tmux gives you for Ctrl-A at the
 * start of a line.
 */
export function chordBytes(chord: Chord): string {
  if (chord.ctrl && chord.key.length === 1) {
    const code = chord.key.toUpperCase().charCodeAt(0)
    // Ctrl-A..Ctrl-Z map to 0x01..0x1a; the handful of Ctrl-punctuation codes follow the same
    // "strip the top bits" rule.
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64)
  }
  if (chord.alt && chord.key.length === 1) return `\x1b${chord.key}`
  return chord.key.length === 1 ? chord.key : ''
}

/** Human-readable, for menus and the settings dialog. */
export function formatChord(spec: string, isMac: boolean): string {
  const chord = parseChord(spec)
  if (!chord) return spec
  const parts: string[] = []
  if (chord.ctrl) parts.push(isMac ? '⌃' : 'Ctrl')
  if (chord.alt) parts.push(isMac ? '⌥' : 'Alt')
  if (chord.shift) parts.push(isMac ? '⇧' : 'Shift')
  if (chord.meta) parts.push(isMac ? '⌘' : 'Win')
  parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key)
  return isMac ? parts.join('') : parts.join('+')
}
