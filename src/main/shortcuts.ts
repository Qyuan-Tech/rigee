import { app, webContents, type WebContents } from 'electron'
import { buildKeymap, defaultBinds, isTextEditingTrigger, lookupBinding, splitAction, type Keymap } from '@shared/keymap'
import { handle } from './ipc'
import { loadState } from './store'

/**
 * App shortcuts for keys that land in a page rather than in the shell.
 *
 * A browser tab is its own webContents — a native view composited over the shell — so while it has
 * the keyboard, not one keystroke reaches the shell's renderer: not xterm's hook, not the window
 * listener. Cmd+2 into a browser tab worked; Cmd+1 back out of it did nothing, nor did Cmd+W, Cmd+T
 * or Ctrl+Tab, and the only way out was the mouse.
 *
 * So every other webContents is watched here, before its page sees a key, and a chord that is an
 * APP shortcut in the user's keymap is taken from the page and run in the shell. It has to be
 * decided here and now — `before-input-event` cancels synchronously or not at all — which is why
 * main keeps its own copy of the keymap, built from the same pure module and the same saved lines
 * as the renderer's.
 *
 * Deliberately narrow, because every chord taken here is one a web page does not get:
 * - Only the keys a browser keeps for itself anyway — tabs, closing, a new tab — plus searching the
 *   workspace and opening the shortcuts. Not the workbench toggles: Cmd+B is bold in every web
 *   editor, Cmd+Option+2 is Heading 2 in Google Docs and Notion, Cmd+\\ clears formatting.
 * - Never a `performable:` or `unconsumed:` binding. Main cannot know whether the action would do
 *   anything, and it has to decide before the page sees the key.
 * - Never a key a text field edits with, and never plain typing.
 * - Never DevTools, which is somebody debugging.
 * - Matched against the user's real keyboard layout, which the renderer reports, and never a US
 *   guess: on a German layout the key a US keyboard calls `[` types `ü`.
 */
const FORWARDED = new Set([
  'new_tab',
  'close_surface',
  'close_tab',
  'goto_tab',
  'last_tab',
  'previous_tab',
  'next_tab',
  'search_workspace',
  'open_config'
])

/** Actions that move the keyboard into the shell's own UI — which the page must hand over. */
const TAKES_KEYBOARD = new Set(['search_workspace', 'open_config'])

let layout: Record<string, string> = {}

export function forwardShortcuts(shell: () => WebContents | null, run: (action: string) => void): void {
  handle('shortcuts:setLayout', ({ map }) => { layout = map })

  app.on('web-contents-created', (_event, wc) => {
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || (!input.meta && !input.control && !input.alt)) return
      const target = shell()
      // The shell dispatches its own keys, with focus and scope it alone knows.
      if (!target || target.isDestroyed() || wc === target) return
      if (webContents.getAllWebContents().some((other) => other.devToolsWebContents === wc)) return

      const binding = lookupBinding(
        currentKeymap(),
        { key: input.key, code: input.code, ctrlKey: input.control, metaKey: input.meta, altKey: input.alt, shiftKey: input.shift },
        (code) => layout[code],
        false
      )
      if (!binding || binding.performable || binding.unconsumed || isTextEditingTrigger(binding.trigger)) return
      const [name] = splitAction(binding.action)
      if (!FORWARDED.has(name)) return

      event.preventDefault()
      if (input.isAutoRepeat && name !== 'previous_tab' && name !== 'next_tab') return
      // A native view holds the keyboard until something takes it back; a search box the user is
      // about to type into cannot, from the DOM alone.
      if (TAKES_KEYBOARD.has(name)) target.focus()
      run(binding.action)
    })
  })
}

let cached: { binds: readonly string[] | undefined; keymap: Keymap } | null = null

/**
 * Rebuilt when the saved lines change. `saveKeybindings` replaces the array, so identity is the
 * whole test — and a keymap per keystroke would be the defaults parsed eighty times a second.
 */
function currentKeymap(): Keymap {
  const binds = loadState().keybindings.binds
  if (!cached || cached.binds !== binds) {
    cached = { binds, keymap: buildKeymap(defaultBinds(process.platform), binds ?? []).keymap }
  }
  return cached.keymap
}
