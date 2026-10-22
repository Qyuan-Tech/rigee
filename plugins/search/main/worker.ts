import { parentPort } from 'node:worker_threads'
import type { Locale } from '@rigee/plugin-api/l10n'
import { runSearch, watchChildren } from './engine'
import type { SearchQuery, SearchResult } from '../types'

/**
 * One search, off the main thread.
 *
 * The engine decides every match with a JavaScript regular expression, and V8's regex engine
 * backtracks: `(\w+\s*)+=` against one long line takes exponential time. On the main thread that
 * froze the whole app — terminals, IPC, saving, even the "save before quitting?" dialog — until it
 * was force-quit, taking unsaved work with it. In a worker, the main thread stays responsive and can
 * simply terminate the worker, which no AbortSignal could ever interrupt mid-match.
 */

export type WorkerRequest =
  /** `locale` is the shell's, for what the engine notes in its own words: a worker has no `ctx` to ask. */
  | { type: 'find'; query: SearchQuery; locale: Locale }
  | { type: 'cancel' }
export type WorkerReply =
  | { type: 'result'; result: SearchResult }
  | { type: 'error'; message: string }
  | { type: 'child'; pid: number; alive: boolean }

const controller = new AbortController()
watchChildren((pid, alive) => parentPort?.postMessage({ type: 'child', pid, alive } satisfies WorkerReply))

parentPort?.on('message', (message: WorkerRequest) => {
  if (message.type === 'cancel') {
    controller.abort()
    return
  }
  runSearch(message.query, controller.signal, { locale: message.locale }).then(
    (result) => parentPort?.postMessage({ type: 'result', result } satisfies WorkerReply),
    (err: unknown) => parentPort?.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies WorkerReply)
  )
})
