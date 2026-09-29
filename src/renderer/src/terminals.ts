import { loadXterm } from './lazy'
import { editorFontSize, monoFamily } from './fonts'
import { platform, rpc } from './ipc'
import { allTabs } from './groups'
import { leaves, neighbourOf, removeLeaf } from './paneTree'
import { rowOf, useApp } from './store'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'

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
  /**
   * xterm's modifyOtherKeys level, as the program running here last set it (`CSI > 4 ; n m`).
   *
   * xterm.js neither implements the mode nor remembers it, so this is our own bookkeeping, and
   * only for one decision: what Shift+Enter sends. See `newlineBytes`.
   */
  modifyOtherKeys: number
  /** Created the first time somebody searches this pane. */
  search: SearchAddon | null
  dispose: () => void
}

const handles = new Map<string, TerminalHandle>()
/** Guards against two concurrent mounts racing to create the same terminal. */
const creating = new Map<string, Promise<TerminalHandle>>()

/** Set once xterm has loaded, which is before any handle exists to search. */
let SearchAddonCtor: (new () => SearchAddon) | null = null

/**
 * The size a pane about to be created should start at, keyed like `handles`.
 *
 * Ghostty's `window-inherit-font-size`: a split or tab opened from a pane you had zoomed into
 * opens at that size, not back at the default. Keyed by the pane being created rather than kept
 * as one global "current size", because restored panes are created lazily too — the first time
 * their tab is shown — and those should come back at the default, not at whatever size the pane
 * you happened to be reading last was.
 */
const pendingFontSize = new Map<string, number>()

/** Which pane last had the keyboard, for new tabs to inherit from. */
let lastFocusedKey: string | null = null

/**
 * Ghostty's copy-on-select: the last thing selected in any terminal, for `paste_from_selection`.
 *
 * Private to the app rather than the system clipboard, as Ghostty's is on macOS — selecting text
 * to read it must not destroy what the user deliberately copied. Beside it, what the clipboard
 * held at that moment, so a paste can tell which of the two is newer. See `pasteSelection`.
 */
let selectionBuffer = ''
let clipboardAtSelection: string | null = null
let selectionTimer: ReturnType<typeof setTimeout> | null = null
/**
 * Set around selections the app makes rather than the user: a select-all, which is a way of
 * copying everything, and each find-bar match, which search highlights by selecting it. Neither
 * is something anybody meant to paste.
 */
let appSelecting = false

function rememberSelection(text: string): void {
  if (!text || appSelecting) return
  selectionBuffer = text
  // Once the drag settles, not on every cell it crosses.
  if (selectionTimer) clearTimeout(selectionTimer)
  selectionTimer = setTimeout(() => {
    void rpc['clipboard:read']().then((clip) => { clipboardAtSelection = clip })
  }, 150)
}

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
    const { Terminal, FitAddon, WebglAddon, SearchAddon } = await loadXterm()
    SearchAddonCtor = SearchAddon

    const fontSize = pendingFontSize.get(key) ?? editorFontSize()
    pendingFontSize.delete(key)

    const element = document.createElement('div')
    element.style.width = '100%'
    element.style.height = '100%'

    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: monoFamily(),
      fontSize,
      // Looser than xterm's 1.0 default: rows of dense monospace with no gap between them are
      // markedly harder to scan, and a terminal is mostly scanning.
      lineHeight: 1.35,
      // Leave letterSpacing at 0: a non-integer advance makes the WebGL atlas fall back to a
      // slow per-glyph path.
      letterSpacing: 0,
      cursorBlink: true,
      scrollback: 10000,
      /*
       * Option-drag selects even while a program owns the mouse.
       *
       * A full-screen program — claude, vim, htop, tmux — turns on mouse reporting, and from then
       * on xterm hands every drag to the program instead of selecting with it. That is correct:
       * the program asked for the mouse. But it also means the output on screen cannot be
       * selected at all, which is the one thing a terminal must never take away.
       *
       * xterm defaults this to false and every terminal people actually use sets the equivalent:
       * Option in iTerm2 and Terminal.app, Shift elsewhere. Shift is already xterm's default on
       * the other platforms, so this line is the macOS half of the same behaviour. It affects
       * clicks only — Option as Meta for keybindings is `macOptionIsMeta`, untouched.
       */
      macOptionClickForcesSelection: true,
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
      modifyOtherKeys: 0,
      search: null,
      dispose: () => {
        handles.delete(key)
        if (lastFocusedKey === key) lastFocusedKey = null
        handle.input?.dispose()
        term.dispose()
        element.remove()
      }
    }
    trackModifyOtherKeys(handle)
    term.textarea?.addEventListener('focus', () => { lastFocusedKey = key })
    term.onSelectionChange(() => rememberSelection(term.getSelection()))
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

/**
 * Close one pane of a terminal tab: its process, its xterm, its place in the tree. The last pane
 * takes the tab with it; otherwise the keyboard goes to the neighbour, the way closing a split in
 * any terminal does. The pane component and Cmd+W from outside it both come here.
 */
export function closeTerminalPane(workspaceId: string, tabId: string, leafId: string): void {
  const s = useApp.getState()
  const tab = allTabs(rowOf(s, workspaceId)).find((t) => t.id === tabId)
  if (tab?.kind !== 'terminal') return
  const leaf = leaves(tab.root).find((l) => l.id === leafId)
  if (leaf?.paneId) void rpc['terminal:kill']({ paneId: leaf.paneId })
  disposeTerminal(paneKey(tabId, leafId))

  const next = removeLeaf(tab.root, leafId)
  if (next === null) {
    s.closeTab(workspaceId, tabId)
    return
  }
  const focus = neighbourOf(tab.root, leafId) ?? leaves(next)[0]?.id ?? ''
  s.updateTab(workspaceId, tabId, { root: next, activeLeafId: focus })
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

/** Select the whole scrollback. The way out when a program has taken the mouse. */
export function selectAllInPane(key: string): void {
  appSelecting = true
  try {
    getTerminal(key)?.term.selectAll()
  } finally {
    appSelecting = false
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
  pasteInto(handle, text)
}

/**
 * Ghostty's `paste_from_selection`.
 *
 * On Linux that is the real PRIMARY selection, which follows a selection made in any app, as
 * Ghostty's does there — xterm.js already puts its own selection into PRIMARY.
 *
 * Elsewhere it is the last terminal selection — unless something has been COPIED since, in which
 * case it is the clipboard. That second half is ours. Before this binding existed, Cmd+Shift+V
 * was simply paste, and people who learned it copy something in the browser, come back and press
 * it; handing them a stale selection of scrollback instead would be a paste they did not ask for
 * into a live shell. Whichever of the two is newer is what they meant.
 */
export async function pasteSelection(key: string): Promise<void> {
  const handle = getTerminal(key)
  if (!handle) return
  if (platform() === 'linux') {
    pasteInto(handle, await rpc['clipboard:read']({ selection: true }))
    return
  }
  const clip = await rpc['clipboard:read']()
  const selectionIsNewer = !!selectionBuffer && clipboardAtSelection !== null && clip === clipboardAtSelection
  pasteInto(handle, selectionIsNewer ? selectionBuffer : clip)
}

function pasteInto(handle: TerminalHandle, text: string): void {
  if (!text) {
    // An EMPTY bracketed paste is how Claude Code learns the clipboard holds an image: on macOS
    // it answers one by reading the image itself. Cmd+V with a screenshot on the clipboard only
    // ever attached it because the menu's native paste sent exactly that, so the paste that
    // replaced it has to send it too. Without bracketed paste there is nobody to tell.
    if (handle.term.modes.bracketedPasteMode) handle.term.paste('')
    return
  }
  // term.paste, not writeTerminal: paste() applies bracketed-paste framing when the program has
  // asked for it. Without that a multi-line paste arrives at a shell as a sequence of Enters and
  // runs itself line by line, which is how a paste into a prompt turns into an accident.
  handle.term.paste(text)
}

/**
 * Type bytes into a pane as though the user had: `text:`, `esc:` and `csi:` bindings.
 *
 * Through `term.input` rather than straight to the pty, so it takes the same road a keystroke
 * does — the one onData subscription — and scrolls to the bottom the way typing does.
 */
export function sendToPane(key: string, data: string): boolean {
  const handle = getTerminal(key)
  if (!handle || !data) return false
  handle.term.input(data, true)
  return true
}

/**
 * What Shift+Enter sends: a newline the program will not take as "submit".
 *
 * ESC CR — Meta+Enter — by default. It is what Claude Code's own /terminal-setup binds Shift+Enter
 * to in VS Code, which is xterm.js exactly like us; Claude Code inserts a newline for it, and zsh
 * inserts one into the command line without running it.
 *
 * Except when the program has turned on modifyOtherKeys level 2, which vim does on start. There
 * ESC CR is a disaster — ESC leaves insert mode — and the program has said it can read xterm's own
 * encoding of the chord, which is what Ghostty sends: CSI 27;2;13~. Level 1 is left on ESC CR,
 * because that level promises nothing about Enter.
 */
export function newlineBytes(key: string): string {
  return getTerminal(key)?.modifyOtherKeys === 2 ? '\x1b[27;2;13~' : '\x1b\r'
}

function trackModifyOtherKeys(handle: TerminalHandle): void {
  const { parser } = handle.term
  // XTMODKEYS, CSI > Pp ; Pv m. Resource 4 is modifyOtherKeys; no value, or no parameters at all,
  // means "back to the default", which is off. Returning true: xterm.js has no handler of its own.
  parser.registerCsiHandler({ prefix: '>', final: 'm' }, (params) => {
    const [resource, value] = params
    if (params.length === 0 || resource === 4) handle.modifyOtherKeys = typeof value === 'number' ? value : 0
    return true
  })
  // CSI > Ps n: disable a resource.
  parser.registerCsiHandler({ prefix: '>', final: 'n' }, (params) => {
    if (params.length === 0 || params[0] === 4) handle.modifyOtherKeys = 0
    return true
  })
  // A full or soft reset takes the mode with it. False, so xterm's own reset still runs.
  parser.registerEscHandler({ final: 'c' }, () => { handle.modifyOtherKeys = 0; return false })
  parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => { handle.modifyOtherKeys = 0; return false })
}

// --- font size ---------------------------------------------------------------

const MIN_FONT = 6
const MAX_FONT = 72

export function paneFontSize(key: string): number {
  return getTerminal(key)?.term.options.fontSize ?? editorFontSize()
}

/**
 * Resize one pane's text: Ghostty's font-size actions, which apply per split.
 *
 * The pty is told the new geometry here, not left to the ResizeObserver — the pane's box has not
 * changed, only how many cells fit in it, so the observer never fires, and a pty that still thinks
 * it is 80 columns wide wraps every line in the wrong place.
 */
export function setPaneFontSize(key: string, size: number): boolean {
  const handle = getTerminal(key)
  if (!handle) return false
  const next = Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(size * 2) / 2))
  if (next === handle.term.options.fontSize) return true
  handle.term.options.fontSize = next
  handle.fit.fit()
  if (handle.paneId) {
    void rpc['terminal:resize']({ paneId: handle.paneId, cols: handle.term.cols, rows: handle.term.rows })
  }
  return true
}

export const resetPaneFontSize = (key: string): boolean => setPaneFontSize(key, editorFontSize())

/** A pane about to be created from `fromKey` starts at its size. See `pendingFontSize`. */
export function inheritFontSize(toKey: string, fromKey: string | null): void {
  if (!fromKey) return
  const size = getTerminal(fromKey)?.term.options.fontSize
  if (size && size !== editorFontSize()) pendingFontSize.set(toKey, size)
}

export const focusedTerminalKey = (): string | null => lastFocusedKey

// --- screen ------------------------------------------------------------------

/**
 * Ghostty's `clear_screen`: scrollback and all, keeping the line the cursor is on.
 *
 * Not performed on the alternate screen, where a full-screen program — claude, vim — owns every
 * cell and clearing would just leave it to repaint over a blank. Its binding is `performable:`,
 * so there the key goes to the program instead.
 */
export function clearPane(key: string): boolean {
  const handle = getTerminal(key)
  if (!handle || handle.term.buffer.active.type === 'alternate') return false
  handle.term.clear()
  return true
}

export function scrollPane(key: string, how: 'top' | 'bottom' | 'pageUp' | 'pageDown'): boolean {
  const term = getTerminal(key)?.term
  if (!term) return false
  if (how === 'top') term.scrollToTop()
  else if (how === 'bottom') term.scrollToBottom()
  else term.scrollPages(how === 'pageUp' ? -1 : 1)
  return true
}

/** Ghostty's `scroll_to_selection`. False with nothing selected, so the key goes through. */
export function scrollToSelection(key: string): boolean {
  const term = getTerminal(key)?.term
  const pos = term?.getSelectionPosition()
  if (!term || !pos) return false
  term.scrollToLine(Math.max(0, pos.start.y - Math.floor(term.rows / 3)))
  return true
}

// --- search ------------------------------------------------------------------

/** The palette's yellow: visible on the lighter surface without being mistaken for a selection. */
const SEARCH_DECORATIONS = {
  matchBackground: '#5a4b25',
  matchBorder: '#e3bb5e',
  matchOverviewRuler: '#e3bb5e',
  activeMatchBackground: '#e3bb5e',
  activeMatchBorder: '#efcd7e',
  activeMatchColorOverviewRuler: '#efcd7e'
}

export function paneSearch(key: string): SearchAddon | null {
  const handle = getTerminal(key)
  if (!handle || !SearchAddonCtor) return null
  if (!handle.search) {
    handle.search = new SearchAddonCtor()
    handle.term.loadAddon(handle.search)
  }
  return handle.search
}

export function findInPane(key: string, query: string, direction: 'next' | 'previous', incremental = false): boolean {
  const search = paneSearch(key)
  if (!search || !query) return false
  const options = { decorations: SEARCH_DECORATIONS, incremental }
  appSelecting = true
  try {
    return direction === 'next' ? search.findNext(query, options) : search.findPrevious(query, options)
  } finally {
    appSelecting = false
  }
}

export function clearPaneSearch(key: string): void {
  getTerminal(key)?.search?.clearDecorations()
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
 * Workspaces whose byte transport is already up, and how to take their sink down again.
 *
 * Per WORKSPACE, which is the thing a MessagePort belongs to — not per tab and emphatically not
 * per pane component. `PtyManager.establishPort` CLOSES the live port and builds a fresh
 * MessageChannelMain on every request, so a second request drops whatever frames were in flight:
 * with two terminal tabs in two groups mounting together, that was a burst of output vanishing on
 * every layout change. It was only ever harmless because exactly one terminal pane could exist.
 */
const transports = new Map<string, () => void>()

/**
 * Bring up this workspace's terminal transport, once.
 *
 * Idempotent by construction, because the ways in are plural: the module-level subscription below
 * covers a workspace becoming active, and the shell may call this directly — one call, from
 * App.tsx keyed on `activeWorkspaceId`, is the right shape and costs nothing extra if it arrives.
 * What must never happen is a per-tab component calling it.
 */
export function ensureTerminalTransport(workspaceId: string): void {
  if (transports.has(workspaceId)) return
  // The sink is registered BEFORE the port is asked for: preload queues frames that arrive with no
  // reader, but the queue is bounded, and the first thing a restored terminal does is redraw.
  transports.set(
    workspaceId,
    window.rigee.onTerminalData(workspaceId, (paneId, data) => writeToPane(paneId, data))
  )
  void rpc['terminal:requestPort']({ workspaceId })
}

/** Drop a workspace's transport. For a workspace being closed, not for a tab or a pane. */
export function releaseTerminalTransport(workspaceId: string): void {
  transports.get(workspaceId)?.()
  transports.delete(workspaceId)
}

// Fires immediately as well as on every change, so the transport is up whether this module loads
// before or after the workspace is chosen at boot.
useApp.subscribe(
  (s) => s.activeWorkspaceId,
  (workspaceId) => { if (workspaceId) ensureTerminalTransport(workspaceId) },
  { fireImmediately: true }
)

/**
 * Reap terminals whose tab has closed.
 *
 * Closing a pane is handled by the component, but closing the whole tab is not — the component
 * unmounts and nothing is left to run the teardown. Subscribing outside React keeps this off the
 * render path, the same arrangement browserViews.ts uses for native views.
 *
 * The live set spans every GROUP of every workspace, and getting that wrong is not a leak but a
 * massacre: a tab absent from the set has its pty killed and its xterm disposed, so a set built
 * from one group would take down every terminal in the others — scrollback, running processes and
 * all — on the first store write after a split. A tab dragged between groups keeps its id, so
 * this correctly sees it as live throughout the move.
 */
useApp.subscribe(
  (s) => s.rowsByWorkspace,
  (rowsByWorkspace) => {
    const live = new Set<string>()
    for (const row of Object.values(rowsByWorkspace)) {
      for (const group of row.groups) {
        for (const t of group.tabs) live.add(t.id)
      }
    }
    for (const [key, handle] of handles) {
      const tabId = key.slice(0, key.indexOf(':'))
      if (live.has(tabId)) continue
      if (handle.paneId) void rpc['terminal:kill']({ paneId: handle.paneId })
      disposeTerminal(key)
    }
  }
)
