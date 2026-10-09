import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { Context, Plugin } from 'cordis'
import { registerImageCommands } from '../protocol'

/**
 * The image viewer, main half: one bounded file read, and nothing else.
 *
 * `inject` is not optional: reading `ctx.commands` without declaring it throws, and a half whose
 * injection cannot be satisfied does not fail loudly — it sits in PENDING and `apply` never runs.
 */

/**
 * Above this we refuse rather than try. The bytes are read, cloned across to the renderer and
 * decoded there, all at once — and a decoded image is width × height × 4 bytes on top. 100 MB is
 * past any photograph or screenshot; what is bigger than that is a dataset, not something to look at.
 */
const MAX_IMAGE_BYTES = 100 * 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.apng': 'image/apng',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.pjpeg': 'image/jpeg',
  '.pjp': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.cur': 'image/x-icon'
}

const plugin: Plugin = {
  name: 'image',
  inject: ['commands'],
  apply(ctx: Context) {
    // Captured once and BOUND, as in the PDF viewer: cordis substitutes the plugin's own context
    // only when the method is called on the service, and a bare reference loses it.
    const commands = ctx.commands
    const register = commands.register.bind(commands)

    registerImageCommands(register, {
      'image:read': async ({ path }) => {
        // Never readFileSync: main is shared, and a synchronous read of a large file stalls every
        // terminal's output and every git call for as long as it takes.
        const { size } = await stat(path)
        if (size > MAX_IMAGE_BYTES) {
          throw new Error(`${basename(path)} is ${mib(size)} MiB, past the ${mib(MAX_IMAGE_BYTES)} MiB limit for images`)
        }
        const buffer = await readFile(path)
        // An explicit copy, as in the PDF viewer: a small Buffer can be a view of node's shared
        // 64 KiB pool, and the clone that carries it to the renderer would carry the whole pool.
        return {
          bytes: new Uint8Array(buffer),
          size,
          mime: MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
        }
      }
    })
  }
}

export default plugin

function mib(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}
