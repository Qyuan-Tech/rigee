import { loadXterm } from './lazy'
import { noteOutput } from './activity'
import { notePaneFocus, notePaneOutput } from './paneWatch'
import { editorFontSize, monoFamily } from './fonts'
import { platform, rpc } from './ipc'
import { allTabs } from './groups'
import { leaves, neighbourOf, removeLeaf, roomForPane, setLeafCwd, splitLeaf } from './paneTree'
import { newTerminalTab, rowOf, useApp } from './store'
import { remindsToSave } from './workspaces'
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

/**
 * The pane a pane about to be created should start in the directory of, keyed like `handles`.
 *
 * Ghostty's `window-inherit-working-directory`, for splits: the new pane opens where the one it
 * was split from is NOW — `cd` and all — rather than back at the workspace's first folder, which in
 * a workspace of several repos is very often somewhere else entirely. Only main can ask a process
 * where it is, so all that is kept here is which pane to ask about; the question is put when the
 * new pane's shell is spawned.
 */
const pendingCwdFrom = new Map<string, string>()

/**
 * A folder a pane about to be created should start in, keyed like `handles`: "Open in Terminal
 * Split" on a folder in the explorer. Wins over both the tab's folder and `pendingCwdFrom`, since
 * the user named it outright.
 */
const pendingStartDir = new Map<string, string>()

/**
 * Terminal tabs whose shell waits until the user has answered whether to save the workspace first.
 *
 * Only a tab somebody opened just now — the tab strip's button, the new_tab shortcut — in a
 * workspace with no workspace file. Kept here rather than on the tab, which is persisted: a prompt
 * that came back after a restart would hold a restored terminal hostage, and nobody asked for that
 * one. The pane decides whether the question still stands each time it renders, so saving the
 * workspace some other way, or turning the reminder off, answers it too.
 */
const askingToSave = new Set<string>()

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
    term.textarea?.addEventListener('focus', () => {
      lastFocusedKey = key
      notePaneFocus(handle)
    })
    term.textarea?.addEventListener('blur', () => notePaneFocus(null))
    term.onSelectionChange(() => rememberSelection(term.getSelection()))
    handles.set(key, handle)
    creating.delete(key)
    return handle
  })()

  creating.set(key, promise)
  return promise
}

export function disposeTerminal(key: string): void {
  // A split closed before its shell ever started leaves nothing behind to ask about.
  pendingCwdFrom.delete(key)
  pendingStartDir.delete(key)
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

/** A pane about to be created from `fromKey` starts in its directory. See `pendingCwdFrom`. */
export function inheritCwd(toKey: string, fromKey: string): void {
  const paneId = getTerminal(fromKey)?.paneId
  if (paneId) pendingCwdFrom.set(toKey, paneId)
}

/** The folder this pane was opened on, if it was — once, for the spawn that asks. */
export function takeStartDir(key: string): string | undefined {
  const dir = pendingStartDir.get(key)
  pendingStartDir.delete(key)
  return dir
}

/** The pane whose directory this one should start in, if any — once, for the spawn that asks. */
export function takeCwdSource(key: string): string | undefined {
  const paneId = pendingCwdFrom.get(key)
  pendingCwdFrom.delete(key)
  return paneId
}

/** How long after the last Enter in a pane its shell is asked where it is. */
const CWD_SETTLE_MS = 500

/** Panes whose shell is to be asked where it is, once Enter has stopped being pressed. */
const cwdChecks = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Enter was pressed in this pane: in a moment, ask where its shell is and keep that on its leaf, so
 * that after a restart the pane starts there rather than back at the tab's folder.
 *
 * Asked after Enter because a shell changes directory only by running something, and it runs
 * something when Enter is pressed at its prompt. Not when the app quits: main kills every shell
 * before the page makes its last save (see `before-quit` in main's index.ts), and a crash would
 * not ask at all. Never on a timer, so a window full of idle shells costs nothing. Windows cannot
 * say where a process is, so there a pane keeps the directory it started in.
 */
export function noteEnter(paneId: string): void {
  if (platform() === 'win32') return
  const pending = cwdChecks.get(paneId)
  if (pending) clearTimeout(pending)
  cwdChecks.set(
    paneId,
    setTimeout(() => {
      cwdChecks.delete(paneId)
      void recordCwd(paneId)
    }, CWD_SETTLE_MS)
  )
}

async function recordCwd(paneId: string): Promise<void> {
  const cwd = await rpc['terminal:cwd']({ paneId }).catch(() => null)
  if (!cwd) return
  const s = useApp.getState()
  for (const [workspaceId, row] of Object.entries(s.rowsByWorkspace)) {
    for (const tab of allTabs(row)) {
      if (tab.kind !== 'terminal') continue
      const leaf = leaves(tab.root).find((l) => l.paneId === paneId)
      if (!leaf) continue
      // Most commands leave the directory where it was, and an unchanged tab is not worth a save.
      if (leaf.cwd !== cwd) s.updateTab(workspaceId, tab.id, { root: setLeafCwd(tab.root, leaf.id, cwd) })
      return
    }
  }
}

/**
 * Open a terminal tab the way a person does: the tab strip's button and the new_tab shortcut. Into
 * `groupId`, or the active group; at the text size of `fontFrom`, the pane the key was pressed in.
 *
 * In a workspace that has never been saved, the tab asks to save it before its shell starts, so
 * that the shell can start in the folder the workspace file goes to. See `askingToSave`. Not when
 * `cwd` names a folder: "Open in Terminal" on a repo has already said where the shell goes.
 */
export function openTerminalTab(
  workspaceId: string,
  opts: { groupId?: string; fontFrom?: string | null; cwd?: string } = {}
): string {
  const s = useApp.getState()
  const tab = opts.cwd ? { ...newTerminalTab(), cwd: opts.cwd } : newTerminalTab()
  inheritFontSize(paneKey(tab.id, tab.activeLeafId), opts.fontFrom ?? null)
  const ws = s.workspaces.find((w) => w.id === workspaceId)
  if (!opts.cwd && ws && remindsToSave(ws, s.settings)) askingToSave.add(tab.id)
  s.openTab(workspaceId, tab, opts.groupId)
  return tab.id
}

/**
 * Add a pane to the terminal on screen — the active group's tab, if it is a terminal — starting in
 * `cwd`. It goes where there is most room rather than beside the active pane, so that opening one
 * folder after another fills out a grid: see `roomForPane`. With no terminal showing there is
 * nothing to split, and a tab in that folder is the nearest thing to what was asked. Returns the
 * tab the pane went into.
 */
export function splitTerminalAt(workspaceId: string, cwd: string): string {
  const s = useApp.getState()
  const row = rowOf(s, workspaceId)
  const group = row.groups.find((g) => g.id === row.activeGroupId)
  const tab = group?.tabs.find((t) => t.id === group.activeTabId)
  if (tab?.kind !== 'terminal' || askingToSave.has(tab.id)) return openTerminalTab(workspaceId, { cwd })
  const { leafId, direction } = roomForPane(tab.root)
  const { root, newLeafId } = splitLeaf(tab.root, leafId, direction)
  const key = paneKey(tab.id, newLeafId)
  inheritFontSize(key, paneKey(tab.id, leafId))
  pendingStartDir.set(key, cwd)
  s.updateTab(workspaceId, tab.id, { root, activeLeafId: newLeafId })
  return tab.id
}

/** Whether this tab was opened to ask about saving its workspace, and has not been answered. */
export const isAskingToSave = (tabId: string): boolean => askingToSave.has(tabId)

export function stopAskingToSave(tabId: string): void {
  askingToSave.delete(tabId)
}

export const focusedTerminalKey = (): string | null => lastFocusedKey

/**
 * Go to a terminal pane wherever it is — its workspace, its tab, the pane, the keyboard in it — the
 * way following a badge in the side bar should. Having the keyboard is what marks it seen.
 */
export function revealPane(workspaceId: string, paneId: string): void {
  const s = useApp.getState()
  for (const tab of allTabs(rowOf(s, workspaceId))) {
    if (tab.kind !== 'terminal') continue
    const leaf = leaves(tab.root).find((l) => l.paneId === paneId)
    if (!leaf) continue
    if (s.activeWorkspaceId !== workspaceId) s.setActiveWorkspace(workspaceId)
    s.setActiveTab(workspaceId, tab.id)
    if (tab.activeLeafId !== leaf.id) s.updateTab(workspaceId, tab.id, { activeLeafId: leaf.id })
    // A pane taking the keyboard when it renders as the active one covers the rest; a pane that
    // already was the active one has nothing to re-render for, so it is handed the keyboard here.
    getTerminal(paneKey(tab.id, leaf.id))?.term.focus()
    return
  }
}

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
    window.rigee.onTerminalData(workspaceId, (paneId, data) => {
      writeToPane(paneId, data)
      // Whichever workspace is on screen: an agent printing in another is what keeps that one warm,
      // and what its badge in the side bar counts as at work.
      noteOutput(workspaceId, data.length)
      notePaneOutput(paneId)
    })
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
    // A tab closed while it was still asking has no pane to take the question away with it.
    for (const tabId of askingToSave) if (!live.has(tabId)) askingToSave.delete(tabId)
  }
)
