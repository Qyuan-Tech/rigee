import { loadXterm } from './lazy'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { editorFontSize, monoFamily } from './fonts'

/**
 * xterm.js instances, owned outside React.
 *
 * Each terminal gets a detached <div> that persists for the lifetime of its tab. Switching tabs
 * moves that element between parents instead of tearing the Terminal down, so scrollback, cursor
 * position and the WebGL glyph atlas all survive. Putting any of this in the store would mean a
 * React render per output frame.
 */

export interface TerminalHandle {
  term: Terminal
  fit: FitAddon
  /** The element xterm rendered into; re-parented on tab switch. */
  element: HTMLDivElement
  paneId: string | null
  /** The single live onData subscription; replaced, never stacked, when the effect re-runs. */
  input: { dispose: () => void } | null
  dispose: () => void
}

const handles = new Map<string, TerminalHandle>()
/** Guards against two concurrent mounts racing to create the same terminal. */
const creating = new Map<string, Promise<TerminalHandle>>()



export function getTerminal(tabId: string): TerminalHandle | undefined {
  return handles.get(tabId)
}

export async function ensureTerminal(tabId: string): Promise<TerminalHandle> {
  const existing = handles.get(tabId)
  if (existing) return existing
  const inFlight = creating.get(tabId)
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
      // Leave letterSpacing at 0: any non-integer advance makes the WebGL atlas fall back to a
      // slow per-glyph path.
      letterSpacing: 0,
      cursorBlink: true,
      scrollback: 10000,
      // Same tokens as theme.css and the Monaco theme: the terminal must not look like a
      // different application pasted into the middle of the window.
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
        console.warn(`[terminal ${tabId}] WebGL context lost; falling back to the DOM renderer`)
      })
      term.loadAddon(webgl)
    } catch (err) {
      console.warn(`[terminal ${tabId}] WebGL unavailable, using the DOM renderer:`, err)
    }

    const handle: TerminalHandle = {
      term,
      fit,
      element,
      paneId: null,
      input: null,
      dispose: () => {
        handles.delete(tabId)
        handle.input?.dispose()
        term.dispose()
        element.remove()
      }
    }
    handles.set(tabId, handle)
    creating.delete(tabId)
    return handle
  })()

  creating.set(tabId, promise)
  return promise
}

export function disposeTerminal(tabId: string): void {
  handles.get(tabId)?.dispose()
}

/** Route a decoded pane frame to whichever terminal is bound to that pane. */
export function writeToPane(paneId: string, data: Uint8Array): void {
  for (const handle of handles.values()) {
    if (handle.paneId === paneId) {
      handle.term.write(data)
      return
    }
  }
}
