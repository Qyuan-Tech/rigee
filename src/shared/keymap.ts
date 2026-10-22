/**
 * Keyboard shortcuts, written the way Ghostty writes them.
 *
 * The vocabulary is Ghostty's on purpose — `super+shift+d=new_split:down` — so a line can be
 * copied out of a Ghostty config and pasted into the settings dialog, and so the defaults below
 * can be checked line by line against `ghostty +list-keybinds --default`. The people this app is
 * for move between the two all day, and a chord that does one thing in Ghostty and another here
 * is a chord they stop trusting in both.
 *
 * Pure: no DOM, no store, no Electron. `pnpm panes:selftest` bundles it with nothing else.
 *
 * What is deliberately NOT here: sequences (`ctrl+a>n`), `global:` and `all:`. The tmux-style
 * prefix in keys.ts already covers sequences, and the other two are about windows Rigee does not
 * have. A line using any of them is rejected with a reason rather than half-honoured.
 */

import { t } from './l10n'

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export interface Mods {
  super: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export interface Trigger {
  mods: Mods
  /**
   * A Ghostty key name — `arrow_left`, `digit_1`, `enter` — which names a PHYSICAL key, or a
   * single character, which names whichever key TYPES that character on the current layout.
   * Characters are stored lower-cased; Ghostty compares them case-folded.
   */
  key: string
  physical: boolean
}

const noMods = (): Mods => ({ super: false, ctrl: false, alt: false, shift: false })

const MOD_ALIASES: Record<string, keyof Mods> = {
  super: 'super',
  cmd: 'super',
  command: 'super',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  opt: 'alt',
  option: 'alt',
  shift: 'shift'
}

/** Ghostty's physical key names: W3C `KeyboardEvent.code`, in snake_case. */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  'arrow_up', 'arrow_down', 'arrow_left', 'arrow_right',
  'page_up', 'page_down', 'home', 'end', 'insert', 'delete',
  'backspace', 'enter', 'tab', 'escape', 'space',
  'minus', 'equal', 'bracket_left', 'bracket_right', 'backslash', 'semicolon', 'quote',
  'comma', 'period', 'slash', 'backquote', 'intl_backslash',
  'numpad_enter', 'numpad_add', 'numpad_subtract', 'numpad_multiply', 'numpad_divide',
  'numpad_decimal', 'numpad_equal',
  'copy', 'paste',
  ...'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => `key_${c}`),
  ...Array.from({ length: 10 }, (_, i) => `digit_${i}`),
  ...Array.from({ length: 10 }, (_, i) => `numpad_${i}`),
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`)
])

/**
 * The names Ghostty 1.1 used and 1.2 still accepts, plus two spellings people reach for that
 * Ghostty itself rejects (`return`, `esc`). Accepting a name Ghostty would not is harmless;
 * rejecting one it would is a pasted config that silently does less than it says.
 */
const KEY_ALIASES: Record<string, { key: string; physical: boolean }> = {
  up: { key: 'arrow_up', physical: true },
  down: { key: 'arrow_down', physical: true },
  left: { key: 'arrow_left', physical: true },
  right: { key: 'arrow_right', physical: true },
  return: { key: 'enter', physical: true },
  esc: { key: 'escape', physical: true },
  plus: { key: '+', physical: false },
  left_bracket: { key: '[', physical: false },
  right_bracket: { key: ']', physical: false },
  grave_accent: { key: '`', physical: false },
  ...Object.fromEntries(
    ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].map((w, i) => [
      w,
      { key: String(i), physical: false }
    ])
  )
}

/**
 * `KeyboardEvent.code` to a Ghostty key name, the way Ghostty's `fromW3C` does it: try the name
 * lower-cased, then snake_case it at every capital or digit. `ArrowUp` → `arrow_up`, `Digit1` →
 * `digit_1`, `F12` → `f12`. Null for anything that is not a bindable key — modifiers included.
 */
export function codeToKeyName(code: string): string | null {
  if (!code) return null
  const lower = code.toLowerCase()
  if (NAMED_KEYS.has(lower)) return lower
  const snake = code.replace(/(?<=.)([A-Z0-9])/g, '_$1').toLowerCase()
  return NAMED_KEYS.has(snake) ? snake : null
}

function resolveKey(token: string): { key: string; physical: boolean } | null {
  const lower = token.toLowerCase()
  if (NAMED_KEYS.has(lower)) return { key: lower, physical: true }
  if ([...token].length === 1) return { key: lower, physical: false }
  const w3c = codeToKeyName(token)
  if (w3c) return { key: w3c, physical: true }
  return KEY_ALIASES[lower] ?? null
}

/**
 * Parse a trigger: modifiers and one key joined by `+`. An empty part is a literal `+`, so
 * `super++` is Cmd and the plus key. A repeated modifier or an unknown word is an error, as it is
 * in Ghostty.
 */
export function parseTrigger(spec: string): Trigger | null {
  const s = spec.trim()
  if (!s) return null
  let keyToken: string
  let modTokens: string[]
  if (s === '+') {
    keyToken = '+'
    modTokens = []
  } else if (s.endsWith('++')) {
    keyToken = '+'
    modTokens = s.slice(0, -2).split('+')
  } else {
    const parts = s.split('+')
    keyToken = parts.pop() ?? ''
    modTokens = parts
  }
  if (!keyToken) return null

  const mods = noMods()
  for (const raw of modTokens) {
    const which = MOD_ALIASES[raw.trim().toLowerCase()]
    if (!which || mods[which]) return null
    mods[which] = true
  }
  const key = resolveKey(keyToken.trim() || keyToken)
  return key ? { mods, ...key } : null
}

/** Back to Ghostty's own spelling, modifiers in its order. Round-trips through `parseTrigger`. */
export function triggerToString(t: Trigger): string {
  const mods = (['super', 'ctrl', 'alt', 'shift'] as const).filter((m) => t.mods[m])
  if (t.key === '+') return mods.length ? `${mods.join('+')}++` : '+'
  return [...mods, t.key].join('+')
}

/** Identity for lookups: two triggers are the same binding exactly when these are equal. */
export function triggerId(t: Trigger): string {
  const m = t.mods
  return `${m.super ? 'S' : ''}${m.ctrl ? 'C' : ''}${m.alt ? 'A' : ''}${m.shift ? 'H' : ''}|${t.physical ? 'p' : 'u'}:${t.key}`
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type ActionGroup =
  | 'Clipboard'
  | 'Editing'
  | 'Font'
  | 'Screen'
  | 'Tabs'
  | 'Splits'
  | 'Search'
  | 'Window'

export interface ActionSpec {
  /**
   * `terminal` runs only with a terminal focused — font size, splits, sending bytes. `app` runs
   * wherever the keyboard is, as long as nothing focused has claimed the key first.
   */
  scope: 'terminal' | 'app'
  group: ActionGroup
  /** Absent: takes no parameter. `hint` is what a parameter looks like, said when one is wrong. */
  param?: { required: boolean; valid: (p: string) => boolean; hint: () => string }
  /** What the shortcuts table calls it, in the language Rigee is in when asked. */
  label: (param: string) => string
  /**
   * Whether holding the key down repeats the action. Off for anything that opens, closes or
   * toggles: an auto-repeating Cmd+W closes every tab in the window before the finger lifts.
   */
  repeats: boolean
}

const DIRECTIONS = ['up', 'down', 'left', 'right'] as const
const isInt = (p: string): boolean => /^\d+$/.test(p) && Number(p) >= 1
const isNumber = (p: string): boolean => /^\d+(\.\d+)?$/.test(p) && Number(p) > 0
const oneOf = (...xs: string[]) => (p: string): boolean => xs.includes(p)

/** The actions Rigee implements, by Ghostty's name. Rigee's own additions are marked. */
export const ACTIONS: Record<string, ActionSpec> = {
  copy_to_clipboard: {
    scope: 'terminal',
    group: 'Clipboard',
    // Ghostty's formats. The terminal only ever copies text, so all four copy the same thing.
    param: { required: false, valid: oneOf('plain', 'mixed', 'vt', 'html'), hint: () => 'plain | mixed' },
    label: () => t('Copy'),
    repeats: false
  },
  paste_from_clipboard: { scope: 'terminal', group: 'Clipboard', label: () => t('Paste'), repeats: true },
  paste_from_selection: {
    scope: 'terminal',
    group: 'Clipboard',
    label: () => t('Paste the last selection'),
    repeats: true
  },

  text: {
    scope: 'terminal',
    group: 'Editing',
    param: { required: true, valid: (p) => decodeText(p) !== null, hint: () => t('text, with \\x escapes') },
    label: (p) => knownText(p) ?? t('Send “{text}”', { text: p }),
    repeats: true
  },
  esc: {
    scope: 'terminal',
    group: 'Editing',
    param: { required: true, valid: (p) => p.length > 0, hint: () => t('text after ESC') },
    label: (p) => knownEsc(p) ?? t('Send ESC {text}', { text: p }),
    repeats: true
  },
  csi: {
    scope: 'terminal',
    group: 'Editing',
    param: { required: true, valid: (p) => p.length > 0, hint: () => t('text after ESC [') },
    label: (p) => t('Send ESC [{text}', { text: p }),
    repeats: true
  },
  /** Rigee: a newline that does not submit. See `newlineBytes` in terminals.ts. */
  insert_newline: {
    scope: 'terminal',
    group: 'Editing',
    label: () => t('Insert a newline without submitting'),
    repeats: true
  },

  increase_font_size: {
    scope: 'terminal',
    group: 'Font',
    param: { required: false, valid: isNumber, hint: () => t('points') },
    label: () => t('Bigger text'),
    repeats: true
  },
  decrease_font_size: {
    scope: 'terminal',
    group: 'Font',
    param: { required: false, valid: isNumber, hint: () => t('points') },
    label: () => t('Smaller text'),
    repeats: true
  },
  reset_font_size: { scope: 'terminal', group: 'Font', label: () => t('Reset text size'), repeats: false },
  set_font_size: {
    scope: 'terminal',
    group: 'Font',
    param: { required: true, valid: isNumber, hint: () => t('points') },
    label: (p) => t('Text size {size}', { size: p }),
    repeats: false
  },

  clear_screen: { scope: 'terminal', group: 'Screen', label: () => t('Clear screen and scrollback'), repeats: false },
  select_all: { scope: 'terminal', group: 'Screen', label: () => t('Select all'), repeats: false },
  scroll_to_top: { scope: 'terminal', group: 'Screen', label: () => t('Scroll to top'), repeats: false },
  scroll_to_bottom: { scope: 'terminal', group: 'Screen', label: () => t('Scroll to bottom'), repeats: false },
  scroll_page_up: { scope: 'terminal', group: 'Screen', label: () => t('Scroll up a page'), repeats: true },
  scroll_page_down: { scope: 'terminal', group: 'Screen', label: () => t('Scroll down a page'), repeats: true },
  scroll_to_selection: {
    scope: 'terminal',
    group: 'Screen',
    label: () => t('Scroll to the selection'),
    repeats: false
  },

  new_tab: { scope: 'app', group: 'Tabs', label: () => t('New terminal tab'), repeats: false },
  /** Ghostty's "surface" is the focused split. Outside a terminal there is none, so it is the tab. */
  close_surface: { scope: 'app', group: 'Tabs', label: () => t('Close pane (or tab)'), repeats: false },
  close_tab: {
    scope: 'app',
    group: 'Tabs',
    // Ghostty's modes. As with the tab strip's menu, `other` and `right` reach every kind of tab.
    param: { required: false, valid: oneOf('this', 'other', 'right'), hint: () => 'this | other | right' },
    label: (p) =>
      p === 'other' ? t('Close the other tabs') : p === 'right' ? t('Close the tabs to the right') : t('Close tab'),
    repeats: false
  },
  goto_tab: {
    scope: 'app',
    group: 'Tabs',
    param: { required: true, valid: isInt, hint: () => '1, 2, 3…' },
    label: (p) => t('Go to tab {n}', { n: p }),
    repeats: false
  },
  last_tab: { scope: 'app', group: 'Tabs', label: () => t('Go to the last tab'), repeats: false },
  previous_tab: { scope: 'app', group: 'Tabs', label: () => t('Previous tab'), repeats: true },
  next_tab: { scope: 'app', group: 'Tabs', label: () => t('Next tab'), repeats: true },
  /** Rigee: the editor columns. Ghostty has no equivalent. */
  goto_group: {
    scope: 'app',
    group: 'Tabs',
    param: { required: true, valid: isInt, hint: () => '1, 2, 3…' },
    label: (p) => t('Go to column {n}', { n: p }),
    repeats: false
  },
  /** Rigee: VS Code's Split Editor, and Split Editor Down. Bare is right, as Cmd+\ always was. */
  split_group: {
    scope: 'app',
    group: 'Tabs',
    param: { required: false, valid: oneOf('right', 'down'), hint: () => 'right | down' },
    label: (p) => (p === 'down' ? t('Split into a new row') : t('Split into a new column')),
    repeats: false
  },

  new_split: {
    scope: 'terminal',
    group: 'Splits',
    // Optional, as in Ghostty, where a bare `new_split` means `auto`.
    param: { required: false, valid: oneOf(...DIRECTIONS, 'auto'), hint: () => 'right | down | left | up | auto' },
    label: (p) => splitLabel(p),
    repeats: false
  },
  goto_split: {
    scope: 'terminal',
    group: 'Splits',
    // `top` and `bottom` are Ghostty's other names for up and down.
    param: {
      required: true,
      valid: oneOf(...DIRECTIONS, 'top', 'bottom', 'previous', 'next'),
      hint: () => 'previous | next | up | down | left | right'
    },
    label: (p) => gotoSplitLabel(p),
    repeats: true
  },
  resize_split: {
    scope: 'terminal',
    group: 'Splits',
    param: {
      required: true,
      valid: (p) => {
        const [dir, px, ...rest] = p.split(',')
        return rest.length === 0 && (DIRECTIONS as readonly string[]).includes(dir ?? '') && isInt(px ?? '')
      },
      hint: () => t('direction,pixels')
    },
    label: (p) => resizeLabel(p.split(',')[0] ?? ''),
    repeats: true
  },
  equalize_splits: { scope: 'terminal', group: 'Splits', label: () => t('Make panes equal'), repeats: false },
  toggle_split_zoom: { scope: 'terminal', group: 'Splits', label: () => t('Zoom pane'), repeats: false },

  start_search: { scope: 'terminal', group: 'Search', label: () => t('Find'), repeats: false },
  search_selection: { scope: 'terminal', group: 'Search', label: () => t('Find the selection'), repeats: false },
  navigate_search: {
    scope: 'terminal',
    group: 'Search',
    param: { required: true, valid: oneOf('next', 'previous'), hint: () => 'next | previous' },
    label: (p) => (p === 'next' ? t('Next match') : t('Previous match')),
    repeats: true
  },
  end_search: { scope: 'terminal', group: 'Search', label: () => t('Close find'), repeats: false },
  /** Rigee: find in every file of the workspace, VS Code's Cmd+Shift+F. */
  search_workspace: { scope: 'app', group: 'Search', label: () => t('Search the workspace'), repeats: false },

  open_config: { scope: 'app', group: 'Window', label: () => t('Settings'), repeats: false },
  toggle_fullscreen: { scope: 'app', group: 'Window', label: () => t('Full screen'), repeats: false },
  /** Rigee: the side panels. */
  toggle_left_panel: { scope: 'app', group: 'Window', label: () => t('Show or hide the left panel'), repeats: false },
  toggle_right_panel: { scope: 'app', group: 'Window', label: () => t('Show or hide the right panel'), repeats: false },
  /** Swallow the key: it reaches neither the terminal nor anything else. */
  ignore: { scope: 'app', group: 'Window', label: () => t('Do nothing'), repeats: true }
}

/** What the line-editing bytes the defaults send are for, by the text they send. */
function knownText(p: string): string | null {
  switch (p) {
    case '\\x01': return t('Move to start of line')
    case '\\x05': return t('Move to end of line')
    case '\\x15': return t('Delete to start of line')
    case '\\x17': return t('Delete the word before the cursor')
    default: return null
  }
}

function knownEsc(p: string): string | null {
  return p === 'b' ? t('Move back one word') : p === 'f' ? t('Move forward one word') : null
}

function splitLabel(p: string): string {
  switch (p) {
    case 'right': return t('Split right')
    case 'down': return t('Split down')
    case 'left': return t('Split left')
    case 'up': return t('Split up')
    default: return t('Split the longer way')
  }
}

function gotoSplitLabel(p: string): string {
  if (p === 'previous') return t('Previous pane')
  if (p === 'next') return t('Next pane')
  switch (splitDirection(p)) {
    case 'up': return t('Pane up')
    case 'down': return t('Pane down')
    case 'left': return t('Pane left')
    case 'right': return t('Pane right')
  }
}

/** The divider's direction is whatever the line said, a wrong one included, so it is said back. */
function resizeLabel(direction: string): string {
  switch (direction) {
    case 'up': return t('Move divider up')
    case 'down': return t('Move divider down')
    case 'left': return t('Move divider left')
    case 'right': return t('Move divider right')
    default: return t('Move divider {direction}', { direction })
  }
}

/** The groups of the shortcuts table, as its headings say them. */
export function groupLabel(group: ActionGroup): string {
  switch (group) {
    case 'Clipboard': return t('Clipboard')
    case 'Editing': return t('Editing')
    case 'Font': return t('Font')
    case 'Screen': return t('Screen')
    case 'Tabs': return t('Tabs')
    case 'Splits': return t('Splits')
    case 'Search': return t('Search')
    case 'Window': return t('Window')
  }
}

/** A split direction as Ghostty spells it, with its aliases resolved: `top` is `up`. */
export function splitDirection(p: string): 'up' | 'down' | 'left' | 'right' {
  if (p === 'top') return 'up'
  if (p === 'bottom') return 'down'
  return p === 'down' || p === 'left' || p === 'right' ? p : 'up'
}

/** `goto_tab:3` → `['goto_tab', '3']`. The parameter is everything after the FIRST colon. */
export function splitAction(action: string): [name: string, param: string] {
  const i = action.indexOf(':')
  return i < 0 ? [action, ''] : [action.slice(0, i), action.slice(i + 1)]
}

export function actionSpec(action: string): ActionSpec | undefined {
  return ACTIONS[splitAction(action)[0]]
}

export function actionLabel(action: string): string {
  const [name, param] = splitAction(action)
  return ACTIONS[name]?.label(param) ?? action
}

/** Null when the action is unknown or its parameter is wrong; otherwise the reason is absent. */
export function validateAction(action: string): string | null {
  const [name, param] = splitAction(action)
  const spec = ACTIONS[name]
  if (!spec) return t('unknown action "{name}"', { name })
  if (!spec.param) return action.includes(':') ? t('{name} takes no parameter', { name }) : null
  if (!action.includes(':')) return spec.param.required ? t('{name} needs a parameter ({hint})', { name, hint: spec.param.hint() }) : null
  return spec.param.valid(param) ? null : t('bad parameter for {name}: expected {hint}', { name, hint: spec.param.hint() })
}

/**
 * The bytes of a `text:` parameter, which Ghostty reads as a Zig string literal: `\n \r \t \\ \'
 * \" \xNN \u{N…}`. Null when an escape is malformed, so a typo is an error in the settings dialog
 * rather than a key that quietly sends a backslash.
 */
export function decodeText(p: string): string | null {
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!
    if (c !== '\\') {
      out += c
      continue
    }
    const n = p[++i]
    switch (n) {
      case 'n': out += '\n'; break
      case 'r': out += '\r'; break
      case 't': out += '\t'; break
      case '\\': out += '\\'; break
      case "'": out += "'"; break
      case '"': out += '"'; break
      case 'x': {
        const hex = p.slice(i + 1, i + 3)
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null
        out += String.fromCodePoint(parseInt(hex, 16))
        i += 2
        break
      }
      case 'u': {
        const m = /^\{([0-9a-fA-F]{1,6})\}/.exec(p.slice(i + 1))
        if (!m) return null
        const cp = parseInt(m[1]!, 16)
        if (cp > 0x10ffff) return null
        out += String.fromCodePoint(cp)
        i += m[0].length
        break
      }
      default:
        return null
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export interface Binding {
  trigger: Trigger
  /** The action with its parameter, as written: `goto_tab:3`, `text:\x01`. */
  action: string
  /**
   * Ghostty's `performable:` — consume the key only if the action actually did something, and
   * otherwise let it through as if the binding were not there. It is what lets Cmd+C copy a
   * selection and still reach the program when nothing is selected.
   */
  performable: boolean
  /** Ghostty's `unconsumed:` — run the action AND let the key through. */
  unconsumed: boolean
}

export type BindLine =
  | { kind: 'bind'; binding: Binding }
  | { kind: 'unbind'; trigger: Trigger }
  /** `keybind = clear`: drop every binding, defaults included. */
  | { kind: 'clear' }
  /** `keybind =` with nothing after it: back to the defaults. */
  | { kind: 'reset' }
  | { kind: 'error'; message: string }

const FLAGS = ['performable', 'unconsumed', 'global', 'all'] as const

/**
 * One line of Ghostty keybind syntax: `[flags:]trigger=action[:param]`.
 *
 * Accepts the `keybind = ` prefix and surrounding quotes, so a line copied straight out of a
 * Ghostty config works. Null for a blank line or a comment.
 */
export function parseBindLine(input: string): BindLine | null {
  let s = input.trim()
  if (!s || s.startsWith('#')) return null

  const prefixed = /^keybind\s*=\s*(.*)$/.exec(s)
  if (prefixed) {
    s = prefixed[1]!.trim()
    if (!s) return { kind: 'reset' }
  }
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1)
  if (s === 'clear') return { kind: 'clear' }

  const flags = new Set<string>()
  for (;;) {
    const flag = FLAGS.find((f) => s.startsWith(`${f}:`))
    if (!flag) break
    flags.add(flag)
    s = s.slice(flag.length + 1)
  }
  if (flags.has('global') || flags.has('all')) {
    return { kind: 'error', message: t('"global:" and "all:" are not supported') }
  }

  // The first '=' not followed by '+' or '=' — Ghostty's rule, which is what lets `super+==…`
  // bind Cmd and the equals key.
  let eq = -1
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && s[i + 1] !== '+' && s[i + 1] !== '=') {
      eq = i
      break
    }
  }
  if (eq <= 0) return { kind: 'error', message: t('expected trigger=action') }

  const triggerSpec = s.slice(0, eq)
  const action = s.slice(eq + 1).trim()
  if (/[^+]>./.test(triggerSpec)) {
    return { kind: 'error', message: t('key sequences are not supported; the prefix setting does that') }
  }
  const trigger = parseTrigger(triggerSpec)
  if (!trigger) return { kind: 'error', message: t('cannot read the keys "{keys}"', { keys: triggerSpec }) }

  if (action === 'unbind') return { kind: 'unbind', trigger }
  const problem = validateAction(action)
  if (problem) return { kind: 'error', message: problem }
  return {
    kind: 'bind',
    binding: { trigger, action, performable: flags.has('performable'), unconsumed: flags.has('unconsumed') }
  }
}

export function bindingToString(b: Binding): string {
  return `${b.performable ? 'performable:' : ''}${b.unconsumed ? 'unconsumed:' : ''}${triggerToString(b.trigger)}=${b.action}`
}

export function sameBinding(a: Binding, b: Binding): boolean {
  return (
    triggerId(a.trigger) === triggerId(b.trigger) &&
    a.action === b.action &&
    a.performable === b.performable &&
    a.unconsumed === b.unconsumed
  )
}

// ---------------------------------------------------------------------------
// Keymaps
// ---------------------------------------------------------------------------

/** Keyed by `triggerId`. Insertion order is the order the dialog lists things in. */
export type Keymap = ReadonlyMap<string, Binding>

export interface KeymapError {
  line: string
  message: string
}

function parseAll(lines: readonly string[]): { parsed: Array<{ line: string; result: BindLine }>; errors: KeymapError[] } {
  const parsed: Array<{ line: string; result: BindLine }> = []
  const errors: KeymapError[] = []
  for (const line of lines) {
    const result = parseBindLine(line)
    if (!result) continue
    if (result.kind === 'error') errors.push({ line, message: result.message })
    else parsed.push({ line, result })
  }
  return { parsed, errors }
}

/**
 * The defaults, then the user's lines on top, in order — the last word on a trigger wins, which
 * is Ghostty's rule. A line that does not parse is reported and skipped rather than failing the
 * whole keymap: one typo must not take every shortcut away.
 */
export function buildKeymap(
  defaults: readonly string[],
  overrides: readonly string[]
): { keymap: Keymap; errors: KeymapError[] } {
  const base = parseAll(defaults)
  const map = new Map<string, Binding>()
  const applyDefaults = (): void => {
    map.clear()
    for (const { result } of base.parsed) if (result.kind === 'bind') map.set(triggerId(result.binding.trigger), result.binding)
  }
  applyDefaults()

  const user = parseAll(overrides)
  for (const { result } of user.parsed) {
    switch (result.kind) {
      case 'bind': {
        const id = triggerId(result.binding.trigger)
        // Re-inserted, so a rebound key moves to where the user put it rather than keeping the
        // default's slot — which would list it under whatever it used to do.
        map.delete(id)
        map.set(id, result.binding)
        break
      }
      case 'unbind': map.delete(triggerId(result.trigger)); break
      case 'clear': map.clear(); break
      case 'reset': applyDefaults(); break
    }
  }
  return { keymap: map, errors: [...base.errors, ...user.errors] }
}

/**
 * The fewest lines that turn `defaults` into `edited`: an `unbind` for each default that is gone,
 * and the binding itself for each one that is new or changed. This is what gets saved, so a
 * future release can change a default the user never touched and they get the new one.
 */
export function diffKeymap(defaults: Keymap, edited: Keymap): string[] {
  const unbinds: string[] = []
  const binds: string[] = []
  for (const [id, d] of defaults) {
    const e = edited.get(id)
    if (!e) unbinds.push(`${triggerToString(d.trigger)}=unbind`)
    else if (!sameBinding(d, e)) binds.push(bindingToString(e))
  }
  for (const [id, e] of edited) if (!defaults.has(id)) binds.push(bindingToString(e))
  return [...unbinds, ...binds]
}

/** Every trigger bound to exactly this action, in keymap order — for menu hints. */
export function triggersFor(keymap: Keymap, action: string): Trigger[] {
  const out: Trigger[] = []
  for (const b of keymap.values()) if (b.action === action) out.push(b.trigger)
  return out
}

// ---------------------------------------------------------------------------
// Matching a keypress
// ---------------------------------------------------------------------------

export interface KeyEventLike {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** What a physical key types with no modifiers on the current layout, if known. */
export type UnshiftedLookup = (code: string) => string | undefined

/** The US layout, for when the browser will not say. */
const US_UNSHIFTED: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  ...Object.fromEntries('abcdefghijklmnopqrstuvwxyz'.split('').map((c) => [`Key${c.toUpperCase()}`, c])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Digit${i}`, String(i)]))
}

export const usUnshifted: UnshiftedLookup = (code) => US_UNSHIFTED[code]

export function eventMods(e: KeyEventLike): Mods {
  return { super: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey }
}

/**
 * The binding a keypress triggers, found the way Ghostty finds it (`Binding.zig`, `getEvent`),
 * always with the full set of modifiers:
 *
 *   1. the physical key — `e.code` as a Ghostty key name;
 *   2. the character the key typed — `e.key`, when it is one character;
 *   3. the character it types unshifted — what makes Cmd+Shift+[ find `super+shift+[` although
 *      `e.key` says `{`, and Option+B find `alt+b` although macOS composed `∫`.
 *
 * One liberty over Ghostty, in step 2: a Shift that went into MAKING a symbol is not also a
 * modifier on it. Cmd+Shift+= types `+`, and `super++` should fire — in Ghostty it only does on
 * layouts with a key of its own for `+`, and on a US keyboard the chord falls through to the page
 * zoom in the menu instead, which is never what anybody pressing it wanted.
 */
export function lookupBinding(
  keymap: Keymap,
  e: KeyEventLike,
  unshifted: UnshiftedLookup = usUnshifted,
  /** Fill gaps in `unshifted` from the US layout. Off where the real layout is unknown and a wrong guess costs a keystroke. */
  usFallback = true
): Binding | null {
  const mods = eventMods(e)
  const get = (m: Mods, key: string, physical: boolean): Binding | undefined =>
    keymap.get(triggerId({ mods: m, key, physical }))

  const name = codeToKeyName(e.code)
  if (name) {
    const b = get(mods, name, true)
    if (b) return b
  }

  const base = e.code ? (unshifted(e.code) ?? (usFallback ? usUnshifted(e.code) : undefined))?.toLowerCase() : undefined
  const ch = [...e.key].length === 1 ? e.key.toLowerCase() : null
  if (ch) {
    const b = get(mods, ch, false)
    if (b) return b
  }
  if (base) {
    const b = get(mods, base, false)
    if (b) return b
  }
  // Last, so that anything spelled exactly — `super+shift+=`, which is what the settings dialog
  // records for that chord — wins over this reading of it.
  if (ch && mods.shift && ch.toLowerCase() === ch.toUpperCase() && ch !== base) {
    const b = get({ ...mods, shift: false }, ch, false)
    if (b) return b
  }
  return null
}

/**
 * Every spelling of the same physical keypress on a US layout: `super+digit_1` and `super+1`,
 * `super+key_k` and `super+k`, `super+bracket_left` and `super+[`. Two bindings that differ only in
 * spelling are one key, and only one of them can ever fire — the dialog uses this to keep the
 * table from showing a chord under two actions.
 */
export function triggerAliases(t: Trigger): string[] {
  const ids = new Set([triggerId(t)])
  const code = t.physical ? physicalToCode(t.key) : charToCode(t.key)
  if (code) {
    const name = codeToKeyName(code)
    const char = US_UNSHIFTED[code]
    if (name) ids.add(triggerId({ mods: t.mods, key: name, physical: true }))
    if (char) ids.add(triggerId({ mods: t.mods, key: char, physical: false }))
  }
  return [...ids]
}

function physicalToCode(name: string): string | undefined {
  return Object.keys(US_UNSHIFTED).find((code) => codeToKeyName(code) === name)
}

function charToCode(char: string): string | undefined {
  return Object.keys(US_UNSHIFTED).find((code) => US_UNSHIFTED[code] === char)
}

/**
 * Keys a text field needs for itself: moving the caret, selecting, deleting, Enter, and anything
 * that types with at most Shift held. A window-level shortcut on one of these must leave an input
 * alone — Ctrl+Shift+Left selects a word in the commit box, it does not switch tabs.
 */
export function isTextEditingTrigger(t: Trigger): boolean {
  const plain = !t.mods.super && !t.mods.ctrl && !t.mods.alt
  if (!t.physical) return plain
  // With any modifiers: moving and selecting (Ctrl+Shift+Left is select-a-word), deleting, and
  // Enter, which a form submits with Cmd held.
  if (/^(arrow_|home$|end$|backspace$|delete$|enter$|numpad_enter$)/.test(t.key)) return true
  // Only unmodified (or with Shift): Ctrl+Tab and Ctrl+PgDn mean nothing to a text box, and are
  // how you get to the next tab from inside one.
  return plain && /^(tab$|space$|page_)/.test(t.key)
}

/**
 * The trigger to record for a keypress in the settings dialog.
 *
 * Keys that type something are recorded by what they type unshifted (`super+shift+[`, not
 * `super+{`), because that is how people think of them and how Ghostty spells them; the rest —
 * arrows, Enter, F-keys — by their physical name. Null for a modifier on its own.
 */
export function triggerFromEvent(e: KeyEventLike, unshifted: UnshiftedLookup = usUnshifted): Trigger | null {
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Fn', 'Dead', 'Process'].includes(e.key) && !e.code) return null
  if (/^(Shift|Control|Alt|Meta|OS|CapsLock|Fn)(Left|Right)?$/.test(e.code)) return null
  const mods = eventMods(e)
  const base = e.code ? (unshifted(e.code) ?? usUnshifted(e.code)) : undefined
  if (base && [...base].length === 1) return { mods, key: base.toLowerCase(), physical: false }
  const name = codeToKeyName(e.code)
  if (name) return { mods, key: name, physical: true }
  if ([...e.key].length === 1) return { mods, key: e.key.toLowerCase(), physical: false }
  return null
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const KEY_LABELS: Record<string, [mac: string, other: string]> = {
  arrow_left: ['←', 'Left'],
  arrow_right: ['→', 'Right'],
  arrow_up: ['↑', 'Up'],
  arrow_down: ['↓', 'Down'],
  enter: ['↩', 'Enter'],
  numpad_enter: ['⌤', 'Num Enter'],
  backspace: ['⌫', 'Backspace'],
  delete: ['⌦', 'Delete'],
  escape: ['Esc', 'Esc'],
  tab: ['⇥', 'Tab'],
  space: ['Space', 'Space'],
  page_up: ['PgUp', 'PgUp'],
  page_down: ['PgDn', 'PgDn'],
  home: ['Home', 'Home'],
  end: ['End', 'End'],
  insert: ['Ins', 'Insert'],
  copy: ['Copy', 'Copy'],
  paste: ['Paste', 'Paste'],
  minus: ['-', '-'],
  equal: ['=', '='],
  bracket_left: ['[', '['],
  bracket_right: [']', ']'],
  backslash: ['\\', '\\'],
  semicolon: [';', ';'],
  quote: ["'", "'"],
  comma: [',', ','],
  period: ['.', '.'],
  slash: ['/', '/'],
  backquote: ['`', '`']
}

function keyLabel(t: Trigger, isMac: boolean): string {
  if (!t.physical) return t.key === ' ' ? 'Space' : t.key.toUpperCase()
  const known = KEY_LABELS[t.key]
  if (known) return isMac ? known[0] : known[1]
  let m: RegExpExecArray | null
  if ((m = /^key_([a-z])$/.exec(t.key))) return m[1]!.toUpperCase()
  if ((m = /^digit_(\d)$/.exec(t.key))) return m[1]!
  if ((m = /^numpad_(.+)$/.exec(t.key))) return `Num ${m[1]}`
  if (/^f\d+$/.test(t.key)) return t.key.toUpperCase()
  return t.key
}

/** For people: `⌃⌥⇧⌘D` on a Mac, `Ctrl+Shift+D` elsewhere — each platform's own convention. */
export function formatTrigger(t: Trigger, isMac: boolean): string {
  const key = keyLabel(t, isMac)
  if (isMac) {
    return `${t.mods.ctrl ? '⌃' : ''}${t.mods.alt ? '⌥' : ''}${t.mods.shift ? '⇧' : ''}${t.mods.super ? '⌘' : ''}${key}`
  }
  const parts: string[] = []
  if (t.mods.ctrl) parts.push('Ctrl')
  if (t.mods.alt) parts.push('Alt')
  if (t.mods.shift) parts.push('Shift')
  if (t.mods.super) parts.push('Super')
  parts.push(key)
  return parts.join('+')
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i)

/**
 * macOS: Ghostty 1.3.1's defaults (`ghostty +list-keybinds --default`) for every action Rigee
 * implements, with Ghostty's `performable:` flags, which that listing does not print. Then Rigee's
 * own, on keys Ghostty leaves free.
 *
 * Left out, because Rigee has nothing for them to do: jump_to_prompt (needs shell integration),
 * adjust_selection, undo/redo, new_window, write_screen_file, the command palette, the inspector
 * (Cmd+Option+I still opens DevTools, from the menu) and quit (Cmd+Q, also the menu).
 */
const MAC_DEFAULTS: readonly string[] = [
  // Clipboard
  'performable:super+c=copy_to_clipboard',
  'performable:super+v=paste_from_clipboard',
  'super+shift+v=paste_from_selection',
  'copy=copy_to_clipboard',
  'paste=paste_from_clipboard',
  // Line editing — the readline keys, reached the way every other macOS text field reaches them
  'super+arrow_left=text:\\x01',
  'super+arrow_right=text:\\x05',
  'super+backspace=text:\\x15',
  'alt+arrow_left=esc:b',
  'alt+arrow_right=esc:f',
  // Rigee: Ghostty gets this from the kitty keyboard protocol, which xterm.js does not speak.
  // Keypad Enter too — it is Fn+Return on a laptop.
  'shift+enter=insert_newline',
  'shift+numpad_enter=insert_newline',
  // Font
  'super+==increase_font_size:1',
  'super++=increase_font_size:1',
  'super+-=decrease_font_size:1',
  'super+0=reset_font_size',
  // Screen
  'performable:super+k=clear_screen',
  'super+a=select_all',
  'super+home=scroll_to_top',
  'super+end=scroll_to_bottom',
  'super+page_up=scroll_page_up',
  'super+page_down=scroll_page_down',
  'performable:super+j=scroll_to_selection',
  // Tabs
  'super+t=new_tab',
  'super+w=close_surface',
  'super+alt+w=close_tab',
  // Both spellings, as Ghostty has them: the physical key for the digit row on any layout, the
  // character for the numeric keypad, which types the same digit from a different key.
  ...range(1, 8).flatMap((n) => [`super+digit_${n}=goto_tab:${n}`, `super+${n}=goto_tab:${n}`]),
  'super+digit_9=last_tab',
  'super+9=last_tab',
  'super+shift+[=previous_tab',
  'super+shift+]=next_tab',
  'ctrl+shift+tab=previous_tab',
  'ctrl+tab=next_tab',
  // Splits
  'super+d=new_split:right',
  'super+shift+d=new_split:down',
  'super+[=goto_split:previous',
  'super+]=goto_split:next',
  ...(['up', 'down', 'left', 'right'] as const).map((d) => `super+alt+arrow_${d}=goto_split:${d}`),
  ...(['up', 'down', 'left', 'right'] as const).map((d) => `super+ctrl+arrow_${d}=resize_split:${d},10`),
  'super+ctrl+==equalize_splits',
  'super+shift+enter=toggle_split_zoom',
  // Search
  'performable:super+f=start_search',
  'performable:super+e=search_selection',
  'performable:super+g=navigate_search:next',
  'performable:super+shift+g=navigate_search:previous',
  'performable:escape=end_search',
  // Rigee: VS Code's key for searching every file. Ghostty spends it on closing the terminal's
  // find bar, which Escape does as well.
  'super+shift+f=search_workspace',
  // Window
  'super+,=open_config',
  'super+enter=toggle_fullscreen',
  'super+ctrl+f=toggle_fullscreen',
  // Rigee: the workbench. Cmd+B and Cmd+\ are VS Code's; Cmd+Option+B is VS Code's secondary
  // side bar. Columns moved off Cmd+1…9 when that went to tabs, as it is in Ghostty.
  'super+b=toggle_left_panel',
  'super+alt+b=toggle_right_panel',
  'super+\\=split_group',
  ...range(1, 9).map((n) => `super+alt+digit_${n}=goto_group:${n}`)
]

/**
 * Windows and Linux: Ghostty's non-macOS defaults (Config.zig, the GTK set) for the same actions.
 * Ctrl+Shift, because plain Ctrl+letter belongs to the shell — Ctrl+C is SIGINT, Ctrl+W deletes a
 * word, Ctrl+D is EOF.
 *
 * Two departures: Ghostty's Ctrl+Enter for full screen is Claude Code's "send now", so full screen
 * is F11 as it is in every browser; and Rigee's own workbench keys stay off plain Ctrl for the
 * same reason as everything else here.
 */
const OTHER_DEFAULTS: readonly string[] = [
  // Clipboard
  'performable:ctrl+shift+c=copy_to_clipboard',
  'performable:ctrl+shift+v=paste_from_clipboard',
  'ctrl+insert=copy_to_clipboard',
  'shift+insert=paste_from_selection',
  'copy=copy_to_clipboard',
  'paste=paste_from_clipboard',
  // Rigee
  'shift+enter=insert_newline',
  'shift+numpad_enter=insert_newline',
  // Font
  'ctrl+==increase_font_size:1',
  'ctrl++=increase_font_size:1',
  'ctrl+-=decrease_font_size:1',
  'ctrl+0=reset_font_size',
  // Screen
  'ctrl+shift+a=select_all',
  'shift+home=scroll_to_top',
  'shift+end=scroll_to_bottom',
  'shift+page_up=scroll_page_up',
  'shift+page_down=scroll_page_down',
  // Tabs
  'ctrl+shift+t=new_tab',
  'ctrl+shift+w=close_tab',
  ...range(1, 8).flatMap((n) => [`performable:alt+digit_${n}=goto_tab:${n}`, `performable:alt+${n}=goto_tab:${n}`]),
  'performable:alt+digit_9=last_tab',
  'performable:alt+9=last_tab',
  'ctrl+tab=next_tab',
  'ctrl+shift+tab=previous_tab',
  'performable:ctrl+page_down=next_tab',
  'performable:ctrl+page_up=previous_tab',
  'performable:ctrl+shift+arrow_right=next_tab',
  'performable:ctrl+shift+arrow_left=previous_tab',
  // Splits
  'ctrl+shift+o=new_split:right',
  'ctrl+shift+e=new_split:down',
  'performable:super+ctrl+[=goto_split:previous',
  'performable:super+ctrl+]=goto_split:next',
  ...(['up', 'down', 'left', 'right'] as const).map((d) => `performable:ctrl+alt+arrow_${d}=goto_split:${d}`),
  ...(['up', 'down', 'left', 'right'] as const).map((d) => `performable:super+ctrl+shift+arrow_${d}=resize_split:${d},10`),
  'ctrl+shift+enter=toggle_split_zoom',
  // Search
  'performable:ctrl+shift+f=start_search',
  'performable:escape=end_search',
  // Rigee: searching every file. Not VS Code's Ctrl+Shift+F, which is Ghostty's terminal find here.
  'ctrl+shift+alt+f=search_workspace',
  // Window
  'ctrl+,=open_config',
  'f11=toggle_fullscreen',
  // Rigee: the workbench. Nothing on Ctrl+Alt+<key that types>: on Windows that chord IS AltGr, and
  // AltGr+7 is how a German keyboard types `{`. Ctrl+Shift+G was the right panel's key before
  // Ghostty's set arrived, and Ghostty leaves it free here.
  'ctrl+shift+b=toggle_left_panel',
  'ctrl+shift+g=toggle_right_panel',
  'ctrl+shift+backslash=split_group',
  ...range(1, 9).map((n) => `alt+shift+digit_${n}=goto_group:${n}`)
]

/**
 * Windows keeps Shift+Insert as the paste it has been since before the clipboard had a key of its
 * own — conhost, Windows Terminal and every text field. Ghostty's selection paste there is an X11
 * idea, and Windows has no selection to paste.
 */
const WINDOWS_DEFAULTS: readonly string[] = OTHER_DEFAULTS.map((line) =>
  line === 'shift+insert=paste_from_selection' ? 'shift+insert=paste_from_clipboard' : line
)

/** `platform` is `process.platform`'s answer: 'darwin', 'win32', 'linux'. */
export function defaultBinds(platform: string): readonly string[] {
  if (platform === 'darwin') return MAC_DEFAULTS
  return platform === 'win32' ? WINDOWS_DEFAULTS : OTHER_DEFAULTS
}
