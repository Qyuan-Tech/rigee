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
      lineHeight: 1.2,
      // Leave letterSpacing at 0: a non-integer advance makes the WebGL atlas fall back to a
      // slow per-glyph path.
      letterSpacing: 0,
      cursorBlink: true,
      scrollback: 10000,
      // Same tokens as theme.css and the Monaco theme.
      theme: {
        background: '#0e1118',
        foreground: '#c8cfdd',
        cursor: '#7c8cff',
        cursorAccent: '#0e1118',
        selectionBackground: '#7c8cff40',
        black: '#0b0e15',
        red: '#e06c75',
        green: '#6dc48a',
        yellow: '#e2b344',
        blue: '#7c8cff',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#c8cfdd',
        brightBlack: '#4a5263',
        brightRed: '#f08a92',
        brightGreen: '#8fd6a0',
        brightYellow: '#f0cb6b',
        brightBlue: '#9aa6ff',
        brightMagenta: '#d3a6fd',
        brightCyan: '#5ce0f5',
        brightWhite: '#f0f4fa'
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
