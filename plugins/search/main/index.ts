import type { Context, Plugin } from 'cordis'
import type { Worker } from 'node:worker_threads'
import { registerSearchCommands } from '../protocol'
import { MAX_RESULTS, type SearchQuery, type SearchResult } from '../types'
import createSearchWorker from './worker?nodeWorker'
import type { WorkerReply } from './worker'

/**
 * Search, main half: runs each search in its own worker thread (see worker.ts for why) and cancels
 * the ones a newer keystroke has replaced.
 *
 * Cancelling asks the worker to stop, which kills its ripgrep or git and answers with what it had;
 * a worker that does not answer promptly is stuck in a regular expression, and is terminated — and
 * its children, which terminating a thread does not end, are killed from here. A search that runs
 * past its time limit is stopped the same way, keeping what it had found. `inject` is mandatory, as for every main half — see plugins/scm/main/index.ts.
 */

/** Long enough for any real search of a real workspace; short enough that a runaway regex ends. */
const TIME_LIMIT_MS = 30_000
/** How long a cancelled worker gets to wind down its child processes before it is terminated. */
const GRACE_MS = 400

interface Running {
  worker: Worker
  cancel: (reason?: string) => void
}

const plugin: Plugin = {
  name: 'search',
  inject: ['commands'],
  apply(ctx: Context) {
    const commands = ctx.commands
    const register = commands.register.bind(commands)
    const running = new Map<string, Running>()

    ctx.effect(() => () => {
      for (const r of running.values()) r.cancel()
      running.clear()
    }, 'running searches')

    registerSearchCommands(register, {
      'search:find': ({ id, ...query }) => {
        running.get(id)?.cancel()
        return new Promise<SearchResult>((resolve) => {
          const started = Date.now()
          const worker = createSearchWorker({})
          /** The worker's ripgrep and git, so they can be killed even if the worker cannot. */
          const children = new Set<number>()
          let settled = false
          let stopReason: string | undefined
          const finish = (result: SearchResult): void => {
            if (settled) return
            settled = true
            clearTimeout(limit)
            if (running.get(id)?.worker === worker) running.delete(id)
            for (const pid of children) {
              try { process.kill(pid) } catch { /* already gone */ }
            }
            void worker.terminate()
            resolve(stopReason && !result.error ? { ...result, error: stopReason } : result)
          }
          const empty = (error?: string): SearchResult => ({
            files: [],
            matchCount: 0,
            truncated: false,
            engine: 'node',
            elapsedMs: Date.now() - started,
            ...(error ? { error } : {})
          })
          // Asked to stop, the worker answers with what it has found so far; one that does not answer
          // within the grace period is stuck in a regular expression and is ended without it.
          const cancel = (reason?: string): void => {
            stopReason = reason
            worker.postMessage({ type: 'cancel' })
            setTimeout(() => finish(empty(reason)), GRACE_MS).unref?.()
          }
          const limit = setTimeout(
            () => cancel(`Stopped after ${TIME_LIMIT_MS / 1000} s — showing what was found by then`),
            TIME_LIMIT_MS
          )
          limit.unref?.()

          worker.on('message', (reply: WorkerReply) => {
            if (reply.type === 'child') {
              if (reply.alive) children.add(reply.pid)
              else children.delete(reply.pid)
            } else if (reply.type === 'result') finish(reply.result)
            else finish(empty(reply.message))
          })
          worker.on('error', (err) => finish(empty(err.message)))
          worker.on('exit', () => finish(empty()))

          running.set(id, { worker, cancel })
          const request: SearchQuery = { maxResults: MAX_RESULTS, ...query }
          worker.postMessage({ type: 'find', query: request })
        })
      },
      'search:cancel': ({ id }) => {
        running.get(id)?.cancel()
        running.delete(id)
      }
    })
  }
}

export default plugin
