/**
 * The `Range` header of a request for a media file, read the way a video element writes it.
 *
 * Pure, and apart from the protocol handler, so `pnpm panes:selftest` can hold it to the RFC
 * without Electron. It is the part with edges: a video element asks for `bytes=0-` to start, for
 * an open-ended range from wherever the user dragged the playhead to, and on some containers for
 * the last few KB (`bytes=-N`) to find the index that sits at the end of the file.
 */

/**
 * The single range asked for, clamped to the file; `null` to send the whole file, which is the
 * answer to no header, a header that is not about bytes, and several ranges at once (multipart
 * bodies are a lot of machinery for something no media element asks for); `'unsatisfiable'` for a
 * range that starts past the end, which must be a 416 rather than a silently different body.
 */
export function parseByteRange(
  header: string | null,
  size: number
): { start: number; end: number } | null | 'unsatisfiable' {
  const m = header ? /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header) : null
  if (!m) return null
  const [, from, to] = m
  if (from === '' && to === '') return null
  if (from === '') {
    // The last N bytes. Asking for more than there are is asking for all of it.
    const suffix = Number(to)
    if (suffix === 0) return 'unsatisfiable'
    return size === 0 ? 'unsatisfiable' : { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(from)
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1)
  if (start >= size || end < start) return 'unsatisfiable'
  return { start, end }
}
