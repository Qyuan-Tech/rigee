import { protocol, type CustomScheme } from 'electron'
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import { parseByteRange } from './byteRange'

/**
 * Files streamed to the renderer by URL, for the elements that can only take a URL — a <video>.
 *
 * The image viewer reads a whole file and hands the bytes over, which is right for a picture and
 * hopeless for a film: four gigabytes in memory before the first frame, and nothing to seek with.
 * A media element wants a URL it can make Range requests to — the first bytes to start, then
 * whatever stretch the playhead is dragged to — and Chromium will only stream from a scheme that
 * was declared privileged before the app was ready. Plugins load long after that, so the scheme is
 * the shell's, and a plugin's main half asks for a URL through `ctx.shell.serveFile`.
 *
 * NOTHING IS SERVED UNLESS ASKED FOR. A URL names a random token, not a path, and a token exists
 * only for a file a plugin chose to serve, until it is released — so even something that could
 * reach the scheme could not walk the disk with it. And little can reach it: the handler belongs to
 * the default session, the shell's own, and a page in a browser tab lives in another.
 */

export const MEDIA_SCHEME = 'rigee-media'

/**
 * The scheme's declaration, for the one `registerSchemesAsPrivileged` call Electron allows.
 *
 *   stream            the one this exists for: without it a media element cannot stream from the
 *                     scheme, so playback waits for a whole file and seeking does not work.
 *   standard, secure  a URL with an authority, in a secure context — as the plugin scheme needs.
 *   supportFetchAPI   so the response is a real fetch body, Range requests included.
 *   corsEnabled       the packaged renderer is a `file://` document, so this scheme is cross-origin
 *                     to it; with this, the handler's Access-Control-Allow-Origin is honoured.
 */
export const mediaScheme: CustomScheme = {
  scheme: MEDIA_SCHEME,
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true }
}

interface Served {
  path: string
  mime: string
}

const served = new Map<string, Served>()

/**
 * A URL that streams this file until `revoke` is called.
 *
 * The token is the URL's host: lower-case hex, since a standard scheme lower-cases its hosts. The
 * file's name follows it only so that anything showing the URL shows something recognisable.
 */
export function serveMedia(path: string, mime: string): { url: string; revoke: () => void } {
  const token = randomBytes(16).toString('hex')
  served.set(token, { path, mime })
  return {
    url: `${MEDIA_SCHEME}://${token}/${encodeURIComponent(basename(path))}`,
    revoke: () => { served.delete(token) }
  }
}

/** How many files are being served. For the smoke check that closing a player lets its file go. */
export const servedCount = (): number => served.size

/** At app ready: answering is cheap, and costs nothing until something is served. */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const file = served.get(new URL(request.url).hostname)
    if (!file) return new Response('not found', { status: 404 })

    let size: number
    try {
      size = (await stat(file.path)).size
    } catch {
      return new Response('not found', { status: 404 })
    }

    const headers: Record<string, string> = {
      'Content-Type': file.mime,
      'Accept-Ranges': 'bytes',
      // The renderer's origin serialises to "null" under file://, so `*` is the only value that
      // works; it loosens nothing, since getting here takes a token only this app hands out.
      'Access-Control-Allow-Origin': '*',
      // The file can change under the URL — a recording still being written — and a cached range
      // from before would splice two versions together.
      'Cache-Control': 'no-store'
    }
    const range = parseByteRange(request.headers.get('range'), size)
    if (range === 'unsatisfiable') {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
    }
    const { start, end } = range ?? { start: 0, end: size - 1 }
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    headers['Content-Length'] = String(Math.max(0, end - start + 1))
    // Streamed, never read whole: the element asks for what it is about to play, and drops the
    // request when the user seeks elsewhere — cancelling the web stream destroys the file stream.
    const body = size === 0 ? null : (Readable.toWeb(createReadStream(file.path, { start, end })) as ReadableStream)
    return new Response(body, { status: range ? 206 : 200, headers })
  })
}
