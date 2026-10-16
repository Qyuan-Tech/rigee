/**
 * Unpacking a plugin's tarball — the file `npm pack` writes — with nothing in it trusted.
 *
 * Written here rather than taken from a tar library, and the reason is what a library is for. A
 * general tar implementation exists to reproduce everything a tar can hold: links, devices,
 * permissions, owners, sparse files. Every one of those is a way for an archive to write outside
 * the directory it is unpacked into, or to make the directory change after it was checked. A
 * plugin needs none of them. So this reads the one subset `npm pack` produces — regular files and
 * directories, under `package/` — and refuses everything else outright, which is both shorter
 * than a library and a smaller thing to get wrong.
 *
 * WHAT IS REFUSED, AND WHY EACH ONE:
 *
 *   symbolic and hard links   the classic escape: `package/x -> /etc`, then `package/x/passwd`.
 *                             Rigee's discovery refuses a plugin containing a symlink anyway; this
 *                             is the same rule applied before anything reaches the disk.
 *   devices, FIFOs, the rest  nothing a plugin ships, and a FIFO blocks whoever opens it.
 *   `..`, `.`, empty segments the other classic escape, and paths that mean the same file twice.
 *   absolute paths, drives    `/etc/x`, `C:\x`, and `\` — a separator on Windows, a file name
 *                             character everywhere else, so a name that is harmless on macOS walks
 *                             out of the directory on Windows.
 *   anything outside package/ npm puts everything there; something else is not an npm tarball.
 *   duplicates                a second entry for a path would silently replace the first.
 *
 * And it is bounded, because the archive is attacker-controlled: decompressed size, file count and
 * total bytes all have ceilings, checked before anything is written. A 40 kB gzip of zeros
 * decompresses to gigabytes; `maxOutputLength` is what stops that at the inflate rather than at
 * the disk.
 *
 * No Electron here: the self-test unpacks crafted archives under plain Node.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gunzipSync } from 'node:zlib'

const gunzipAsync = promisify(gunzip)

export interface UnpackLimits {
  /** Regular files, counted as they are read. */
  maxFiles: number
  /** Sum of the files' sizes. */
  maxBytes: number
}

const BLOCK = 512
/** Every path in an npm tarball starts here. Stripped on the way out. */
const PREFIX = 'package/'

/**
 * Unpack `package/…` from a gzipped tarball into `dest`, which must exist and should be empty.
 *
 * Throws, with the entry and the reason, at the first thing that is not allowed. Whatever was
 * written before that stays written — the caller unpacks into a staging directory it deletes on
 * any failure, which is simpler than unwinding here and leaves nothing behind either way.
 */
export async function unpackTarball(
  gz: Buffer,
  dest: string,
  limits: UnpackLimits
): Promise<{ files: number; bytes: number }> {
  let tar: Buffer
  try {
    tar = await gunzipAsync(gz, { maxOutputLength: inflateCeiling(limits) })
  } catch (err) {
    throw inflateError(err, limits)
  }
  return writeEntries(tar, resolve(dest), limits)
}

/**
 * The same, blocking. Only for the smoke modes, which plant plugins before the app is ready and
 * have nothing to keep responsive; an install from the plugins view uses the asynchronous one, so
 * inflating a large plugin never stalls the main process.
 */
export function unpackTarballSync(gz: Buffer, dest: string, limits: UnpackLimits): { files: number; bytes: number } {
  let tar: Buffer
  try {
    tar = gunzipSync(gz, { maxOutputLength: inflateCeiling(limits) })
  } catch (err) {
    throw inflateError(err, limits)
  }
  return writeEntries(tar, resolve(dest), limits)
}

/**
 * The most a plugin's tarball may inflate to. Headers and padding are on top of the files
 * themselves: a header block per entry, a partial block per file, a pax header for each long path,
 * and up to 20 blocks of trailer.
 */
const inflateCeiling = (limits: UnpackLimits): number => limits.maxBytes + limits.maxFiles * 3 * BLOCK + 64 * BLOCK

function inflateError(err: unknown, limits: UnpackLimits): Error {
  if (err instanceof RangeError || (err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
    return new Error(`the archive unpacks to more than ${limits.maxBytes} bytes`)
  }
  return new Error(`the archive is not valid gzip (${message(err)})`)
}

function writeEntries(
  tar: Buffer,
  root: string,
  limits: UnpackLimits
): { files: number; bytes: number } {
  const seen = new Set<string>()
  let files = 0
  let bytes = 0
  /** A name carried over from a pax or GNU long-name header to the entry that follows it. */
  let nextPath: string | null = null
  let entries = 0

  for (let at = 0; at + BLOCK <= tar.length; ) {
    const header = tar.subarray(at, at + BLOCK)
    // Two zero blocks end the archive; one is enough to know there is nothing after it worth
    // reading, and whatever padding follows is the trailer.
    if (header.every((b) => b === 0)) break
    if (++entries > limits.maxFiles * 3 + 16) throw new Error('the archive has too many entries')

    if (!checksumOk(header)) throw new Error(`corrupt header at byte ${at}`)
    const size = octal(header, 124, 12)
    if (size === null) throw new Error(`unreadable size at byte ${at}`)
    const type = String.fromCharCode(header[156]!)
    const dataStart = at + BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new Error('the archive is truncated')
    const data = tar.subarray(dataStart, dataEnd)
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK

    // Metadata entries describe the NEXT entry and are not themselves files.
    if (type === 'x') {
      nextPath = paxPath(data) ?? nextPath
      continue
    }
    if (type === 'g') continue
    if (type === 'L') {
      nextPath = cString(data, 0, data.length)
      continue
    }

    const name = nextPath ?? ustarName(header)
    nextPath = null

    if (type === '5') {
      const rel = relativePath(name, true)
      if (rel !== '') mkdirSync(inside(root, rel), { recursive: true })
      continue
    }
    if (type !== '0' && type !== '\0') {
      throw new Error(`${name}: ${describeType(type)} entries are not allowed in a plugin`)
    }

    const rel = relativePath(name, false)
    const key = rel.toLowerCase()
    // Case-folded, because two names that differ only in case are one file on macOS and Windows:
    // the second would overwrite the first there and not here.
    if (seen.has(key)) throw new Error(`${name}: appears twice in the archive`)
    seen.add(key)

    if (++files > limits.maxFiles) throw new Error(`more than ${limits.maxFiles} files`)
    bytes += size
    if (bytes > limits.maxBytes) throw new Error(`more than ${limits.maxBytes} bytes`)

    const file = inside(root, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    // `wx`: never through something already there. The staging directory is fresh, so nothing
    // should be — and if something is, that is not a file this archive gets to replace.
    writeFileSync(file, data, { flag: 'wx', mode: 0o644 })
  }
  return { files, bytes }
}

/**
 * An entry's name to a path inside the plugin, or a throw.
 *
 * The checks are on the string, before any path API sees it, because the path APIs are the ones
 * that would happily resolve `a/../../b` for us.
 */
function relativePath(name: string, isDir: boolean): string {
  // Some writers add `./` in front; node-tar does not, but it means the same thing.
  const raw = name.startsWith('./') ? name.slice(2) : name
  const trimmed = isDir ? raw.replace(/\/+$/, '') + '/' : raw
  if (!trimmed.startsWith(PREFIX)) throw new Error(`${name}: outside package/`)
  const rel = trimmed.slice(PREFIX.length).replace(/\/$/, '')
  if (rel === '') {
    if (isDir) return ''
    throw new Error(`${name}: not a file name`)
  }
  // Control characters, and everything Windows refuses in a file name: `\` and `:` above all,
  // because those two turn a harmless POSIX name into a path that leaves the directory.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(rel)) throw new Error(`${name}: unsafe characters in the path`)
  for (const segment of rel.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw new Error(`${name}: unsafe path`)
  }
  return rel
}

/** Join, then prove the result is still under `root` — the check that cannot be argued with. */
function inside(root: string, rel: string): string {
  const full = resolve(root, rel)
  if (!full.startsWith(root + sep)) throw new Error(`${rel}: resolves outside the plugin`)
  return full
}

/** ustar keeps long names in two fields: a 155-byte prefix and a 100-byte name. */
function ustarName(header: Buffer): string {
  const name = cString(header, 0, 100)
  const magic = header.subarray(257, 262).toString('latin1')
  const prefix = magic === 'ustar' ? cString(header, 345, 155) : ''
  return prefix ? `${prefix}/${name}` : name
}

/** The `path` record of a pax extended header — `<length> path=<value>\n`, repeated — if any. */
function paxPath(data: Buffer): string | null {
  let path: string | null = null
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(0x20, at)
    if (space < 0) break
    const length = Number(data.subarray(at, space).toString('latin1'))
    if (!Number.isInteger(length) || length <= 0 || at + length > data.length) {
      throw new Error('malformed pax header')
    }
    const record = data.subarray(space + 1, at + length - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0 && record.slice(0, eq) === 'path') path = record.slice(eq + 1)
    at += length
  }
  return path
}

function cString(buf: Buffer, start: number, length: number): string {
  const field = buf.subarray(start, start + length)
  const nul = field.indexOf(0)
  return field.subarray(0, nul < 0 ? field.length : nul).toString('utf8')
}

/** An octal field, NUL- or space-terminated. Null for the base-256 form, which no plugin needs. */
function octal(buf: Buffer, start: number, length: number): number | null {
  if ((buf[start]! & 0x80) !== 0) return null
  const text = buf.subarray(start, start + length).toString('latin1').replace(/[\0 ]+$/, '').trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) return null
  return parseInt(text, 8)
}

/** The header's own checksum: every byte summed, with the checksum field counted as spaces. */
function checksumOk(header: Buffer): boolean {
  const stored = octal(header, 148, 8)
  if (stored === null) return false
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!
  return sum === stored
}

function describeType(type: string): string {
  switch (type) {
    case '1':
      return 'hard link'
    case '2':
      return 'symbolic link'
    case '3':
    case '4':
      return 'device'
    case '6':
      return 'FIFO'
    default:
      return `type "${type}"`
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
