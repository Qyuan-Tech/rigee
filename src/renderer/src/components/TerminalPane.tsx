import { useCallback, useEffect, useRef, useState } from 'react'
import { isMac, onEvent, rpc } from '../ipc'
import { clipboardAction, formatChord, resolvePrefixKey } from '../keys'
import { bindPane, leaves, neighbourOf, newLeaf, removeLeaf, setSizes, splitLeaf } from '../paneTree'
import {
  copyPane,
  disposeTerminal,
  ensureTerminal,
  getTerminal,
  paneKey,
  paneSelection,
  pastePane,
  selectAllInPane,
  reapPanes,
  writeToPane
} from '../terminals'
import { useApp } from '../store'
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
 * id and coalesced in main — never through ipcRenderer.
 */
export function TerminalPane({ tab }: { tab: TerminalTab }): React.ReactElement {
  const workspaceId = useApp((s) => s.activeWorkspaceId)
  const workspace = useApp((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null)
  const updateTab = useApp((s) => s.updateTab)
  const [error, setError] = useState<string | null>(null)
  const bindings = useApp((s) => s.keybindings)
  const [prefixArmed, setPrefixArmed] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; leafId: string } | null>(null)
  // Synchronous mirror: the key handler runs before React can re-render.
  const armed = useRef(false)

  const cwd = workspace?.folders[0]?.path ?? workspace?.defaultCwd ?? '.'

  const patch = useCallback(
    (fn: (t: TerminalTab) => Partial<TerminalTab>) => {
      if (!workspaceId) return
      updateTab(workspaceId, tab.id, fn(tab))
    },
    [tab, updateTab, workspaceId]
  )

  // One port per workspace; requesting it again replaces the previous one.
  useEffect(() => {
    if (!workspaceId) return
    void rpc['terminal:requestPort']({ workspaceId })
    return window.onestop.onTerminalData(workspaceId, (paneId, data) => writeToPane(paneId, data))
  }, [workspaceId])

  const closeLeaf = useCallback(
    (leafId: string) => {
      if (!workspaceId) return
      const leaf = leaves(tab.root).find((l) => l.id === leafId)
      if (leaf?.paneId) void rpc['terminal:kill']({ paneId: leaf.paneId })
      disposeTerminal(paneKey(tab.id, leafId))

      const next = removeLeaf(tab.root, leafId)
      if (next === null) {
        // The last pane closed, so the tab has nothing left to show.
        useApp.getState().closeTab(workspaceId, tab.id)
        return
      }
      const focus = neighbourOf(tab.root, leafId) ?? leaves(next)[0]?.id ?? ''
      updateTab(workspaceId, tab.id, { root: next, activeLeafId: focus })
    },
    [tab.root, tab.id, updateTab, workspaceId]
  )

  // A shell that exits takes its pane with it, the way closing a terminal should.
  useEffect(() => {
    return onEvent('terminal:exit', ({ paneId }) => {
      const leaf = leaves(tab.root).find((l) => l.paneId === paneId)
      if (leaf) closeLeaf(leaf.id)
    })
  }, [tab.root, closeLeaf])

  const split = useCallback(
    (direction: 'row' | 'column') => {
      const { root, newLeafId } = splitLeaf(tab.root, tab.activeLeafId, direction, newLeaf())
      patch(() => ({ root, activeLeafId: newLeafId }))
    },
    [tab.root, tab.activeLeafId, patch]
  )

  /**
   * tmux-style prefix handling, run from xterm's key hook so it intercepts before the bytes
   * reach the shell. Returns false to swallow the key.
   *
   * Pressing the prefix twice sends a literal one, which is the escape hatch tmux gives you for
   * Ctrl-A at the start of a line. An unbound key after the prefix is swallowed, also like tmux:
   * passing it through would run a command the user did not mean to type.
   */
  const handleKey = useCallback(
    (leafId: string, e: KeyboardEvent): boolean => {
      if (e.type !== 'keydown') return true

      const outcome = resolvePrefixKey(e, bindings, armed.current)
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
          const handle = getTerminal(paneKey(tab.id, leafId))
          if (handle?.paneId && workspaceId) {
            window.onestop.writeTerminal(workspaceId, handle.paneId, outcome.bytes)
          }
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

        case 'passthrough': {
          const clip = clipboardAction(e, isMac())
          if (clip === 'copy') {
            // Nothing selected: let it through rather than swallow. On macOS an empty Cmd+C
            // should stay inert, not become a key that mysteriously does nothing.
            if (!copyPane(paneKey(tab.id, leafId))) return true
            return false
          }
          if (clip === 'paste') {
            void pastePane(paneKey(tab.id, leafId))
            return false
          }

          // The iTerm combos stay as a second way in, for anyone who reaches for them.
          const mod = isMac() ? e.metaKey : e.ctrlKey
          if (mod && e.key.toLowerCase() === 'd') {
            split(e.shiftKey ? 'column' : 'row')
            return false
          }
          return true
        }
      }
    },
    [bindings, split, closeLeaf, tab.id, workspaceId]
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

  if (!workspaceId || !workspace) return <div className="empty">No workspace.</div>

  return (
    <div className="term">
      <NodeView
        node={tab.root}
        tab={tab}
        workspaceId={workspaceId}
        cwd={cwd}
        onBind={(leafId, paneId) => patch((t) => ({ root: bindPane(t.root, leafId, paneId) }))}
        onFocus={(leafId) => patch(() => ({ activeLeafId: leafId }))}
        onClose={closeLeaf}
        onResize={(splitId, sizes) => patch((t) => ({ root: setSizes(t.root, splitId, sizes) }))}
        onError={setError}
        onKey={handleKey}
        onContextMenu={(leafId, x, y) => setMenu({ x, y, leafId })}
      />

      {prefixArmed && <div className="term__prefix">prefix</div>}

      {menu && (
        <PaneMenu
          x={menu.x}
          y={menu.y}
          bindings={bindings}
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

function PaneMenu({
  x,
  y,
  bindings,
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
  bindings: { prefix: string; splitRight: string; splitDown: string; closePane: string }
  selection: string
  onCopy: () => void
  onSelectAll: () => void
  onPaste: () => void
  onSplitRight: () => void
  onSplitDown: () => void
  onClose: () => void
}): React.ReactElement {
  const hint = (key: string): string =>
    `${formatChord(bindings.prefix, isMac())} ${key}`
  // The shortcut a terminal can spare: Ctrl+C and Ctrl+V are SIGINT and literal-quote.
  const clip = isMac() ? { copy: '⌘C', paste: '⌘V' } : { copy: 'Ctrl+Shift+C', paste: 'Ctrl+Shift+V' }

  return (
    <div
      className="menu"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button className="menu__item" disabled={!selection} onClick={onCopy}>
        <span>Copy</span>
        <span className="menu__hint">{clip.copy}</span>
      </button>
      <button className="menu__item" onClick={onPaste}>
        <span>Paste</span>
        <span className="menu__hint">{clip.paste}</span>
      </button>
      {/* Reachable no matter what the running program has done with the mouse. */}
      <button className="menu__item" onClick={onSelectAll}>
        <span>Select All</span>
        <span className="menu__hint">{isMac() ? '⌥ drag' : 'shift drag'}</span>
      </button>
      <div className="menu__sep" />
      <button className="menu__item" onClick={onSplitRight}>
        <span>Split right</span>
        <span className="menu__hint">{hint(bindings.splitRight)}</span>
      </button>
      <button className="menu__item" onClick={onSplitDown}>
        <span>Split down</span>
        <span className="menu__hint">{hint(bindings.splitDown)}</span>
      </button>
      <div className="menu__sep" />
      <button className="menu__item" onClick={onClose}>
        <span>Close pane</span>
        <span className="menu__hint">{hint(bindings.closePane)}</span>
      </button>
    </div>
  )
}

interface NodeProps {
  node: PaneNode
  tab: TerminalTab
  workspaceId: string
  cwd: string
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
            cwd,
            cols: handle.term.cols,
            rows: handle.term.rows
          })
          if (cancelled) {
            void rpc['terminal:kill']({ paneId })
            return
          }
          handle.paneId = paneId
          onBind(leaf.id, paneId)
        } catch (e) {
          onError(e instanceof Error ? e.message : String(e))
          return
        } finally {
          spawning.current = false
        }
      }

      // Runs before xterm turns the key into bytes, which is the only place a prefix binding can
      // intercept without racing the shell.
      handle.term.attachCustomKeyEventHandler((e) => onKey(leaf.id, e))

      // Rebind rather than stack: this effect re-runs once the pane id is assigned.
      handle.input?.dispose()
      handle.input = handle.term.onData((data) => {
        if (handle.paneId) window.onestop.writeTerminal(workspaceId, handle.paneId, data)
      })

      if (active) handle.term.focus()
    })()

    return () => {
      cancelled = true
      // The element stays alive in terminals.ts; only its parent link is dropped.
      const el = host.current?.firstElementChild
      if (el) host.current?.removeChild(el)
    }
  }, [key, leaf.id, leaf.paneId, workspaceId, cwd, onBind, onError, onKey, active])

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
