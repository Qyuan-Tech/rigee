import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BackIcon, DevToolsIcon, ForwardIcon, ReloadIcon, StopIcon } from '@renderer/icons'
import { useApp } from '@renderer/store'
import { invoke, on } from './rpc'
import {
  ensureView,
  focusView,
  hideView,
  isFocusTarget,
  isFocusTargetNow,
  releaseFocus,
  showView,
  viewIdFor
} from './views'
import type { PluginTabProps } from '@renderer/plugins/bindings'
import type { ViewBounds } from '@shared/types'

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
 *
 * Showing and hiding are this component's job, and strictly for ITS OWN view. The predecessor
 * showed one view and hid every other, which is the same statement while only one pane can be
 * mounted and a silent disaster once the centre pane is a row of editor groups: a PDF beside a page
 * is fine, two pages side by side and the second one to mount blanks the first. Each group renders
 * its own active tab, so every way out of a browser tab — switching tabs, closing the last one,
 * closing the group, switching workspaces — unmounts this component and hides exactly one view.
 *
 * Keyboard focus is NOT part of that. It goes to the active group's active tab and to nothing else;
 * a page being hidden in one column must not pull the cursor out of the page in the next one.
 */
export function BrowserPane({
  tabId,
  state,
  patchState,
  setTitle
}: PluginTabProps): React.ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const { url, canGoBack, canGoForward, loading } = readState(state)
  const [address, setAddress] = useState(url)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * Where the view opens, read once at mount.
   *
   * `state.url` changes on every navigation, and the tab-object version kept it in the create
   * effect's dependencies — so each did-navigate-in-page from an SPA re-ran the effect, whose
   * cleanup hides the page and hands the keyboard back to the shell. That is a flicker and a lost
   * keystroke per route change on sites that fire one per scroll.
   */
  const openAt = useRef(url)

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
    const viewId = viewIdFor(tabId)
    const bounds = measure()
    if (!viewId || !bounds) return
    void invoke('browser:setBounds', { viewId, bounds })
  }, [measure, tabId])

  /**
   * A `loading` flag restored from disk is stale by definition: the page that was loading died
   * with the process that was loading it. The shell's sanitizeTabs used to clear it; the plugin
   * owns its own state now, and without this a restored tab offers a Stop button that stops
   * nothing until the first navigation event arrives.
   *
   * Gated on there being no native view for this tab yet, which is the honest test for "restored
   * from disk" — a tab that already has one is live, and clearing its flag on a remount is a real
   * bug: leave a slow page loading, switch to a terminal tab and come back, and the Stop button
   * would turn into Reload while the load was still running, so the only button on offer restarted
   * the fetch instead of cancelling it.
   */
  useEffect(() => {
    if (state.loading === true && !viewIdFor(tabId)) patchState({ loading: false })
    // Mount only. Within a session `loading` is live and must not be second-guessed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Create on first activation, then composite it over this pane's rectangle. This view only.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const bounds = measure()
      if (!bounds) return
      await ensureView(tabId, openAt.current, bounds)
      if (cancelled) return
      // Re-measured rather than reused: creating the view took a round trip to main, and a splitter
      // drag or a window resize in the meantime would show the page at the old rectangle.
      showView(tabId, measure() ?? bounds)
      // Asked again HERE, not read off the effect below's flag, because the view did not exist when
      // that one ran — a browser tab opened into the active group would otherwise come up with the
      // keyboard still on the tab strip, and the fix is not to await inside a focus effect that
      // has to stay synchronous to release in the right order.
      if (isFocusTargetNow(tabId)) focusView(tabId)
    })()
    return () => {
      cancelled = true
      // Leaving the tab hides this view, and only this one; it outlives the component.
      hideView(tabId)
    }
  }, [tabId, measure])

  /**
   * The keyboard, claimed and given back.
   *
   * Separate from the effect above because the two answer to different things: every mounted pane
   * is visible, only the active group's active tab may type. Fusing them is the bug this split
   * exists to kill — two panes mounting in one commit would have settled the keyboard by whichever
   * IPC arrived last, and hiding one group's page would have taken focus off another's.
   *
   * The release is conditional in main: leaving one group and entering another is a single commit,
   * and React runs the two panes' cleanups and effects in DOM order rather than in the order the
   * user's attention moved, so an unconditional hand-back would half the time undo the new group's
   * claim and leave the keyboard on the shell.
   */
  const focusTarget = useApp((s) => isFocusTarget(s, tabId))
  useEffect(() => {
    if (!focusTarget) return
    // A no-op while the view is still being created; the create effect focuses it on arrival.
    focusView(tabId)
    return () => { releaseFocus(tabId) }
  }, [tabId, focusTarget])

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
    return on('state', (s) => {
      if (s.viewId !== viewIdFor(tabId)) return
      patchState({
        url: s.url,
        canGoBack: s.canGoBack,
        canGoForward: s.canGoForward,
        loading: s.loading
      })
      // The URL is the tooltip, as it was when the shell owned browser tabs and `tabTooltip`
      // returned `tab.url`. A page title alone does not tell you which of three open GitHub tabs
      // you are hovering.
      setTitle(s.title || s.url, s.url)
      // A load starting is the only honest signal that the last failure is history.
      if (s.loading) setError(null)
      if (!editing) setAddress(s.url)
    })
  }, [tabId, patchState, setTitle, editing])

  // A main-frame load that failed. Beside the page rather than instead of it: the previous page is
  // still there and still usable, and the address bar is how the user retries.
  useEffect(() => {
    return on('error', (e) => {
      if (e.viewId === viewIdFor(tabId)) setError(e.message)
    })
  }, [tabId])

  const navigate = useCallback(
    (raw: string) => {
      const viewId = viewIdFor(tabId)
      if (!viewId) return
      void invoke('browser:navigate', { viewId, url: normalizeUrl(raw) })
    },
    [tabId]
  )

  const act = useCallback(
    (
      command:
        | 'browser:goBack'
        | 'browser:goForward'
        | 'browser:reload'
        | 'browser:stop'
        | 'browser:openDevTools'
    ) => {
      const viewId = viewIdFor(tabId)
      // Whole command names rather than a `browser:${verb}` template: the typed client checks the
      // name against the command map, and a template literal defeats that check entirely.
      if (viewId) void invoke(command, { viewId })
    },
    [tabId]
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="browser__bar">
        <button
          className="icon-button"
          disabled={!canGoBack}
          title="Back"
          onClick={() => act('browser:goBack')}
        >
          <BackIcon size={14} />
        </button>
        <button
          className="icon-button"
          disabled={!canGoForward}
          title="Forward"
          onClick={() => act('browser:goForward')}
        >
          <ForwardIcon size={14} />
        </button>
        <button
          className="icon-button"
          title={loading ? 'Stop' : 'Reload'}
          onClick={() => act(loading ? 'browser:stop' : 'browser:reload')}
        >
          {loading ? <StopIcon size={13} /> : <ReloadIcon size={14} />}
        </button>

        <input
          className="browser__address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => { setEditing(true); e.target.select() }}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { navigate(address); e.currentTarget.blur() }
            if (e.key === 'Escape') { setAddress(url); e.currentTarget.blur() }
          }}
          spellCheck={false}
          placeholder="Search or enter address"
        />

        <button className="icon-button" title="DevTools" onClick={() => act('browser:openDevTools')}>
          <DevToolsIcon size={14} />
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* The native view is composited over exactly this rectangle. Keep it empty. */}
      <div ref={host} style={{ flex: 1, minHeight: 0, background: '#ffffff' }} />
    </div>
  )
}

/** Where a fresh browser tab lands, and the fallback for a persisted state with no usable url. */
export const HOME_URL = 'https://www.google.com'

interface NavigationState {
  url: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

/**
 * The tab's persisted state, read defensively.
 *
 * The shell hands back whatever was on disk and does not validate it — and for a tab persisted
 * before the plugin system, `state` is the old tab object's fields spread wholesale by
 * `migrateLegacyTab`, `viewId` included. That id named a view in a process that no longer exists,
 * so it is ignored here and views.ts mints a fresh one on first activation.
 */
function readState(state: Record<string, unknown>): NavigationState {
  return {
    url: typeof state.url === 'string' ? state.url : HOME_URL,
    canGoBack: state.canGoBack === true,
    canGoForward: state.canGoForward === true,
    loading: state.loading === true
  }
}

/** Treat input with no scheme and no dot as a search, matching what every browser does. */
function normalizeUrl(raw: string): string {
  const s = raw.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('about:')) return s
  if (/^localhost(:\d+)?(\/|$)/.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) {
    return `http://${s}`
  }
  if (/\s/.test(s) || !s.includes('.')) {
    return `https://www.google.com/search?q=${encodeURIComponent(s)}`
  }
  return `https://${s}`
}
