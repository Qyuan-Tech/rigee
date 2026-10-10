import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { groupOfTab } from '../groups'
import { isMac, onEvent, platform, rpc } from '../ipc'
import { formatChord, resolvePrefixKey } from '../keys'
import {
  actionSpec,
  decodeText,
  formatTrigger,
  isTextEditingTrigger,
  splitAction,
  splitDirection,
  triggersFor,
  type Binding
} from '@shared/keymap'
import {
  bindPane,
  cycleLeaf,
  equalize,
  leafInDirection,
  leaves,
  newLeaf,
  nodeRects,
  resizeSplit,
  setSizes,
  splitLeaf,
  type Direction
} from '../paneTree'
import {
  lookupShortcut,
  markDispatched,
  rememberPress,
  repeatOutcome,
  runAppAction,
  unshiftedKey,
  useKeymap
} from '../shortcuts'
import {
  clearPane,
  clearPaneSearch,
  closeTerminalPane,
  copyPane,
  ensureTerminal,
  findInPane,
  getTerminal,
  inheritCwd,
  inheritFontSize,
  isAskingToSave,
  newlineBytes,
  paneFontSize,
  paneKey,
  paneSearch,
  paneSelection,
  pastePane,
  pasteSelection,
  reapPanes,
  resetPaneFontSize,
  scrollPane,
  scrollToSelection,
  selectAllInPane,
  sendToPane,
  setPaneFontSize,
  stopAskingToSave,
  takeCwdSource
} from '../terminals'
import { rowOf, useApp } from '../store'
import { remindsToSave, terminalCwd } from '../workspaces'
import { SaveReminder } from './LazySaveWorkspace'
import type { PaneNode, TerminalTab } from '@shared/types'
import '@xterm/xterm/css/xterm.css'

/**
 * A terminal tab: a tree of split panes, each backed by its own pseudo-terminal.
 *
 * The xterm instances live in terminals.ts, not in React state. This component owns the layout
 * and the wiring; re-rendering the tree re-parents elements rather than recreating terminals, so
 * splitting or dragging a divider never costs scrollback.
 *
 * Bytes arrive over a MessagePort established once per workspace, already demultiplexed by pane
 * id and coalesced in main — never through ipcRenderer. Establishing it is terminals.ts's job and
 * not this component's: it is per-WORKSPACE state, and two terminal tabs in two groups mounting
 * together would otherwise ask for it twice and drop the frames in flight between the two.
 */
export function TerminalPane({ tab }: { tab: TerminalTab }): React.ReactElement {
  const workspaceId = useApp((s) => s.activeWorkspaceId)
  const workspace = useApp((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null)
  const updateTab = useApp((s) => s.updateTab)
  /**
   * Whether this tab is in the column the user is working in.
   *
   * Only for deciding whether a pane may take the keyboard on mount. A terminal DRAGGED into the
   * other group mounts there immediately, and a pane that grabbed focus then would swallow the
   * next keystrokes of whatever the user was actually typing into.
   */
  const inActiveGroup = useApp((s) => {
    if (!s.activeWorkspaceId) return false
    const row = rowOf(s, s.activeWorkspaceId)
    return groupOfTab(row, tab.id)?.id === row.activeGroupId
  })
  const [error, setError] = useState<string | null>(null)
  const bindings = useApp((s) => s.keybindings)
  const keymap = useKeymap()
  const [prefixArmed, setPrefixArmed] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; leafId: string } | null>(null)
  /**
   * The pane filling the whole tab, if one is: Ghostty's `toggle_split_zoom`. Not persisted — it
   * is a way of looking, like scroll position, and a tab that came back zoomed after a restart
   * would look as if its other panes had been lost.
   */
  const [zoomed, setZoomed] = useState<string | null>(null)
  /** The find bar, when open. It searches whichever pane is active. */
  const [search, setSearch] = useState<{ query: string } | null>(null)
  const [results, setResults] = useState<{ index: number; count: number } | null>(null)
  /** Bumped to hand the find bar the keyboard, which it takes once it has rendered. */
  const [searchFocus, setSearchFocus] = useState(0)
  const container = useRef<HTMLDivElement>(null)
  // Synchronous mirror: the key handler runs before React can re-render.
  const armed = useRef(false)
  const settings = useApp((s) => s.settings)
  /** Not Now was pressed. The set in terminals.ts is not something React can watch. */
  const [skipped, setSkipped] = useState(false)
  /**
   * Whether this tab is still asking to save its workspace before its shell starts. Worked out
   * afresh every render, because the question can go away without being answered here: the
   * workspace saved from the side bar, or the reminder switched off from another tab's prompt.
   */
  const askingToSave = !skipped && isAskingToSave(tab.id) && !!workspace && remindsToSave(workspace, settings)

  const cwd = workspace ? terminalCwd(workspace) : '.'
  const activeKey = paneKey(tab.id, tab.activeLeafId)
  const zoomedLeaf = zoomed ? (leaves(tab.root).find((l) => l.id === zoomed) ?? null) : null

  const patch = useCallback(
    (fn: (t: TerminalTab) => Partial<TerminalTab>) => {
      if (!workspaceId) return
      updateTab(workspaceId, tab.id, fn(tab))
    },
    [tab, updateTab, workspaceId]
  )

  const closeLeaf = useCallback(
    (leafId: string) => {
      if (!workspaceId) return
      setZoomed(null)
      closeTerminalPane(workspaceId, tab.id, leafId)
    },
    [tab.id, workspaceId]
  )

  // A shell that exits takes its pane with it, the way closing a terminal should.
  useEffect(() => {
    return onEvent('terminal:exit', ({ paneId }) => {
      const leaf = leaves(tab.root).find((l) => l.paneId === paneId)
      if (leaf) closeLeaf(leaf.id)
    })
  }, [tab.root, closeLeaf])

  const split = useCallback(
    (direction: 'row' | 'column', before = false) => {
      const { root, newLeafId } = splitLeaf(tab.root, tab.activeLeafId, direction, newLeaf(), before)
      // The new pane starts at the size of the one it was split from, and in its directory, as it
      // does in Ghostty.
      inheritFontSize(paneKey(tab.id, newLeafId), paneKey(tab.id, tab.activeLeafId))
      inheritCwd(paneKey(tab.id, newLeafId), paneKey(tab.id, tab.activeLeafId))
      setZoomed(null)
      patch(() => ({ root, activeLeafId: newLeafId }))
    },
    [tab.root, tab.activeLeafId, tab.id, patch]
  )

  const focusLeaf = useCallback(
    (leafId: string | null): boolean => {
      if (!leafId) return false
      setZoomed(null)
      patch(() => ({ activeLeafId: leafId }))
      return true
    },
    [patch]
  )

  /** The tab's size in pixels, which is what turns Ghostty's pixel-based resize into fractions. */
  const box = (): { width: number; height: number } => {
    const r = container.current?.getBoundingClientRect()
    return { width: r?.width ?? 0, height: r?.height ?? 0 }
  }

  const closeSearch = useCallback((): boolean => {
    if (!search) return false
    setSearch(null)
    setResults(null)
    getTerminal(activeKey)?.term.focus()
    return true
  }, [search, activeKey])

  const openSearch = useCallback((query?: string) => {
    // The search itself runs from the effect below, once the bar is subscribed to its results.
    setSearch((s) => ({ query: query ?? s?.query ?? '' }))
    setSearchFocus((n) => n + 1)
  }, [])

  const navigateSearch = useCallback(
    (direction: 'next' | 'previous'): boolean => {
      if (!search?.query) return false
      findInPane(activeKey, search.query, direction)
      return true
    },
    [search, activeKey]
  )

  /**
   * Run a bound action with this pane focused. True when it did something — the answer a
   * `performable:` binding needs to decide whether the key still goes to the program.
   */
  const runTerminalAction = useCallback(
    (leafId: string, action: string): boolean => {
      const [name, param] = splitAction(action)
      const key = paneKey(tab.id, leafId)
      const count = leaves(tab.root).length

      switch (name) {
        case 'copy_to_clipboard':
          return copyPane(key)
        case 'paste_from_clipboard':
          void pastePane(key)
          return true
        case 'paste_from_selection':
          void pasteSelection(key)
          return true

        case 'text': {
          const bytes = decodeText(param)
          return bytes !== null && sendToPane(key, bytes)
        }
        case 'esc':
          return sendToPane(key, `\x1b${param}`)
        case 'csi':
          return sendToPane(key, `\x1b[${param}`)
        case 'insert_newline':
          return sendToPane(key, newlineBytes(key))

        case 'increase_font_size':
          return setPaneFontSize(key, paneFontSize(key) + (Number(param) || 1))
        case 'decrease_font_size':
          return setPaneFontSize(key, paneFontSize(key) - (Number(param) || 1))
        case 'set_font_size':
          return setPaneFontSize(key, Number(param))
        case 'reset_font_size':
          return resetPaneFontSize(key)

        case 'clear_screen':
          return clearPane(key)
        case 'select_all':
          selectAllInPane(key)
          return true
        case 'scroll_to_top':
          return scrollPane(key, 'top')
        case 'scroll_to_bottom':
          return scrollPane(key, 'bottom')
        case 'scroll_page_up':
          return scrollPane(key, 'pageUp')
        case 'scroll_page_down':
          return scrollPane(key, 'pageDown')
        case 'scroll_to_selection':
          return scrollToSelection(key)

        case 'new_split': {
          let dir = (param || 'auto') as Direction | 'auto'
          if (dir === 'auto') {
            // The longer way, measured on screen: a tall narrow pane splits down.
            const r = nodeRects(tab.root).get(leafId)
            const { width, height } = box()
            dir = r && r.w * width < r.h * height ? 'down' : 'right'
          }
          split(dir === 'left' || dir === 'right' ? 'row' : 'column', dir === 'left' || dir === 'up')
          return true
        }
        case 'goto_split':
          return focusLeaf(
            param === 'previous' || param === 'next'
              ? cycleLeaf(tab.root, leafId, param === 'next' ? 1 : -1)
              : leafInDirection(tab.root, leafId, splitDirection(param))
          )
        case 'resize_split': {
          const [dir, px] = param.split(',')
          const root = resizeSplit(tab.root, leafId, dir as Direction, Number(px), box())
          if (!root) return false
          setZoomed(null)
          patch(() => ({ root }))
          return true
        }
        case 'equalize_splits':
          if (count < 2) return false
          patch((t) => ({ root: equalize(t.root) }))
          return true
        case 'toggle_split_zoom':
          if (count < 2) return false
          // A zoomed pane that is no longer in the tree — closed from outside, by Cmd+W with the
          // keyboard elsewhere — counts as not zoomed, or this press would only clear the leftover.
          setZoomed((z) => (z && leaves(tab.root).some((l) => l.id === z) ? null : leafId))
          return true
        case 'close_surface':
          closeLeaf(leafId)
          return true

        case 'start_search':
          openSearch()
          return true
        case 'search_selection': {
          const text = paneSelection(key)
          if (!text) return false
          openSearch(text)
          return true
        }
        case 'navigate_search':
          return navigateSearch(param === 'previous' ? 'previous' : 'next')
        case 'end_search':
          return closeSearch()
      }
      return actionSpec(action)?.scope === 'app' ? runAppAction(action, key) : false
    },
    [tab.id, tab.root, split, focusLeaf, patch, closeLeaf, openSearch, navigateSearch, closeSearch]
  )

  /**
   * Every key a focused pane receives, from xterm's key hook, before xterm turns it into bytes.
   * Returns false to consume it; LeafView then cancels the event, which is what stops the browser
   * sending a keypress for it (a swallowed key that still types itself) and Electron's menu acting
   * on it as well (Cmd+V pasting twice).
   *
   * The tmux-style prefix goes first, then the shortcut table. Pressing the prefix twice sends a
   * literal one, which is the escape hatch tmux gives you for Ctrl-A at the start of a line. An
   * unbound key after the prefix is swallowed, also like tmux: passing it through would run a
   * command the user did not mean to type.
   */
  const handleKey = useCallback(
    (leafId: string, e: KeyboardEvent): boolean => {
      if (e.type !== 'keydown') return true
      // Mid-composition the key is the input method's — Enter commits a Pinyin candidate, it does
      // not insert a newline or arm anything.
      if (e.isComposing || e.keyCode === 229) return true
      // The shortcuts dialog is up but does not have the keyboard yet — it is still arriving.
      // Nothing typed in that moment is meant for the shell behind it, least of all Cmd+W.
      if (useApp.getState().settingsOpen) return false

      const outcome = resolvePrefixKey(e, bindings, armed.current, unshiftedKey)
      switch (outcome.kind) {
        case 'arm':
          armed.current = true
          setPrefixArmed(true)
          return false

        case 'hold':
          // A modifier on its own. Stay armed: the binding it is modifying has not arrived yet.
          return false

        case 'literal': {
          armed.current = false
          setPrefixArmed(false)
          sendToPane(paneKey(tab.id, leafId), outcome.bytes)
          return false
        }

        case 'command':
          armed.current = false
          setPrefixArmed(false)
          if (outcome.command === 'splitRight') split('row')
          else if (outcome.command === 'splitDown') split('column')
          else closeLeaf(leafId)
          return false

        case 'swallow':
          armed.current = false
          setPrefixArmed(false)
          return false

        case 'passthrough':
          break
      }

      const binding = lookupShortcut(e)
      if (!binding) return true
      // Whatever happens next, this key has been answered here: the window listener must not run
      // it again when an `unconsumed:` binding lets it through.
      markDispatched(e)
      const spec = actionSpec(binding.action)
      // Held down, a key that must not repeat does what its first press did: swallowed if that
      // was consumed — or the repeats would leak through to the program one at a time — and
      // passed on if the first press went to the program anyway.
      if (e.repeat && spec && !spec.repeats) return repeatOutcome(e) === false
      const performed = runTerminalAction(leafId, binding.action)
      const pass = (!performed && binding.performable) || binding.unconsumed
      rememberPress(e, !pass)
      return pass
    },
    [bindings, split, closeLeaf, tab.id, runTerminalAction]
  )

  /*
   * What the panes are handed is STABLE, forwarding to whatever the latest render produced. Each
   * pane's mount effect depends on these, and it re-parents the xterm element, rebinds its input
   * and takes the keyboard every time it runs — so a fresh function per render meant every render
   * of this component, a keystroke in the find bar included, yanked focus back into the terminal.
   */
  const latest = useRef({ handleKey, patch })
  latest.current = { handleKey, patch }
  const onKey = useCallback((leafId: string, e: KeyboardEvent) => latest.current.handleKey(leafId, e), [])
  const onBind = useCallback(
    (leafId: string, paneId: string) => latest.current.patch((t) => ({ root: bindPane(t.root, leafId, paneId) })),
    []
  )

  // Arming times out, so a stray prefix does not silently eat the next keystroke minutes later.
  useEffect(() => {
    if (!prefixArmed) return
    const t = setTimeout(() => { armed.current = false; setPrefixArmed(false) }, 3000)
    return () => clearTimeout(t)
  }, [prefixArmed])

  useEffect(() => {
    if (!menu) return
    const dismiss = (): void => setMenu(null)
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', dismiss)
    return () => {
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', dismiss)
    }
  }, [menu])

  // A pane the tree no longer contains must not keep an xterm instance alive.
  useEffect(() => {
    reapPanes(tab.id, new Set(leaves(tab.root).map((l) => l.id)))
  }, [tab.root, tab.id])

  // Once the question has gone, however it went, it stays gone: a shell has started by then, and
  // turning the reminder back on must not put a prompt over a terminal that is already running.
  useEffect(() => {
    if (!askingToSave) stopAskingToSave(tab.id)
  }, [askingToSave, tab.id])

  // The find bar follows the active pane: its matches, its count, and its highlights, which come
  // off a pane the moment it stops being the one searched.
  const searchOpen = search !== null
  const query = search?.query ?? ''
  //
  // The pane may not exist yet — a split made while the bar is open is still being created — so
  // the subscription waits for it, and the count is cleared rather than left showing the last
  // pane's.
  const [searchReady, setSearchReady] = useState<string | null>(null)
  useEffect(() => {
    if (!searchOpen) return
    let cancelled = false
    let sub: { dispose(): void } | undefined
    setResults(null)
    void ensureTerminal(activeKey).then(() => {
      if (cancelled) return
      sub = paneSearch(activeKey)?.onDidChangeResults(({ resultIndex, resultCount }) =>
        setResults({ index: resultIndex, count: resultCount })
      )
      setSearchReady(activeKey)
    })
    return () => {
      cancelled = true
      sub?.dispose()
      clearPaneSearch(activeKey)
      setSearchReady(null)
    }
  }, [searchOpen, activeKey])

  useEffect(() => {
    if (!searchOpen || searchReady !== activeKey) return
    if (query) findInPane(activeKey, query, 'next', true)
    else {
      clearPaneSearch(activeKey)
      setResults(null)
    }
  }, [searchOpen, searchReady, query, activeKey])

  if (!workspaceId || !workspace) return <div className="empty">No workspace.</div>

  if (askingToSave) {
    return (
      <div className="term term--asking">
        <Suspense fallback={null}>
          <SaveReminder
            workspace={workspace}
            onSkip={() => {
              stopAskingToSave(tab.id)
              setSkipped(true)
            }}
          />
        </Suspense>
      </div>
    )
  }

  return (
    <div className="term" ref={container}>
      <NodeView
        node={zoomedLeaf ?? tab.root}
        tab={tab}
        workspaceId={workspaceId}
        cwd={cwd}
        inActiveGroup={inActiveGroup}
        onBind={onBind}
        onFocus={(leafId) => patch(() => ({ activeLeafId: leafId }))}
        onClose={closeLeaf}
        onResize={(splitId, sizes) => patch((t) => ({ root: setSizes(t.root, splitId, sizes) }))}
        onError={setError}
        onKey={onKey}
        onContextMenu={(leafId, x, y) => setMenu({ x, y, leafId })}
      />

      {search && (
        <SearchBar
          focusToken={searchFocus}
          query={search.query}
          results={results}
          onChange={(q) => setSearch({ query: q })}
          onNavigate={navigateSearch}
          onClose={closeSearch}
          onAction={(action) => runTerminalAction(tab.activeLeafId, action)}
        />
      )}

      {prefixArmed && <div className="term__prefix">prefix</div>}
      {zoomedLeaf && <div className="term__prefix term__prefix--left">zoomed</div>}

      {menu && (
        <PaneMenu
          x={menu.x}
          y={menu.y}
          hints={menuHints(keymap, bindings)}
          selection={paneSelection(paneKey(tab.id, menu.leafId))}
          onCopy={() => { copyPane(paneKey(tab.id, menu.leafId)); setMenu(null) }}
          onSelectAll={() => { selectAllInPane(paneKey(tab.id, menu.leafId)); setMenu(null) }}
          onPaste={() => { const k = paneKey(tab.id, menu.leafId); setMenu(null); void pastePane(k) }}
          onSplitRight={() => { setMenu(null); split('row') }}
          onSplitDown={() => { setMenu(null); split('column') }}
          onClose={() => { const id = menu.leafId; setMenu(null); closeLeaf(id) }}
        />
      )}

      {error && <div className="error-banner">{error}</div>}
    </div>
  )
}

interface MenuHints {
  copy: string
  paste: string
  splitRight: string
  splitDown: string
  closePane: string
}

/**
 * What the context menu shows beside each item: the shortcut, else the prefix chord that does the
 * same, else nothing. Read from the live keymap, so a key the user rebinds is the key the menu
 * names.
 */
function menuHints(
  keymap: ReturnType<typeof useKeymap>,
  bindings: { prefix: string; splitRight: string; splitDown: string; closePane: string }
): MenuHints {
  const mac = isMac()
  const key = (action: string): string => {
    const t = triggersFor(keymap, action)[0]
    return t ? formatTrigger(t, mac) : ''
  }
  const viaPrefix = (k: string): string => (bindings.prefix ? `${formatChord(bindings.prefix, mac)} ${k}` : '')
  return {
    copy: key('copy_to_clipboard'),
    paste: key('paste_from_clipboard'),
    splitRight: key('new_split:right') || viaPrefix(bindings.splitRight),
    splitDown: key('new_split:down') || viaPrefix(bindings.splitDown),
    closePane: key('close_surface') || viaPrefix(bindings.closePane)
  }
}

function PaneMenu({
  x,
  y,
  hints,
  selection,
  onCopy,
  onSelectAll,
  onPaste,
  onSplitRight,
  onSplitDown,
  onClose
}: {
  x: number
  y: number
  hints: MenuHints
  selection: string
  onCopy: () => void
  onSelectAll: () => void
  onPaste: () => void
  onSplitRight: () => void
  onSplitDown: () => void
  onClose: () => void
}): React.ReactElement {
  return (
    <div
      className="menu"
      style={{ left: x, top: y }}
      // preventDefault as well: a button takes the focus on mousedown, and when the menu then
      // unmounts it is left on <body> — the terminal would stop hearing the keyboard, so the Enter
      // after "Paste" or the Cmd+C after "Select All" would go nowhere.
      onMouseDown={(e) => { e.stopPropagation(); e.preventDefault() }}
    >
      <button className="menu__item" disabled={!selection} onClick={onCopy}>
        <span>Copy</span>
        <span className="menu__hint">{hints.copy}</span>
      </button>
      <button className="menu__item" onClick={onPaste}>
        <span>Paste</span>
        <span className="menu__hint">{hints.paste}</span>
      </button>
      {/* Reachable no matter what the running program has done with the mouse. */}
      <button className="menu__item" onClick={onSelectAll}>
        <span>Select All</span>
        <span className="menu__hint">{isMac() ? '⌥ drag' : 'shift drag'}</span>
      </button>
      <div className="menu__sep" />
      <button className="menu__item" onClick={onSplitRight}>
        <span>Split right</span>
        <span className="menu__hint">{hints.splitRight}</span>
      </button>
      <button className="menu__item" onClick={onSplitDown}>
        <span>Split down</span>
        <span className="menu__hint">{hints.splitDown}</span>
      </button>
      <div className="menu__sep" />
      <button className="menu__item" onClick={onClose}>
        <span>Close pane</span>
        <span className="menu__hint">{hints.closePane}</span>
      </button>
    </div>
  )
}

/**
 * The find bar: Ghostty's search, on xterm's search addon.
 *
 * Its input holds the keyboard while open, so the navigation keys are answered here as well as
 * from the terminal — Cmd+G from inside the box has to find the next match, not do nothing.
 * Escape closes it and hands the keyboard back to the pane; it is only ever taken from the
 * program while the bar is open, because Escape is how Claude Code is interrupted.
 */
function SearchBar({
  focusToken,
  query,
  results,
  onChange,
  onNavigate,
  onClose,
  onAction
}: {
  focusToken: number
  query: string
  results: { index: number; count: number } | null
  onChange: (query: string) => void
  onNavigate: (direction: 'next' | 'previous') => boolean
  onClose: () => boolean
  /** Run a bound action as the pane being searched would. True when it did something. */
  onAction: (action: string) => boolean
}): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null)
  // An effect, not requestAnimationFrame: animation frames stop in a window that is hidden or
  // covered, and Cmd+F there would open a bar that does not have the keyboard.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusToken])

  const status = !query
    ? ''
    : !results || results.count === 0
      ? 'No results'
      : results.index < 0
        ? `${results.count}+`
        : `${results.index + 1} of ${results.count}`

  return (
    <div className="term__search" onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        value={query}
        placeholder="Find"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
            return
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            onNavigate(e.shiftKey ? 'previous' : 'next')
            return
          }
          const binding = lookupShortcut(e.nativeEvent)
          const action = binding?.action ?? ''
          const [name, param] = splitAction(action)
          if (name === 'navigate_search') onNavigate(param === 'previous' ? 'previous' : 'next')
          else if (name === 'end_search') onClose()
          else if (name === 'start_search') inputRef.current?.select()
          else if (binding && belongsToThePane(binding)) {
            // The bar belongs to its pane, as Ghostty's does to its surface: Cmd+W from here
            // closes that one split, not — through the window listener — the whole tab.
            if (!onAction(action) && binding.performable) return
          } else return
          e.preventDefault()
        }}
      />
      <span className="term__search-count">{status}</span>
      <button className="icon-button" title="Previous match" onClick={() => onNavigate('previous')}>↑</button>
      <button className="icon-button" title="Next match" onClick={() => onNavigate('next')}>↓</button>
      <button className="icon-button" title="Close" onClick={() => onClose()}>×</button>
    </div>
  )
}

/**
 * Whether a binding pressed in the find bar should act on the pane rather than on the text box.
 * Not the clipboard or line-editing actions, not select-all, and not any key a text box uses to
 * move or select — Shift+Home selects the query, whatever it does in the terminal.
 */
function belongsToThePane(binding: Binding): boolean {
  const spec = actionSpec(binding.action)
  if (!spec) return false
  const [name] = splitAction(binding.action)
  if (name === 'close_surface') return true
  if (isTextEditingTrigger(binding.trigger)) return false
  return spec.scope === 'terminal' && spec.group !== 'Clipboard' && spec.group !== 'Editing' && name !== 'select_all'
}

interface NodeProps {
  node: PaneNode
  tab: TerminalTab
  workspaceId: string
  cwd: string
  /** Whether a pane in this tab may take the keyboard when it mounts. */
  inActiveGroup: boolean
  onBind: (leafId: string, paneId: string) => void
  onFocus: (leafId: string) => void
  onClose: (leafId: string) => void
  onResize: (splitId: string, sizes: number[]) => void
  onError: (message: string) => void
  onKey: (leafId: string, e: KeyboardEvent) => boolean
  onContextMenu: (leafId: string, x: number, y: number) => void
}

function NodeView(props: NodeProps): React.ReactElement {
  const { node } = props
  if (node.kind === 'leaf') return <LeafView {...props} leaf={node} />

  return (
    <div className={`term__split term__split--${node.direction}`}>
      {node.children.map((child, i) => (
        <div
          key={child.id}
          className="term__slot"
          style={{ flexGrow: node.sizes[i] ?? 1, flexBasis: 0 }}
        >
          <NodeView {...props} node={child} />
          {i < node.children.length - 1 && (
            <SplitHandle
              direction={node.direction}
              onDrag={(fraction) => {
                const sizes = [...node.sizes]
                const a = sizes[i] ?? 0
                const b = sizes[i + 1] ?? 0
                const total = a + b
                // Clamp so a pane can never be dragged to nothing and become unrecoverable.
                const next = Math.min(Math.max(a + fraction * total, total * 0.08), total * 0.92)
                sizes[i] = next
                sizes[i + 1] = total - next
                props.onResize(node.id, sizes)
              }}
            />
          )}
        </div>
      ))}
    </div>
  )
}

function SplitHandle({
  direction,
  onDrag
}: {
  direction: 'row' | 'column'
  onDrag: (fraction: number) => void
}): React.ReactElement {
  const last = useRef(0)
  const extent = useRef(1)
  const row = direction === 'row'

  return (
    <div
      className={`term__handle term__handle--${direction}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        last.current = row ? e.clientX : e.clientY
        // Measure against the split container, since the fractions are relative to it.
        const split = e.currentTarget.parentElement?.parentElement
        extent.current = Math.max(1, row ? (split?.clientWidth ?? 1) : (split?.clientHeight ?? 1))
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        const pos = row ? e.clientX : e.clientY
        const delta = pos - last.current
        last.current = pos
        onDrag(delta / extent.current)
      }}
      onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
    />
  )
}

function LeafView({
  leaf,
  tab,
  workspaceId,
  cwd,
  inActiveGroup,
  onBind,
  onFocus,
  onClose,
  onError,
  onKey,
  onContextMenu
}: NodeProps & { leaf: Extract<PaneNode, { kind: 'leaf' }> }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const key = paneKey(tab.id, leaf.id)
  const active = tab.activeLeafId === leaf.id
  const spawning = useRef(false)
  /*
   * Read at focus time rather than depended on, because the effect below re-parents the xterm
   * element and rebinds its input: re-running it every time the user clicks into another column
   * would be churn for nothing. A mirror ref is always current by the time the awaits are done.
   */
  const mayFocus = useRef(false)
  // Never while the shortcuts dialog is up: a shell that finishes starting behind it must not take
  // the keyboard away from the dialog the user is typing into.
  mayFocus.current = active && inActiveGroup && !useApp.getState().settingsOpen
  /**
   * Whether this pane is still on screen — as distinct from the effect below merely re-running.
   * Declared first so it is set before that effect runs, StrictMode's second mount included.
   */
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const handle = await ensureTerminal(key)
      if (cancelled || !host.current) return
      host.current.appendChild(handle.element)
      handle.fit.fit()

      if (leaf.paneId) {
        handle.paneId = leaf.paneId
      } else if (!spawning.current) {
        spawning.current = true
        try {
          const { paneId } = await rpc['terminal:spawn']({
            workspaceId,
            // The workspace's folder is only where a pane starts when it was not split from one.
            cwd,
            cwdFrom: takeCwdSource(key),
            cols: handle.term.cols,
            rows: handle.term.rows
          })
          // Killed only if the pane is really gone. An effect that merely re-ran — the pane was
          // clicked while its shell was still starting, which changes `active` — has a successor
          // that saw the spawn in flight and did not start another; dropping this one would leave
          // the pane with no shell at all, for good.
          if (!mounted.current) {
            void rpc['terminal:kill']({ paneId })
            return
          }
          handle.paneId = paneId
          // A new process has not asked for anything yet, whatever the last one in this pane did.
          handle.modifyOtherKeys = 0
          onBind(leaf.id, paneId)
          // Binding changes `leaf.paneId`, which re-runs this effect; that run does the wiring.
          if (cancelled) return
        } catch (e) {
          onError(e instanceof Error ? e.message : String(e))
          return
        } finally {
          spawning.current = false
        }
      }

      // Runs before xterm turns the key into bytes, which is the only place a prefix binding can
      // intercept without racing the shell.
      //
      // A consumed keydown is cancelled HERE, in one place, rather than by each branch that
      // consumes one — forgetting it once is how Cmd+V came to paste twice. Returning false alone
      // is not enough: xterm then returns without cancelling, so the browser still produces a
      // keypress (the swallowed key types itself anyway) and Electron still runs the menu item
      // bound to the same chord.
      handle.term.attachCustomKeyEventHandler((e) => {
        // Alt+F4 on Windows closes the window — but only if nobody handles the key, and xterm would
        // turn it into an escape sequence and cancel it. Not ours, not xterm's, not cancelled.
        if (e.key === 'F4' && e.altKey && platform() === 'win32') return false
        const pass = onKey(leaf.id, e)
        if (!pass && e.type === 'keydown') e.preventDefault()
        return pass
      })

      // Rebind rather than stack: this effect re-runs once the pane id is assigned.
      handle.input?.dispose()
      handle.input = handle.term.onData((data) => {
        if (handle.paneId) window.rigee.writeTerminal(workspaceId, handle.paneId, data)
      })

      // Only the active pane of the active group. A terminal that arrives in another column —
      // dragged there, or restored beside the one being typed into — must not steal the keyboard.
      if (mayFocus.current) handle.term.focus()
    })()

    return () => {
      cancelled = true
      // The element stays alive in terminals.ts; only its parent link is dropped.
      const el = host.current?.firstElementChild
      if (el) host.current?.removeChild(el)
    }
    // `active` is a dependency although the body only reads the ref: becoming the tab's active
    // pane is what should hand it the keyboard, and dropping it from here would mean clicking
    // between panes no longer focuses the one you clicked.
  }, [key, leaf.id, leaf.paneId, workspaceId, cwd, onBind, onError, onKey, active])

  // Clicking into this column — its tab strip, say — hands its active pane the keyboard. The mount
  // effect above deliberately does not re-run for that; this is the whole of what it would do.
  useEffect(() => {
    if (active && inActiveGroup && !useApp.getState().settingsOpen) getTerminal(key)?.term.focus()
  }, [active, inActiveGroup, key])

  // And whenever the keyboard has gone nowhere — the settings dialog closed, a tab was dragged, a
  // menu item unmounted under the cursor — the pane the user was working in takes it back. Only
  // from <body>: never from a text box, an editor or the find bar that somebody chose to type in.
  useEffect(() => {
    if (!active || !inActiveGroup || useApp.getState().settingsOpen) return
    const focused = document.activeElement
    if (!focused || focused === document.body) getTerminal(key)?.term.focus()
  })

  // The pty's geometry must always match what xterm is showing, or line wrapping goes wrong.
  useEffect(() => {
    const el = host.current
    if (!el) return
    const push = (): void => {
      const handle = getTerminal(key)
      if (!handle) return
      handle.fit.fit()
      if (handle.paneId) {
        void rpc['terminal:resize']({
          paneId: handle.paneId,
          cols: handle.term.cols,
          rows: handle.term.rows
        })
      }
    }
    const ro = new ResizeObserver(push)
    ro.observe(el)
    push()
    return () => ro.disconnect()
  }, [key, leaf.paneId])

  return (
    <div
      className={`term__pane${active ? ' term__pane--active' : ''}`}
      onMouseDown={() => onFocus(leaf.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        onFocus(leaf.id)
        onContextMenu(leaf.id, e.clientX, e.clientY)
      }}
    >
      <div ref={host} className="term__surface" />
      <button
        className="term__close"
        title="Close pane"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => onClose(leaf.id)}
      >
        ×
      </button>
    </div>
  )
}
