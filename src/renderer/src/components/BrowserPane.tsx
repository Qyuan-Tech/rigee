import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ensureView, showOnly, viewIdFor } from '../browserViews'
import { onEvent, rpc } from '../ipc'
import { useApp } from '../store'
import type { BrowserTab, ViewBounds } from '@shared/types'

/**
 * The browser tab.
 *
 * The page itself is a native WebContentsView composited over this component by the main
 * process — it is not in the DOM. All this component does is render an empty placeholder, measure
 * it, and keep the native view glued to that rectangle.
 *
 * Bounds are pushed synchronously in a layout effect and from a ResizeObserver, both of which
 * fire before paint. During a splitter drag the native view still trails the DOM by roughly a
 * frame; that is inherent to compositing a separate view and cannot be fully removed.
 */
export function BrowserPane({ tab }: { tab: BrowserTab }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const workspaceId = useApp((s) => s.activeWorkspaceId)
  const updateTab = useApp((s) => s.updateTab)
  const [address, setAddress] = useState(tab.url)
  const [editing, setEditing] = useState(false)

  const measure = useCallback((): ViewBounds | null => {
    const el = host.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.max(0, Math.round(r.width)),
      height: Math.max(0, Math.round(r.height))
    }
  }, [])

  const pushBounds = useCallback(() => {
    const viewId = viewIdFor(tab.id)
    const bounds = measure()
    if (!viewId || !bounds) return
    void rpc['browser:setBounds']({ viewId, bounds })
  }, [measure, tab.id])

  // Create on first activation, then show it and hide the others.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const bounds = measure()
      if (!bounds) return
      await ensureView(tab.id, tab.url, bounds)
      if (cancelled) return
      showOnly(tab.id)
      pushBounds()
    })()
    return () => {
      cancelled = true
      // Leaving the tab hides the view; the view itself outlives this component.
      showOnly(null)
    }
  }, [tab.id, tab.url, measure, pushBounds])

  useLayoutEffect(() => {
    pushBounds()
    const el = host.current
    if (!el) return
    const ro = new ResizeObserver(pushBounds)
    ro.observe(el)
    window.addEventListener('resize', pushBounds)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', pushBounds)
    }
  }, [pushBounds])

  // Navigation state comes back from main.
  useEffect(() => {
    return onEvent('browser:state', (s) => {
      if (s.viewId !== viewIdFor(tab.id)) return
      if (!workspaceId) return
      updateTab(workspaceId, tab.id, {
        url: s.url,
        title: s.title || s.url,
        canGoBack: s.canGoBack,
        canGoForward: s.canGoForward,
        loading: s.loading
      })
      if (!editing) setAddress(s.url)
    })
  }, [tab.id, workspaceId, updateTab, editing])

  const navigate = useCallback(
    (raw: string) => {
      const viewId = viewIdFor(tab.id)
      if (!viewId) return
      void rpc['browser:navigate']({ viewId, url: normalizeUrl(raw) })
    },
    [tab.id]
  )

  const act = useCallback(
    (fn: 'browser:goBack' | 'browser:goForward' | 'browser:reload' | 'browser:stop' | 'browser:openDevTools') => {
      const viewId = viewIdFor(tab.id)
      if (viewId) void rpc[fn]({ viewId })
    },
    [tab.id]
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 6px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-elevated)'
        }}
      >
        <NavButton disabled={!tab.canGoBack} title="Back" onClick={() => act('browser:goBack')}>←</NavButton>
        <NavButton disabled={!tab.canGoForward} title="Forward" onClick={() => act('browser:goForward')}>→</NavButton>
        <NavButton
          title={tab.loading ? 'Stop' : 'Reload'}
          onClick={() => act(tab.loading ? 'browser:stop' : 'browser:reload')}
        >
          {tab.loading ? '×' : '↻'}
        </NavButton>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => { setEditing(true); e.target.select() }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { navigate(address); e.currentTarget.blur() }
            if (e.key === 'Escape') { setAddress(tab.url); e.currentTarget.blur() }
          }}
          spellCheck={false}
          style={{ flex: 1, userSelect: 'text' }}
        />
        <NavButton title="DevTools" onClick={() => act('browser:openDevTools')}>⚙</NavButton>
      </div>

      {/* The native view is composited over exactly this rectangle. Keep it empty. */}
      <div ref={host} style={{ flex: 1, minHeight: 0, background: '#ffffff' }} />
    </div>
  )
}

function NavButton({
  children,
  onClick,
  title,
  disabled
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  disabled?: boolean
}): React.ReactElement {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 26,
        height: 24,
        borderRadius: 3,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.3 : 0.85
      }}
    >
      {children}
    </button>
  )
}

/** Treat input with no scheme and no dot as a search, matching what every browser does. */
function normalizeUrl(raw: string): string {
  const s = raw.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('about:')) return s
  if (/^localhost(:\d+)?(\/|$)/.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) return `http://${s}`
  if (/\s/.test(s) || !s.includes('.')) return `https://www.google.com/search?q=${encodeURIComponent(s)}`
  return `https://${s}`
}
