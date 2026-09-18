import { useEffect } from 'react'
import { showOnly } from '../browserViews'
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
  return (
    <div
      style={{
        flex: 1,
        display: 'grid',
        placeItems: 'center',
        color: 'var(--fg-muted)',
        fontSize: 12,
        lineHeight: 2
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <div>No tab open</div>
        <div style={{ opacity: 0.7 }}>Use the buttons in the tab strip to open a terminal or a browser tab,</div>
        <div style={{ opacity: 0.7 }}>or click a file in the explorer.</div>
      </div>
    </div>
  )
}
