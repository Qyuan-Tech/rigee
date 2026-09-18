import { loadXterm } from './lazy'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

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
  dispose: () => void
}

const handles = new Map<string, TerminalHandle>()
/** Guards against two concurrent mounts racing to create the same terminal. */
const creating = new Map<string, Promise<TerminalHandle>>()

const FONT_FAMILY =
  '"SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace'

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
      fontFamily: FONT_FAMILY,
      fontSize: 13,
      lineHeight: 1.2,
      // Leave letterSpacing at 0: any non-integer advance makes the WebGL atlas fall back to a
      // slow per-glyph path.
      letterSpacing: 0,
      cursorBlink: true,
      scrollback: 10000,
      theme: {
        background: '#141414',
        foreground: '#cccccc',
        cursor: '#cccccc',
        selectionBackground: '#37373d'
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
      dispose: () => {
        handles.delete(tabId)
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
