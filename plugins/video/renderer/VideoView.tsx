import { duplicatedFrom, icons, Notice } from '@rigee/plugin-api'
import { useEffect, useRef, useState } from 'react'
import { video } from './rpc'
import type { PluginEditorProps } from '@rigee/plugin-api'
import type { VideoSource } from '../protocol'
import './video.css'

/**
 * The video pane: a toolbar, and Chromium's own player.
 *
 * The native controls rather than drawn ones, because they are already everything a player needs —
 * play, the timeline, volume, full screen, picture in picture and playback speed in the overflow
 * menu — and they are what the user's fingers know from every other Chromium window. What this adds
 * is around them: where the file streams from, what it is, picking up where the tab left off, and
 * the YouTube keys once the picture has been clicked.
 */

/**
 * Where each tab's player had got to, by tab id. Switching to another tab unmounts the player, and
 * coming back to the start of a film is the wrong answer; a module map rather than the tab's state
 * because a playhead is not worth a write to workspaces.json four times a second.
 */
const positions = new Map<string, number>()

/** How far the arrow keys and J / L move the playhead, in seconds. */
const STEP = 5
const BIG_STEP = 10

interface Meta {
  width: number
  height: number
  duration: number
}

export function VideoView({ filePath, tabId }: PluginEditorProps): React.ReactElement {
  const [source, setSource] = useState<VideoSource | null>(null)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loop, setLoop] = useState(false)
  /** Bumped by Reload: a new URL, so a file that was still being written plays to its new end. */
  const [version, setVersion] = useState(0)
  /**
   * URLs this pane has let go of. The element can still be pointing at one for a moment after it is
   * released, and the request it then makes fails — which is not the file's fault and must not be
   * reported as if it were.
   */
  const released = useRef(new Set<string>())
  /** A split copy starts where the tab it was split from had got to. Asked once, on first mount. */
  const [inherited] = useState(() => positions.get(duplicatedFrom(tabId) ?? '') ?? 0)

  useEffect(() => {
    let cancelled = false
    let url: string | null = null
    video('video:open', { path: filePath }).then(
      (opened) => {
        if (cancelled) {
          void video('video:release', { url: opened.url }).catch(() => {})
          return
        }
        url = opened.url
        setError(null)
        setMeta(null)
        setSource(opened)
      },
      (e: unknown) => {
        if (!cancelled) setError(reason(e))
      }
    )
    return () => {
      cancelled = true
      if (!url) return
      released.current.add(url)
      void video('video:release', { url }).catch(() => {})
    }
  }, [filePath, version])

  const remember = (v: HTMLVideoElement): void => {
    if (Number.isFinite(v.currentTime)) positions.set(tabId, v.currentTime)
  }

  if (error) return <Notice tone="error">{error}</Notice>

  const name = basename(filePath)
  return (
    <div className="video">
      <div className="video__bar">
        <span className="video__info">{source && meta ? describe(meta, filePath, source.size) : ''}</span>
        <span className="video__spacer" />
        <button
          className={loop ? 'btn btn--primary' : 'btn'}
          title="Start again from the beginning when it ends"
          onClick={() => setLoop((l) => !l)}
        >
          Loop
        </button>
        <button className="btn" disabled={!source} title="Read the file again" onClick={() => setVersion((n) => n + 1)}>
          Reload
        </button>
      </div>

      <div className="video__stage">
        {source && (
          <video
            key={source.url}
            className="video__element"
            src={source.url}
            controls
            loop={loop}
            // Only what it takes to show the first frame and the length, until play is pressed.
            preload="metadata"
            // Focusable, so the keys below work once the picture has been clicked.
            tabIndex={0}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget
              setMeta({ width: v.videoWidth, height: v.videoHeight, duration: v.duration })
              const at = positions.get(tabId) ?? inherited
              if (at > 0 && (!Number.isFinite(v.duration) || at < v.duration - 0.5)) v.currentTime = at
            }}
            onTimeUpdate={(e) => remember(e.currentTarget)}
            onSeeked={(e) => remember(e.currentTarget)}
            onError={(e) => {
              const v = e.currentTarget
              if (released.current.has(v.currentSrc || v.src)) return
              setError(failure(v.error, name))
            }}
            onKeyDown={(e) => {
              if (e.metaKey || e.ctrlKey || e.altKey) return
              const v = e.currentTarget
              const seek = (by: number): void => {
                v.currentTime = Math.max(0, Math.min(Number.isFinite(v.duration) ? v.duration : Infinity, v.currentTime + by))
              }
              if (e.key === ' ' || e.key === 'k') {
                if (v.paused) void v.play()
                else v.pause()
              } else if (e.key === 'ArrowLeft') seek(-STEP)
              else if (e.key === 'ArrowRight') seek(STEP)
              else if (e.key === 'j') seek(-BIG_STEP)
              else if (e.key === 'l') seek(BIG_STEP)
              else if (e.key === 'm') v.muted = !v.muted
              else if (e.key === 'f') {
                if (document.fullscreenElement) void document.exitFullscreen()
                else void v.requestFullscreen()
              } else return
              // Cancelled, so the native controls do not act on the same key a second time.
              e.preventDefault()
            }}
          />
        )}
        {!meta && (
          <div className="video__opening">
            <icons.Video />
            <span className="muted">Opening {name}…</span>
          </div>
        )}
      </div>
    </div>
  )
}

/** Both separators, because a workspace opened on Windows carries backslashes through. */
const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** `1920 × 1080 · 3:24 · MP4 · 45.2 MB` — or `audio only` where a picture would be. */
function describe(meta: Meta, path: string, size: number): string {
  const picture = meta.width > 0 ? `${meta.width} × ${meta.height}` : 'audio only'
  // A file still being recorded, or one written without an index, does not know its length.
  const length = Number.isFinite(meta.duration) ? formatTime(meta.duration) : 'length unknown'
  const format = (path.split('.').pop() ?? '').toUpperCase()
  return `${picture} · ${length} · ${format} · ${formatSize(size)}`
}

function formatTime(seconds: number): string {
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** What went wrong, said about the file rather than in MediaError's codes. */
function failure(error: MediaError | null, name: string): string {
  switch (error?.code) {
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return (
        `${name} is in a format Chromium cannot play. MP4 and MOV (H.264, HEVC, AV1), WebM (VP8, VP9, AV1) ` +
        'and Ogg play here; AVI, WMV, FLV and MPEG-2 do not.'
      )
    case MediaError.MEDIA_ERR_DECODE:
      return `${name} could not be decoded — it may be damaged, or still being written.`
    case MediaError.MEDIA_ERR_NETWORK:
      return `${name} could not be read any more — was it moved or deleted?`
    default:
      return `${name} could not be played${error?.message ? `: ${error.message}` : '.'}`
  }
}

/**
 * The end of a failed request worth reading. Electron wraps what main threw as "Error invoking
 * remote method 'plugin:invoke': Error: …", and the channel and the command each add their name.
 */
function reason(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message
    .replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
    .replace(/^(?:[\w-]+:[\w-]+: )+/, '')
}
