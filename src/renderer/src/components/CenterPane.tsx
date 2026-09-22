import { isMac } from '../ipc'
import { useActiveTab } from '../store'
import { PluginEditorPane, PluginTabPane } from './PluginHost'
import { TerminalPane } from './TerminalPane'

/**
 * The centre pane: one tab at a time, three kinds.
 *
 * Two of the three are plugin territory. Terminals are the shell's own, because the pty transport
 * and the split tree are part of what the shell is; everything else — a file, a diff, a web page —
 * is something a plugin renders. The switch stays exhaustive so a new tab kind cannot be added
 * without deciding what shows it.
 */
export function CenterPane(): React.ReactElement {
  const tab = useActiveTab()

  if (!tab) return <EmptyState />

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

function EmptyState(): React.ReactElement {
  const mod = isMac() ? 'Cmd' : 'Ctrl'
  return (
    <div className="empty">
      <div>
        <EmptyMark />
        <div className="empty__title">Nothing open</div>
        <div className="empty__hint">
          <div>
            Start a terminal with <span className="kbd">{mod}</span>
            <span className="kbd">T</span>, or press the buttons in the tab strip
          </div>
          <div>Click a file in the explorer to read it</div>
          <div>Click a change on the right to see its diff</div>
        </div>
      </div>
    </div>
  )
}
