import { useCallback, useEffect, useRef, useState } from 'react'
import { isMac, onEvent, rpc } from '../ipc'
import { bindPane, leaves, neighbourOf, newLeaf, removeLeaf, setSizes, splitLeaf } from '../paneTree'
import {
  disposeTerminal,
  ensureTerminal,
  getTerminal,
  paneKey,
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

  // Splits follow iTerm: Cmd-D beside, Shift-Cmd-D below.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = isMac() ? e.metaKey : e.ctrlKey
      if (!mod || e.key.toLowerCase() !== 'd') return
      e.preventDefault()
      e.stopPropagation()
      split(e.shiftKey ? 'column' : 'row')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [split])

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
      />
      {error && <div className="error-banner">{error}</div>}
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
  onError
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
  }, [key, leaf.id, leaf.paneId, workspaceId, cwd, onBind, onError, active])

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
