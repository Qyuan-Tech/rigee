import type { Context, Plugin } from 'cordis'
import type { AsyncSubscription, Event } from '@parcel/watcher'
import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { explorerEmitter, registerExplorerCommands } from '../protocol'

/**
 * The explorer's main half: one filesystem watcher per folder of the active workspace, so the tree
 * shows a file the moment an agent writes it, and drops one the moment it is deleted.
 *
 * @parcel/watcher for the reason source control uses it: one FSEvents stream per folder on macOS
 * rather than a descriptor per directory, which a GUI-launched app — soft limit 256 — would run out
 * of on any real repository. Imported when the first folder is watched, not when this module
 * loads, so nothing of it is on the boot path.
 *
 * Only creations and deletions are passed on (a rename arrives as one of each). A save changes a
 * file's contents, not the listing it sits in, and an editor saving every second must not have the
 * tree re-read its folder every second.
 */

/** Not shown usefully in a tree, and a single install or fetch writes thousands of entries there. */
const IGNORE = ['**/.git/**', '**/node_modules/**']

/** A burst — a checkout, a build — settles into one message: trailing, with a ceiling. */
const DEBOUNCE_MS = 150
const MAX_WAIT_MS = 600

interface Watched {
  /** The folder as the workspace spells it, and as the disk resolves it — events use the latter. */
  root: string
  real: string
  sub: AsyncSubscription | null
}

const plugin: Plugin = {
  name: 'explorer',
  inject: ['commands', 'shell'],
  apply(ctx: Context) {
    // Bound at activation: a detached cordis service method has no `this` (see DEVELOPMENT.md).
    const commands = ctx.commands
    const register = commands.register.bind(commands)
    const shell = ctx.shell
    const emit = explorerEmitter(shell.emit.bind(shell))

    const watched = new Map<string, Watched>()
    /** Unsubscribes still finishing. Quitting waits for these too: see `dispose`. */
    const leaving = new Set<Promise<void>>()
    const pending = new Set<string>()
    let timer: NodeJS.Timeout | null = null
    let ceiling: NodeJS.Timeout | null = null
    let disposed = false

    const flush = (): void => {
      if (timer) { clearTimeout(timer); timer = null }
      if (ceiling) { clearTimeout(ceiling); ceiling = null }
      if (pending.size === 0 || disposed) return
      const dirs = [...pending]
      pending.clear()
      emit('changed', { dirs })
    }

    const onEvents = (w: Watched, events: Event[]): void => {
      for (const e of events) {
        if (e.type === 'update') continue
        // Back from the disk's spelling to the workspace's: /private/tmp/x is /tmp/x to the tree.
        const path = w.real === w.root ? e.path : w.root + e.path.slice(w.real.length)
        pending.add(path)
        pending.add(dirname(path))
      }
      if (pending.size === 0) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, DEBOUNCE_MS)
      ceiling ??= setTimeout(flush, MAX_WAIT_MS)
    }

    const unwatch = (w: Watched): void => {
      watched.delete(w.root)
      if (!w.sub) return
      const gone = w.sub.unsubscribe().catch(() => { /* already gone */ })
      leaving.add(gone)
      void gone.finally(() => leaving.delete(gone))
    }

    const watch = async (roots: string[]): Promise<void> => {
      const wanted = new Set(roots)
      for (const w of [...watched.values()]) if (!wanted.has(w.root)) unwatch(w)
      const { default: watcher } = await import('@parcel/watcher')
      for (const root of wanted) {
        if (watched.has(root) || disposed) continue
        const w: Watched = { root, real: root, sub: null }
        watched.set(root, w)
        try {
          w.real = await realpath(root)
          const sub = await watcher.subscribe(w.real, (err, events) => {
            if (!err) onEvents(w, events)
          }, { ignore: IGNORE })
          // Superseded while subscribing — another workspace became active, or the app is quitting.
          if (watched.get(root) !== w || disposed) {
            w.sub = sub
            unwatch(w)
            continue
          }
          w.sub = sub
        } catch (err) {
          // A folder that is missing, or inotify exhausted on Linux: the refresh button still works.
          console.warn(`[explorer] cannot watch ${root}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    ctx.effect(() => () => {
      disposed = true
      if (timer) clearTimeout(timer)
      if (ceiling) clearTimeout(ceiling)
      for (const w of [...watched.values()]) unwatch(w)
      // RETURNED, so cordis — and with it the quit — waits for the native unsubscribes to finish.
      // Leaving them running into process teardown is the SIGABRT-on-quit in DEVELOPMENT.md.
      return Promise.all([...leaving]).then(() => undefined)
    }, 'explorer watchers')

    registerExplorerCommands(register, {
      'explorer:watch': ({ roots }) => watch(roots.filter(Boolean))
    })
  }
}

export default plugin
