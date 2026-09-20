import { useEffect, useRef, useState } from 'react'
import { onEvent, rpc } from '../ipc'
import type { IpcEvents } from '@shared/ipc'

type Request = IpcEvents['browser:authRequested']

/**
 * HTTP 401/407 prompt for the browser tabs.
 *
 * Main holds the Electron callback open until this answers, so every path out of here has to
 * reply — including dismissing with Escape. Not replying leaves the page loading forever, which
 * is exactly how it behaved before this dialog existed.
 *
 * Requests queue: a page with several protected subresources can raise more than one.
 */
export function AuthDialog(): React.ReactElement | null {
  const [queue, setQueue] = useState<Request[]>([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const userRef = useRef<HTMLInputElement>(null)

  useEffect(() => onEvent('browser:authRequested', (req) => setQueue((q) => [...q, req])), [])

  const current = queue[0] ?? null

  useEffect(() => {
    if (!current) return
    setUsername('')
    setPassword('')
    userRef.current?.focus()
  }, [current])

  if (!current) return null

  const answer = (u: string | null): void => {
    void rpc['browser:authResponse']({ requestId: current.requestId, username: u, password })
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
          {current.isProxy ? 'The proxy requires a sign-in' : 'This site requires a sign-in'}
        </div>
        <div className="modal__body">
          <div className="modal__host">{current.host}</div>
          {current.realm && <div className="modal__realm">{current.realm}</div>}
        </div>

        <label className="modal__field">
          <span>Username</span>
          <input ref={userRef} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </label>
        <label className="modal__field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') answer(null) }}
            autoComplete="off"
          />
        </label>

        <div className="modal__actions">
          <button type="button" className="btn" onClick={() => answer(null)}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!username}>Sign in</button>
        </div>
        {queue.length > 1 && (
          <div className="modal__more">{queue.length - 1} more request{queue.length > 2 ? 's' : ''} waiting</div>
        )}
      </form>
    </div>
  )
}
