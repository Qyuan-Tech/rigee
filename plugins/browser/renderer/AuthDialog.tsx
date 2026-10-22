import { useEffect, useRef, useState } from 'react'
import { useT } from './l10n'
import { invoke, on } from './rpc'
import type { AuthRequestedEvent } from '../protocol'

/**
 * HTTP 401/407 prompt for the browser tabs.
 *
 * Main holds the Electron callback open until this answers, so every path out of here has to
 * reply — including dismissing with Escape. Not replying leaves the page loading forever, which
 * is exactly how it behaved before this dialog existed.
 *
 * Requests queue: a page with several protected subresources can raise more than one.
 *
 * Mounted by the shell for as long as the plugin is active, which is from the moment a browser
 * tab first renders — a challenge cannot arrive before there is a view to raise it.
 */
export function AuthDialog(): React.ReactElement | null {
  const { t, tn } = useT()
  const [queue, setQueue] = useState<AuthRequestedEvent[]>([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const userRef = useRef<HTMLInputElement>(null)

  useEffect(() => on('authRequested', (req) => setQueue((q) => [...q, req])), [])

  const current = queue[0] ?? null

  useEffect(() => {
    if (!current) return
    setUsername('')
    setPassword('')
    userRef.current?.focus()
  }, [current])

  if (!current) return null

  const answer = (u: string | null): void => {
    void invoke('browser:authResponse', { requestId: current.requestId, username: u, password })
    setQueue((q) => q.slice(1))
  }

  return (
    <div className="modal__scrim" onMouseDown={() => answer(null)}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); answer(username) }}
      >
        <div className="modal__title">
          {current.isProxy ? t('The proxy requires a sign-in') : t('This site requires a sign-in')}
        </div>
        <div className="modal__body">
          <div className="modal__host">{current.host}</div>
          {current.realm && <div className="modal__realm">{current.realm}</div>}
        </div>

        <label className="modal__field">
          <span>{t('Username')}</span>
          <input ref={userRef} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </label>
        <label className="modal__field">
          <span>{t('Password')}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') answer(null) }}
            autoComplete="off"
          />
        </label>

        <div className="modal__actions">
          <button type="button" className="btn" onClick={() => answer(null)}>{t('Cancel')}</button>
          <button type="submit" className="btn btn--primary" disabled={!username}>{t('Sign in')}</button>
        </div>
        {queue.length > 1 && (
          <div className="modal__more">{tn(queue.length - 1, '1 more request waiting', '{n} more requests waiting')}</div>
        )}
      </form>
    </div>
  )
}
