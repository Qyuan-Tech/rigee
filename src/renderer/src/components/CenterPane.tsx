import { Fragment, useCallback, useRef } from 'react'
import { isMac } from '../ipc'
import { formatTrigger, triggersFor } from '@shared/keymap'
import { useKeymap } from '../shortcuts'
import { useApp, useRow } from '../store'
import { PluginEditorPane, PluginTabPane } from './PluginHost'
import { Splitter } from './Splitter'
import { TabStrip } from './TabStrip'
import { TerminalPane } from './TerminalPane'
import type { TabGroup } from '@shared/types'

/**
 * The centre of the window: a row of editor groups, left to right.
 *
 * One group is the ordinary case and looks exactly like the single pane this replaced. Two is the
 * point of the feature — a PDF open beside a terminal talking to an agent — and the row generalises
 * to as many as the window can hold.
 *
 * Each group renders only its own active tab, keyed by tab id, which is what keeps a tab id mounted
 * in exactly one place. That matters more than it looks: ptys, native browser views and PDF reading
 * positions are all keyed by tab id outside React, and two panes sharing one would fight over all
 * three — two xterms on one shell, one native view snapping between two rectangles.
 */
export function CenterPane(): React.ReactElement {
  const row = useRow()
  const workspaceId = useApp((s) => s.activeWorkspaceId)
  const setGroupBoundary = useApp((s) => s.setGroupBoundary)
  const focusGroup = useApp((s) => s.focusGroup)
  const rowEl = useRef<HTMLDivElement>(null)

  /**
   * Splitter reports the CUMULATIVE pixel offset since pointer-down, plus the value it captured
   * then — so the boundary is set absolutely. Handing it an incremental delta would integrate the
   * same movement on every pointermove and the divider would accelerate away from the cursor.
   */
  const onDrag = useCallback(
    (index: number) => (dx: number, startFraction: number) => {
      const width = rowEl.current?.getBoundingClientRect().width ?? 0
      if (!workspaceId || width === 0) return
      setGroupBoundary(workspaceId, index, startFraction + dx / width)
    },
    [setGroupBoundary, workspaceId]
  )

  return (
    <div className="groups" ref={rowEl}>
      {row.groups.map((group, i) => (
        <Fragment key={group.id}>
          <div
            className={`group${group.id === row.activeGroupId ? ' group--active' : ''}`}
            // For goto_group, which hands the column the keyboard as well as the highlight.
            data-group-id={group.id}
            style={{ flexGrow: row.sizes[i] ?? 1, flexBasis: 0 }}
            // Capture, so clicking anywhere in the group — the editor, the terminal, a PDF page —
            // says "this is the column I am working in", and the next file from the explorer lands
            // here. A browser tab is the known gap: its page is a native view composited over the
            // document, so clicks inside it never reach the DOM and that group is reachable only
            // through its own tab strip.
            onMouseDownCapture={() => { if (workspaceId) focusGroup(workspaceId, group.id) }}
          >
            <TabStrip groupId={group.id} />
            <GroupBody group={group} solo={row.groups.length === 1} />
          </div>
          {i < row.groups.length - 1 && (
            <Splitter orientation="vertical" onDrag={onDrag(i)} value={row.sizes[i] ?? 0} />
          )}
        </Fragment>
      ))}
    </div>
  )
}

/**
 * What one group shows: its active tab, or the empty state.
 *
 * Three kinds, and only the first is the shell's own. Terminals are core because the pty transport
 * and the split tree are part of what the shell is; a file and a plugin-owned tab are rendered by
 * whoever claimed them. The switch stays exhaustive so a new kind cannot be added without deciding
 * what draws it.
 */
function GroupBody({ group, solo }: { group: TabGroup; solo: boolean }): React.ReactElement {
  const tab = group.tabs.find((t) => t.id === group.activeTabId)
  if (!tab) return <EmptyState solo={solo} />

  switch (tab.kind) {
    case 'terminal':
      return <TerminalPane key={tab.id} tab={tab} />
    case 'editor':
      return <PluginEditorPane key={tab.id} tab={tab} />
    case 'custom':
      return <PluginTabPane key={tab.id} tab={tab} />
  }
}

/** The app mark, at the size and weight the empty state can carry without shouting. */
function EmptyMark(): React.ReactElement {
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" className="empty__mark" aria-hidden="true">
      <defs>
        <linearGradient id="emptyMark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="52%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#c084fc" />
        </linearGradient>
      </defs>
      <path
        d="M14 13 L29 28 L14 43"
        fill="none"
        stroke="url(#emptyMark)"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="34" y="37" width="16" height="5" rx="2.5" fill="url(#emptyMark)" />
    </svg>
  )
}

/**
 * Nothing open.
 *
 * Quiet when it is one column among several: the mark and three lines of advice are right for an
 * empty window and far too loud for a 300px group the user emptied on purpose and is about to drop
 * something into.
 */
function EmptyState({ solo }: { solo: boolean }): React.ReactElement {
  // Whatever new_tab is bound to now, so the advice survives the user rebinding it.
  const newTab = triggersFor(useKeymap(), 'new_tab')[0]
  if (!solo) return <div className="empty"><div className="muted">Nothing open</div></div>

  return (
    <div className="empty">
      <div>
        <EmptyMark />
        <div className="empty__title">Nothing open</div>
        <div className="empty__hint">
          <div>
            {newTab ? (
              <>
                Start a terminal with <span className="kbd">{formatTrigger(newTab, isMac())}</span>, or
                press the buttons in the tab strip
              </>
            ) : (
              'Start a terminal with the buttons in the tab strip'
            )}
          </div>
          <div>Click a file in the explorer to read it</div>
          <div>Click a change on the right to see its diff</div>
        </div>
      </div>
    </div>
  )
}
