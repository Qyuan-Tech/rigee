import { icons, Notice } from '@rigee/plugin-api'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { image } from './rpc'
import type { PluginEditorProps } from '@rigee/plugin-api'
import './image.css'

/**
 * The image pane: a toolbar, and the picture in a scrollable stage.
 *
 * It opens FITTED — shrunk to the pane, never enlarged past its own size, because a 16px icon blown
 * up to fill the screen is not what it looks like — and stays fitted as the pane changes, so
 * splitting the editor beside it refits it rather than leaving it clipped. Any zoom the user makes
 * leaves fitted mode, and keeps the pixel under the pointer where it was.
 */

/** The zoom ladder that + and − step along. */
const ZOOMS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32]
const MIN_ZOOM = 0.02
const MAX_ZOOM = 32
/** Room left round a fitted picture, so its edges do not run into the pane's. Matches the CSS. */
const MARGIN = 24
/** From here up pixels are drawn as squares: zooming that far into an icon is to see its pixels. */
const PIXELATED_FROM = 3

interface Loaded {
  url: string
  size: number
  mime: string
}

export function ImageView({ filePath }: PluginEditorProps): React.ReactElement {
  const viewport = useRef<HTMLDivElement>(null)
  const picture = useRef<HTMLImageElement>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The pane's inner size, which is all fitting needs. */
  const [box, setBox] = useState({ w: 0, h: 0 })
  /** A zoom the user chose; null while fitted to the pane. */
  const [zoom, setZoom] = useState<number | null>(null)
  /** Bumped by Reload, which reads the file again — the other way to see it after it changed. */
  const [version, setVersion] = useState(0)
  const [panning, setPanning] = useState(false)
  /**
   * Every blob: URL made for this pane. One the picture has moved past is let go once its
   * successor has LOADED, not when it is made: revoked while the <img> is still fetching it, it
   * would fail, and that failure reads as a file that is not an image.
   */
  const urls = useRef(new Set<string>())
  /**
   * The point a zoom is anchored on: where it is in the pane, and which pixel of the picture is
   * under it. Applied once the new size has been laid out, which is the first moment the scroll
   * position that keeps that pixel there can be known.
   */
  const anchor = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)

  const fit = natural ? clamp(Math.min(1, (box.w - 2 * MARGIN) / natural.w, (box.h - 2 * MARGIN) / natural.h)) : 1
  const scale = zoom ?? fit

  useEffect(() => {
    const made = urls.current
    return () => {
      for (const u of made) URL.revokeObjectURL(u)
      made.clear()
    }
  }, [])

  // Read the file and hand it to the <img> as a blob: URL. On a reload the old picture stays up
  // until the new one is here, rather than blinking out while the file is read.
  useEffect(() => {
    let cancelled = false
    image('image:read', { path: filePath }).then(
      (file) => {
        if (cancelled) return
        const next = URL.createObjectURL(new Blob([file.bytes], { type: file.mime }))
        urls.current.add(next)
        setError(null)
        setLoaded({ url: next, size: file.size, mime: file.mime })
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    )
    return () => { cancelled = true }
  }, [filePath, version])

  useLayoutEffect(() => {
    const el = viewport.current
    if (!el) return
    const measure = (): void => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * Zoom to `next`, keeping the picture's pixel under (x, y) — pane coordinates — exactly where it
   * is. With no point, the middle of the pane holds still, which is what the buttons want.
   */
  const zoomTo = useCallback(
    (next: number, at?: { x: number; y: number }) => {
      const el = viewport.current
      const pic = picture.current
      const target = clamp(next)
      if (el && pic && target !== scale) {
        const x = at?.x ?? el.clientWidth / 2
        const y = at?.y ?? el.clientHeight / 2
        anchor.current = {
          x,
          y,
          px: (el.scrollLeft + x - pic.offsetLeft) / scale,
          py: (el.scrollTop + y - pic.offsetTop) / scale
        }
      }
      setZoom(target)
    },
    [scale]
  )

  const zoomBy = useCallback((direction: 1 | -1) => zoomTo(step(scale, direction)), [scale, zoomTo])

  useLayoutEffect(() => {
    const a = anchor.current
    const el = viewport.current
    const pic = picture.current
    anchor.current = null
    if (!a || !el || !pic) return
    el.scrollLeft = a.px * scale + pic.offsetLeft - a.x
    el.scrollTop = a.py * scale + pic.offsetTop - a.y
  }, [scale])

  // Pinch, or Ctrl/Cmd and the wheel. Not React's onWheel, which is passive, and a passive listener
  // cannot stop the page itself from zooming instead.
  const latest = useRef({ zoomTo, scale })
  latest.current = { zoomTo, scale }
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      // Proportional to the delta: a pinch sends many small ones, a mouse wheel a few large ones,
      // and both come out smooth.
      const { zoomTo: zoom, scale: now } = latest.current
      zoom(now * Math.exp(-e.deltaY * 0.0025), { x: e.clientX - r.left, y: e.clientY - r.top })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const width = natural ? natural.w * scale : 0
  const height = natural ? natural.h * scale : 0
  const pannable = !!natural && (width + 2 * MARGIN > box.w || height + 2 * MARGIN > box.h)

  if (error) return <Notice tone="error">{error}</Notice>

  return (
    <div className="image">
      <div className="image__bar">
        <button className="btn" disabled={!natural} title="Zoom out (−)" onClick={() => zoomBy(-1)}>
          −
        </button>
        <span className="image__zoom">{natural ? `${Math.round(scale * 100)}%` : '—'}</span>
        <button className="btn" disabled={!natural} title="Zoom in (+)" onClick={() => zoomBy(1)}>
          +
        </button>
        <button
          className={natural && zoom === null ? 'btn btn--primary' : 'btn'}
          disabled={!natural}
          title="Fit to the pane (0)"
          onClick={() => setZoom(null)}
        >
          Fit
        </button>
        <button className="btn" disabled={!natural} title="Actual size (1)" onClick={() => zoomTo(1)}>
          1:1
        </button>

        <span className="image__sep" />

        <span className="image__info">
          {natural && loaded
            ? `${natural.w} × ${natural.h} · ${formatName(loaded.mime, filePath)} · ${formatSize(loaded.size)}`
            : ''}
        </span>

        <span className="image__spacer" />

        <button className="btn" disabled={!loaded} title="Read the file again" onClick={() => setVersion((v) => v + 1)}>
          Reload
        </button>
      </div>

      <div className="image__body">
        <div
          ref={viewport}
          className={`image__viewport${pannable ? ' image__viewport--pannable' : ''}${panning ? ' image__viewport--panning' : ''}`}
          // Focusable, so the keys below work once the picture has been clicked.
          tabIndex={0}
          onKeyDown={(e) => {
            const mod = e.metaKey || e.ctrlKey
            if (e.key === '+' || e.key === '=') zoomBy(1)
            else if (e.key === '-' || e.key === '_') zoomBy(-1)
            else if (e.key === '0') setZoom(null)
            // Plain 1 only: Cmd+1 is "go to the first tab", and must still get there.
            else if (e.key === '1' && !mod) zoomTo(1)
            else return
            // Cancelled, so Cmd+= zooms the picture and not the whole window through the View menu.
            e.preventDefault()
          }}
          onDoubleClick={(e) => {
            if (!natural) return
            const r = e.currentTarget.getBoundingClientRect()
            const at = { x: e.clientX - r.left, y: e.clientY - r.top }
            // Fitted, to actual size — or twice it, for a picture already smaller than the pane.
            if (zoom === null) zoomTo(fit < 1 ? 1 : 2, at)
            else setZoom(null)
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || !pannable) return
            drag.current = { x: e.clientX, y: e.clientY }
            e.currentTarget.setPointerCapture(e.pointerId)
            setPanning(true)
          }}
          onPointerMove={(e) => {
            const from = drag.current
            if (!from) return
            e.currentTarget.scrollLeft -= e.clientX - from.x
            e.currentTarget.scrollTop -= e.clientY - from.y
            drag.current = { x: e.clientX, y: e.clientY }
          }}
          onPointerUp={(e) => {
            if (!drag.current) return
            drag.current = null
            setPanning(false)
            e.currentTarget.releasePointerCapture(e.pointerId)
          }}
        >
          <div className="image__stage">
            {loaded && (
              <img
                ref={picture}
                className="image__picture"
                src={loaded.url}
                alt={basename(filePath)}
                draggable={false}
                // Unsized until it has said how big it is; hidden meanwhile, so it never flashes up
                // at full size before being fitted.
                style={
                  natural
                    ? { width, height, imageRendering: scale >= PIXELATED_FROM ? 'pixelated' : 'auto' }
                    : { visibility: 'hidden', position: 'absolute' }
                }
                onLoad={(e) => {
                  setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
                  for (const u of urls.current) {
                    if (u === loaded.url) continue
                    URL.revokeObjectURL(u)
                    urls.current.delete(u)
                  }
                }}
                onError={() => setError(`${basename(filePath)} could not be read as an image.`)}
              />
            )}
          </div>
        </div>

        {!natural && (
          <div className="image__opening">
            <icons.Image />
            <span className="muted">Opening {basename(filePath)}…</span>
          </div>
        )}
      </div>
    </div>
  )
}

const clamp = (scale: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale))

/** Both separators, because a workspace opened on Windows carries backslashes through. */
const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** The next rung of the zoom ladder in `direction`, or a proportional step past either end. */
function step(scale: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOMS.find((z) => z > scale + 1e-6) ?? scale * 1.25
  return [...ZOOMS].reverse().find((z) => z < scale - 1e-6) ?? scale / 1.25
}

/** `PNG`, `JPEG`, `ICO` — the name people know the format by. */
function formatName(mime: string, path: string): string {
  const sub = mime.startsWith('image/') ? mime.slice(6) : (path.split('.').pop() ?? '')
  return (sub === 'x-icon' ? 'ico' : sub).toUpperCase()
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
