import { loadXterm } from './lazy'
import { editorFontSize, monoFamily } from './fonts'
import { rpc } from './ipc'
import { useApp } from './store'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

/**
 * xterm.js instances, owned outside React.
 *
 * One instance per split pane, keyed by `<tabId>:<leafId>` — the leaf id from the tab's layout
 * tree, which exists before a pty does and survives the pty being replaced. Each gets a detached
 * <div> that lives as long as the pane does, so splitting, switching tabs or re-rendering the
 * layout re-parents an element rather than tearing the Terminal down: scrollback, cursor and the
 * WebGL glyph atlas all survive. None of this may go through the store, which would mean a React
 * render per output frame.
 */

export interface TerminalHandle {
  term: Terminal
  fit: FitAddon
  /** The element xterm rendered into; re-parented as the layout changes. */
  element: HTMLDivElement
  paneId: string | null
  /** The single live onData subscription; replaced, never stacked. */
  input: { dispose: () => void } | null
  dispose: () => void
}

const handles = new Map<string, TerminalHandle>()
/** Guards against two concurrent mounts racing to create the same terminal. */
const creating = new Map<string, Promise<TerminalHandle>>()

export const paneKey = (tabId: string, leafId: string): string => `${tabId}:${leafId}`

export function getTerminal(key: string): TerminalHandle | undefined {
  return handles.get(key)
}

export async function ensureTerminal(key: string): Promise<TerminalHandle> {
  const existing = handles.get(key)
  if (existing) return existing
  const inFlight = creating.get(key)
  if (inFlight) return inFlight

  const promise = (async (): Promise<TerminalHandle> => {
    const { Terminal, FitAddon, WebglAddon } = await loadXterm()

    const element = document.createElement('div')
    element.style.width = '100%'
    element.style.height = '100%'

    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: monoFamily(),
      fontSize: editorFontSize(),
      // Looser than xterm's 1.0 default: rows of dense monospace with no gap between them are
      // markedly harder to scan, and a terminal is mostly scanning.
      lineHeight: 1.35,
      // Leave letterSpacing at 0: a non-integer advance makes the WebGL atlas fall back to a
      // slow per-glyph path.
      letterSpacing: 0,
      cursorBlink: true,
      scrollback: 10000,
      // Same tokens as theme.css and the Monaco theme.
      theme: {
        background: '#20232e',
        foreground: '#c6ccdb',
        cursor: '#8b9aff',
        cursorAccent: '#20232e',
        // Opaque enough to find at a glance on the lighter surface. A selection you have to hunt
        // for is a selection people assume did not happen.
        selectionBackground: '#8b9aff59',
        black: '#2b2f3d',
        red: '#e8848c',
        green: '#7fce97',
        yellow: '#e3bb5e',
        blue: '#8b9aff',
        magenta: '#c49bfb',
        cyan: '#4dd8ef',
        white: '#c6ccdb',
        brightBlack: '#7c8499',
        brightRed: '#f09aa1',
        brightGreen: '#96dcab',
        brightYellow: '#efcd7e',
        brightBlue: '#a3afff',
        brightMagenta: '#d5b2fc',
        brightCyan: '#74e3f5',
        brightWhite: '#e7ebf5'
      }
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)

    // WebGL is the only renderer that keeps up with a firehose. It can lose its context (driver
    // reset, too many live contexts); fall back rather than leaving a blank pane.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl.dispose()
        console.warn(`[terminal ${key}] WebGL context lost; falling back to the DOM renderer`)
      })
      term.loadAddon(webgl)
    } catch (err) {
      console.warn(`[terminal ${key}] WebGL unavailable, using the DOM renderer:`, err)
    }

    const handle: TerminalHandle = {
      term,
      fit,
      element,
      paneId: null,
      input: null,
      dispose: () => {
        handles.delete(key)
        handle.input?.dispose()
        term.dispose()
        element.remove()
      }
    }
    handles.set(key, handle)
    creating.delete(key)
    return handle
  })()

  creating.set(key, promise)
  return promise
}

export function disposeTerminal(key: string): void {
  handles.get(key)?.dispose()
}

/** Dispose every pane belonging to a tab. Called when the tab closes. */
export function disposeTab(tabId: string): void {
  for (const key of [...handles.keys()]) {
    if (key.startsWith(`${tabId}:`)) disposeTerminal(key)
  }
}

/**
 * Drop terminals whose leaf has left the tree, after a close or a collapse.
 *
 * Keyed on the LEAF id, which is what the key encodes — comparing against `handle.paneId` would
 * compare a layout id with a pty id and silently reap everything.
 */
export function reapPanes(tabId: string, liveLeafIds: ReadonlySet<string>): void {
  const prefix = `${tabId}:`
  for (const key of [...handles.keys()]) {
    if (!key.startsWith(prefix)) continue
    if (!liveLeafIds.has(key.slice(prefix.length))) disposeTerminal(key)
  }
}

/** Whether this pane currently has a selection, for enabling a Copy menu item. */
export function paneSelection(key: string): string {
  return getTerminal(key)?.term.getSelection() ?? ''
}

/**
 * Copy the pane's selection. Returns false when there was nothing selected, so a key handler can
 * decide whether to swallow the keystroke or let it through.
 */
export function copyPane(key: string): boolean {
  const text = paneSelection(key)
  if (!text) return false
  void rpc['clipboard:write']({ text })
  return true
}

export async function pastePane(key: string): Promise<void> {
  const handle = getTerminal(key)
  if (!handle) return
  const text = await rpc['clipboard:read']()
  if (!text) return
  // term.paste, not writeTerminal: paste() applies bracketed-paste framing when the program has
  // asked for it. Without that a multi-line paste arrives at a shell as a sequence of Enters and
  // runs itself line by line, which is how a paste into a prompt turns into an accident.
  handle.term.paste(text)
}

/** Route a decoded pane frame to whichever terminal is bound to that pane. */
export function writeToPane(paneId: string, data: string): void {
  for (const handle of handles.values()) {
    if (handle.paneId === paneId) {
      handle.term.write(data)
      return
    }
  }
}

/**
 * Reap terminals whose tab has closed.
 *
 * Closing a pane is handled by the component, but closing the whole tab is not — the component
 * unmounts and nothing is left to run the teardown. Subscribing outside React keeps this off the
 * render path, the same arrangement browserViews.ts uses for native views.
 */
useApp.subscribe(
  (s) => s.tabsByWorkspace,
  (tabsByWorkspace) => {
    const live = new Set<string>()
    for (const tabs of Object.values(tabsByWorkspace)) {
      for (const t of tabs) live.add(t.id)
    }
    for (const [key, handle] of handles) {
      const tabId = key.slice(0, key.indexOf(':'))
      if (live.has(tabId)) continue
      if (handle.paneId) void rpc['terminal:kill']({ paneId: handle.paneId })
      disposeTerminal(key)
    }
  }
)
