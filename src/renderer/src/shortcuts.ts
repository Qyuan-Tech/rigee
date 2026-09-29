import { useEffect, useMemo } from 'react'
import { activeGroup } from './groups'
import { onEvent, platform, rpc } from './ipc'
import {
  actionSpec,
  buildKeymap,
  defaultBinds,
  isTextEditingTrigger,
  lookupBinding,
  splitAction,
  type Binding,
  type Keymap,
  type KeymapError,
  type UnshiftedLookup
} from '@shared/keymap'
import { newTerminalTab, rowOf, useApp } from './store'
import { closeTabsSafely, revealView } from './editing'
import { closeTerminalPane, getTerminal, inheritFontSize, paneKey } from './terminals'

/**
 * The shortcuts at runtime: which keymap is live, what a keypress means, and the actions that do
 * not need a terminal to run.
 *
 * Two places dispatch, and in a fixed order. A focused terminal goes first, from xterm's key hook
 * in TerminalPane — it has to, because xterm turns a key into bytes before the event ever reaches
 * the window, and on Windows and Linux it would turn Ctrl+Shift+T into a control character and
 * stop the event dead. Everything else lands in the window listener below, which only acts on
 * keys nobody before it claimed: a terminal, Monaco and the PDF viewer all call preventDefault on
 * what they handle, and that is the signal. The same test is what keeps Electron's default menu
 * from ALSO acting on a key we handled — Cmd+V pasting twice was exactly that.
 */

// --- layout ------------------------------------------------------------------

interface KeyboardLayoutMap {
  get(code: string): string | undefined
}

interface NavigatorKeyboard {
  getLayoutMap?(): Promise<KeyboardLayoutMap>
  addEventListener?: EventTarget['addEventListener']
}

let layout: KeyboardLayoutMap | null = null

/**
 * What each key types unshifted on the user's actual layout, from the Keyboard Map API, which
 * Electron supports. Loaded at boot, and again whenever the window regains focus — the moment
 * after the user may have switched layouts in the menu bar. Until it arrives the US layout stands
 * in, which is right for the letters and digits on nearly every Latin layout.
 *
 * Every part of this is optional. Chromium's `layoutchange` event exists only behind a flag, and
 * in Electron 44 `navigator.keyboard` is not even an EventTarget: calling addEventListener on it
 * threw at module load and took the whole renderer down with it.
 */
export function loadKeyboardLayout(): void {
  const keyboard = (navigator as Navigator & { keyboard?: NavigatorKeyboard }).keyboard
  if (typeof keyboard?.getLayoutMap !== 'function') return
  const load = (): void => {
    keyboard.getLayoutMap!().then(
      (map) => {
        layout = map
        // Main matches keys pressed in browser pages and needs the same answer.
        const entries: Record<string, string> = {}
        ;(map as unknown as Map<string, string>).forEach((value, code) => { entries[code] = value })
        void rpc['shortcuts:setLayout']({ map: entries })
      },
      () => { /* keep the US fallback */ }
    )
  }
  load()
  if (typeof keyboard.addEventListener === 'function') keyboard.addEventListener('layoutchange', load)
  window.addEventListener('focus', load)
}

export const unshiftedKey: UnshiftedLookup = (code) => layout?.get(code)

// --- the live keymap -----------------------------------------------------------

const EMPTY: readonly string[] = []
const built = new WeakMap<readonly string[], { keymap: Keymap; errors: KeymapError[] }>()

/** Built once per distinct list of user lines; the store hands out the same array until a save. */
export function keymapFor(binds: readonly string[] | undefined): { keymap: Keymap; errors: KeymapError[] } {
  const lines = binds ?? EMPTY
  let hit = built.get(lines)
  if (!hit) {
    hit = buildKeymap(defaultBinds(platform()), lines)
    built.set(lines, hit)
  }
  return hit
}

export const currentKeymap = (): Keymap => keymapFor(useApp.getState().keybindings.binds).keymap

export function useKeymap(): Keymap {
  const binds = useApp((s) => s.keybindings.binds)
  return useMemo(() => keymapFor(binds).keymap, [binds])
}

/**
 * The binding a keydown triggers, or null.
 *
 * Nothing while an input method is composing — the key belongs to the IME, and for someone typing
 * Chinese an Enter mid-composition is "commit this", not a shortcut. Nothing for AltGr either,
 * which Windows reports as Ctrl+Alt: AltGr+Q is how a German keyboard types `@`.
 */
export function lookupShortcut(e: KeyboardEvent): Binding | null {
  if (e.isComposing || e.keyCode === 229) return null
  if (e.getModifierState?.('AltGraph')) return null
  return lookupBinding(currentKeymap(), e, unshiftedKey)
}

/**
 * Keydowns a terminal has already dispatched a binding for.
 *
 * `defaultPrevented` is how the window listener normally knows, but an `unconsumed:` binding is
 * meant to let the key through, so it is not cancelled — and without this the window listener
 * would look the same key up and run the same action a second time.
 */
const dispatched = new WeakSet<KeyboardEvent>()
export const markDispatched = (e: KeyboardEvent): void => { dispatched.add(e) }

/**
 * What the first press of a held key did, so its auto-repeats do the same.
 *
 * A binding that must not repeat — Cmd+W — swallows its repeats rather than acting again. But a
 * `performable:` binding whose first press passed through to the program has to keep passing
 * through: holding Escape with no search open is a stream of ESCs to the program, not one.
 */
let held: { code: string; key: string; consumed: boolean } | null = null

/** Null for a fresh press; otherwise whether the press that started this repeat was consumed. */
export function repeatOutcome(e: KeyboardEvent): boolean | null {
  if (!e.repeat) return null
  return held && held.code === e.code && held.key === e.key ? held.consumed : null
}

export function rememberPress(e: KeyboardEvent, consumed: boolean): void {
  if (!e.repeat) held = { code: e.code, key: e.key, consumed }
}

/**
 * Every fresh press starts out "consumed", before anybody sees it; only a path that deliberately
 * lets the key through says otherwise. Without this reset, a press answered by something that
 * does not keep this record — the find box's own Escape, the prefix — inherited whatever the LAST
 * key did, and a held Escape that had just closed the find bar went on to interrupt the program.
 */
function resetPress(e: KeyboardEvent): void {
  if (!e.repeat) held = { code: e.code, key: e.key, consumed: true }
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

// --- actions that need no terminal ----------------------------------------------

/**
 * Run an app-scope action. True when it did something, which is what `performable:` bindings ask.
 *
 * `fromTerminal` is the pane the key was pressed in, when it was: a tab opened from a pane you had
 * zoomed into opens at that size, as it does in Ghostty.
 */
export function runAppAction(action: string, fromTerminal: string | null = null): boolean {
  const [name, param] = splitAction(action)
  const s = useApp.getState()

  switch (name) {
    case 'ignore':
      return true
    case 'open_config':
      s.setSettingsOpen(true)
      return true
    case 'toggle_fullscreen':
      void rpc['window:toggleFullScreen']()
      return true
    case 'toggle_left_panel':
      s.setLayout({ leftCollapsed: !s.layout.leftCollapsed })
      return true
    case 'toggle_right_panel':
      s.setLayout({ rightCollapsed: !s.layout.rightCollapsed })
      return true
    case 'search_workspace':
      return revealView('search.panel')
  }

  const ws = s.activeWorkspaceId
  if (!ws) return false
  const row = rowOf(s, ws)
  const group = activeGroup(row)
  const tabs = group.tabs
  const at = tabs.findIndex((t) => t.id === group.activeTabId)

  // Showing a tab by index. Not "performed" when it is already the one showing: that is what lets
  // Linux's `performable:alt+1` reach the shell as Alt+1 in a window with one tab, as in Ghostty.
  const show = (index: number): boolean => {
    const target = tabs[index]
    if (!target || index === at) return false
    s.setActiveTab(ws, target.id)
    return true
  }

  switch (name) {
    case 'new_tab': {
      const tab = newTerminalTab()
      if (tab.kind === 'terminal') inheritFontSize(paneKey(tab.id, tab.activeLeafId), fromTerminal)
      s.openTab(ws, tab)
      return true
    }
    // Inside a terminal, TerminalPane answers close_surface before it gets here. Out here — the
    // keyboard on the explorer, on <body>, in a browser page — a terminal tab still closes one
    // pane, the one it would type into, and not every split and every process in it at once.
    case 'close_surface': {
      const tab = tabs[at]
      if (!tab) return false
      if (tab.kind === 'terminal') closeTerminalPane(ws, tab.id, tab.activeLeafId)
      else void closeTabsSafely(ws, [tab.id])
      return true
    }
    case 'close_tab':
      if (!group.activeTabId) return false
      void closeTabsSafely(ws, [group.activeTabId])
      return true
    case 'goto_tab':
      // Clamped to the last tab, as Ghostty's is: Cmd+8 with three tabs open goes to the third.
      return tabs.length > 0 && show(Math.min(Number(param), tabs.length) - 1)
    case 'last_tab':
      return show(tabs.length - 1)
    case 'previous_tab':
    case 'next_tab':
      if (tabs.length < 2) return false
      return show((Math.max(at, 0) + (name === 'next_tab' ? 1 : -1) + tabs.length) % tabs.length)
    case 'goto_group': {
      const target = row.groups[Number(param) - 1]
      if (!target) return false
      s.focusGroup(ws, target.id)
      focusGroupContent(target.id, target.tabs.find((t) => t.id === target.activeTabId))
      return true
    }
    case 'split_group':
      s.splitTab(ws)
      return true
  }
  return false
}

/**
 * Give a column the keyboard along with the highlight.
 *
 * Focusing a column changes nothing about its tab, so nothing in it takes the keyboard by itself
 * — and a keyboard left in the OLD column's terminal means the next Cmd+W closes that terminal
 * instead of the file in the column the user just moved to. A terminal is focused directly;
 * anything else gets its first focusable element outside the tab strip — Monaco's input area, a
 * viewer — or, failing that, the old focus is simply dropped so keys at least reach the window.
 */
function focusGroupContent(groupId: string, tab: { id: string; kind: string; activeLeafId?: string } | undefined): void {
  if (tab?.kind === 'terminal' && tab.activeLeafId) {
    getTerminal(paneKey(tab.id, tab.activeLeafId))?.term.focus()
    return
  }
  const column = document.querySelector<HTMLElement>(`[data-group-id="${CSS.escape(groupId)}"]`)
  // An editor's own surface, never a text box: a browser tab's address bar is focusable too, and
  // landing in it would turn the next keystrokes into a URL. A browser tab has nothing else in the
  // DOM — its page is a native view — so there the old focus is dropped and the tab takes the
  // keyboard itself, as it does whenever it becomes the focused tab.
  const inside = [...(column?.querySelectorAll<HTMLElement>('textarea, [tabindex]:not([tabindex="-1"])') ?? [])].find(
    (el) => !el.closest('.tabstrip') && !el.hasAttribute('disabled')
  )
  if (inside) inside.focus()
  else (document.activeElement as HTMLElement | null)?.blur()
}

/**
 * The window-level half of the dispatch: app actions, for keys nothing focused has claimed.
 *
 * Suspended while the shortcuts dialog is open, so pressing a chord to record it does not also
 * close the tab behind the dialog; the dialog answers the few keys it needs itself.
 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || dispatched.has(e) || useApp.getState().settingsOpen) return
      const binding = lookupShortcut(e)
      if (!binding) return
      const spec = actionSpec(binding.action)
      // Terminal actions run from the terminal's own key hook; with no terminal focused there is
      // nothing for them to act on, and the key is left for whoever else wants it.
      if (!spec || spec.scope !== 'app') return
      // A text field keeps its own editing keys: Ctrl+Shift+Left selects a word in the commit box,
      // and Cmd+Enter in the address bar is not a request to go full screen.
      if (isEditable(e.target) && isTextEditingTrigger(binding.trigger)) return

      if (e.repeat && !spec.repeats) {
        // Swallowed unless the first press went through; unknown counts as swallowed.
        if (repeatOutcome(e) !== false) e.preventDefault()
        return
      }
      const performed = runAppAction(binding.action)
      const consumed = !((!performed && binding.performable) || binding.unconsumed)
      rememberPress(e, consumed)
      if (consumed) e.preventDefault()
    }
    window.addEventListener('keydown', resetPress, true)
    window.addEventListener('keydown', onKey)
    // The same actions, for keys pressed in a browser page and matched in main.
    const offForwarded = onEvent('shortcuts:run', ({ action }) => {
      if (!useApp.getState().settingsOpen) runAppAction(action)
    })
    return () => {
      window.removeEventListener('keydown', resetPress, true)
      window.removeEventListener('keydown', onKey)
      offForwarded()
    }
  }, [])
}
