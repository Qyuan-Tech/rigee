import { Fragment, useCallback, useRef } from 'react'
import { groupById, type GroupRow } from '../groups'
import { isMac } from '../ipc'
import { formatTrigger, triggersFor } from '@shared/keymap'
import { useKeymap } from '../shortcuts'
import { t, tx } from '../i18n'
import { useApp, useRow } from '../store'
import { PluginEditorPane, PluginTabPane } from './PluginHost'
import { Splitter } from './Splitter'
import { TabStrip } from './TabStrip'
import { TerminalPane } from './TerminalPane'
import type { GroupId, GroupLayout, TabGroup } from '@shared/types'

type SplitNode = Extract<GroupLayout, { kind: 'split' }>

/**
 * The centre of the window: the editor groups, side by side, stacked, or both.
 *
 * One group is the ordinary case and looks exactly like the single pane this replaced. Two is the
 * point of the feature — a PDF open beside a terminal talking to an agent — and the layout
 * generalises to as many as the window can hold, nested as deep as the splits go.
 *
 * Each group renders only its own active tab, keyed by tab id, which is what keeps a tab id mounted
 * in exactly one place. That matters more than it looks: ptys, native browser views and PDF reading
 * positions are all keyed by tab id outside React, and two panes sharing one would fight over all
 * three — two xterms on one shell, one native view snapping between two rectangles.
 */
export function CenterPane(): React.ReactElement {
  const row = useRow()
  const { layout } = row
  // A lone group is drawn as a split of one, so the first split, either way, keeps it where React
  // has it — still mounted — rather than re-creating everything in it a level down. A split deeper
  // in does re-create the group it wraps, which every pane survives: switching tabs does the same.
  const top: SplitNode =
    layout.kind === 'split' ? layout : { kind: 'split', id: '', direction: 'row', children: [layout], sizes: [1] }
  return <Split row={row} node={top} />
}

/**
 * One split: its children side by side or one above the other, with a divider between each two.
 * The outermost is `.groups` itself, filling the centre; one inside another takes its share.
 */
function Split({ row, node, size }: { row: GroupRow; node: SplitNode; size?: number }): React.ReactElement {
  const workspaceId = useApp((s) => s.activeWorkspaceId)
  const setGroupBoundary = useApp((s) => s.setGroupBoundary)
  const el = useRef<HTMLDivElement>(null)
  const across = node.direction === 'row'

  /**
   * Splitter reports the CUMULATIVE pixel offset since pointer-down, plus the value it captured
   * then — so the boundary is set absolutely. Handing it an incremental delta would integrate the
   * same movement on every pointermove and the divider would accelerate away from the cursor.
   */
  const onDrag = useCallback(
    (index: number) => (delta: number, startFraction: number) => {
      const box = el.current?.getBoundingClientRect()
      const extent = (across ? box?.width : box?.height) ?? 0
      if (!workspaceId || extent === 0) return
      setGroupBoundary(workspaceId, node.id, index, startFraction + delta / extent)
    },
    [across, node.id, setGroupBoundary, workspaceId]
  )

  return (
    <div
      ref={el}
      className={`groups groups--${node.direction}`}
      style={size === undefined ? undefined : { flexGrow: size, flexBasis: 0 }}
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {child.kind === 'split'
            ? <Split row={row} node={child} size={node.sizes[i] ?? 1} />
            : <Group row={row} groupId={child.id} size={node.sizes[i] ?? 1} />}
          {i < node.children.length - 1 && (
            <Splitter orientation={across ? 'vertical' : 'horizontal'} onDrag={onDrag(i)} value={node.sizes[i] ?? 0} />
          )}
        </Fragment>
      ))}
    </div>
  )
}

function Group({ row, groupId, size }: { row: GroupRow; groupId: GroupId; size: number }): React.ReactElement | null {
  const workspaceId = useApp((s) => s.activeWorkspaceId)
  const focusGroup = useApp((s) => s.focusGroup)
  const group = groupById(row, groupId)
  if (!group) return null

  return (
    <div
      className={`group${group.id === row.activeGroupId ? ' group--active' : ''}`}
      // For goto_group, which hands the group the keyboard as well as the highlight.
      data-group-id={group.id}
      style={{ flexGrow: size, flexBasis: 0 }}
      // Capture, so clicking anywhere in the group — the editor, the terminal, a PDF page — says
      // "this is the group I am working in", and the next file from the explorer lands here. A
      // browser tab is the known gap: its page is a native view composited over the document, so
      // clicks inside it never reach the DOM and that group is reachable only through its own tab
      // strip.
      onMouseDownCapture={() => { if (workspaceId) focusGroup(workspaceId, group.id) }}
    >
      <TabStrip groupId={group.id} />
      <GroupBody group={group} solo={row.groups.length === 1} />
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
  if (!solo) return <div className="empty"><div className="muted">{t('Nothing open')}</div></div>

  return (
    <div className="empty">
      <div>
        <EmptyMark />
        <div className="empty__title">{t('Nothing open')}</div>
        <div className="empty__hint">
          <div>
            {newTab
              ? tx('Start a terminal with {key}, or press the buttons in the tab strip', {
                  key: <span className="kbd">{formatTrigger(newTab, isMac())}</span>
                })
              : t('Start a terminal with the buttons in the tab strip')}
          </div>
          <div>{t('Click a file in the explorer to read it')}</div>
          <div>{t('Click a change on the right to see its diff')}</div>
        </div>
      </div>
    </div>
  )
}
