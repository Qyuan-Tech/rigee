import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { Context, Plugin } from 'cordis'
import { registerVideoCommands } from '../protocol'

/**
 * The video player, main half: decides that a file may be played, and asks the shell for a URL to
 * stream it from. Nothing is read here — the <video> element reads what it needs through that URL.
 *
 * `inject` is not optional: reading `ctx.commands` or `ctx.shell` without declaring it throws, and
 * a half whose injection cannot be satisfied sits in PENDING with `apply` never running.
 */

/**
 * Named from the extension, so the response says what it holds. Chromium sniffs the container
 * whatever this says — checked: a `.mov` served as `video/quicktime` and a `.mkv` as
 * `video/x-matroska` play exactly as they do served as `video/mp4` and `video/webm` — so these are
 * the honest names rather than the ones a browser's canPlayType happens to like.
 */
const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg'
}

const plugin: Plugin = {
  name: 'video',
  inject: ['commands', 'shell'],
  apply(ctx: Context) {
    // Captured once and BOUND: cordis gives a service method the calling plugin's context only
    // when it is called on the service proxy, and that context is what ties every URL served here
    // to this plugin — disposing it stops them all, released or not.
    const commands = ctx.commands
    const register = commands.register.bind(commands)
    const shell = ctx.shell
    const serveFile = shell.serveFile.bind(shell)
    const releaseFile = shell.releaseFile.bind(shell)

    registerVideoCommands(register, {
      'video:open': async ({ path }) => {
        const info = await stat(path).catch((err: NodeJS.ErrnoException) => {
          throw err.code === 'ENOENT' ? new Error(`${basename(path)} does not exist`) : err
        })
        if (!info.isFile()) throw new Error(`${basename(path)} is not a file`)
        const mime = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
        return { url: serveFile(path, mime), size: info.size, mime }
      },
      'video:release': ({ url }) => { releaseFile(url) }
    })
  }
}

export default plugin
