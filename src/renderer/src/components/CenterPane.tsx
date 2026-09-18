import { useEffect } from 'react'
import { showOnly } from '../browserViews'
import { isMac } from '../ipc'
import { useActiveTab } from '../store'
import { BrowserPane } from './BrowserPane'
import { DiffPane, EditorPane } from './EditorPane'
import { TerminalPane } from './TerminalPane'

export function CenterPane(): React.ReactElement {
  const tab = useActiveTab()

  // Any non-browser tab means every native browser view must be hidden, or it would cover the
  // editor. BrowserPane re-shows its own view when it mounts.
  useEffect(() => {
    if (!tab || tab.kind !== 'browser') showOnly(null)
  }, [tab])

  if (!tab) return <EmptyState />

  switch (tab.kind) {
    case 'terminal':
      return <TerminalPane key={tab.id} tab={tab} />
    case 'editor':
      return <EditorPane key={tab.id} tab={tab} />
    case 'diff':
      return <DiffPane key={tab.id} tab={tab} />
    case 'browser':
      return <BrowserPane key={tab.id} tab={tab} />
  }
}

function EmptyState(): React.ReactElement {
  const mod = isMac() ? '⌘' : 'Ctrl'
  return (
    <div className="empty">
      <div>
        <div className="empty__mark" />
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
