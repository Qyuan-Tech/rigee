/**
 * Whole-pane failure, in one place.
 *
 * Lifted out of EditorPane when the editor became a plugin: it is the shell's standard answer to
 * "this pane has nothing to show", and every plugin viewer needs the same one. Duplicating it per
 * plugin is how three panes end up disagreeing about what an error looks like.
 */
export function Notice({
  children,
  tone = 'muted'
}: {
  children: React.ReactNode
  tone?: 'muted' | 'error'
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'grid',
        placeItems: 'center',
        height: '100%',
        padding: 24,
        textAlign: 'center',
        fontSize: 12,
        color: tone === 'error' ? 'var(--git-deleted)' : 'var(--fg-muted)'
      }}
    >
      {children}
    </div>
  )
}
