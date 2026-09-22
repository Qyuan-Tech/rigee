import { browserClient } from '../protocol'
import type { BrowserCall, BrowserEvents } from '../protocol'

/**
 * The renderer half's end of the plugin RPC, captured once at activation.
 *
 * Two things live here because neither can live in a component:
 *
 *   - `invoke`. `browser:setBounds` fires from a ResizeObserver and on every frame of a splitter
 *     drag; reading `ctx.rpc.invoke` off the context per call rebuilds a shadow context at ~15 us
 *     against 68 ns for a captured reference, which is a frame budget spent on nothing.
 *   - the event fan-out. `ctx.rpc.on` registers through `ctx.effect`, so the subscription is
 *     revoked when the plugin is disposed — but a React component has no context to register
 *     with, and one subscription per mounted pane would leak past the plugin's life. So the entry
 *     subscribes once for the plugin and re-broadcasts through the plain Sets below.
 */

let captured: BrowserCall | null = null

/**
 * Hand over the plugin's own `ctx.rpc.invoke`, typed by the command map.
 *
 * Called once, from the renderer entry's apply. Going through `browserClient` is what makes a
 * mistyped command name or a payload missing a field a compile error here rather than a rejected
 * promise at click time — the one guarantee the twenty-two typed IPC channels had that a single
 * `plugin:invoke` does not.
 */
export function bindRpc(invoke: (command: string, args: unknown) => Promise<unknown>): void {
  captured = browserClient(invoke)
}

/**
 * Call one of the main half's commands.
 *
 * Rejects rather than silently doing nothing when the plugin is not running: every caller here is
 * inside a component the plugin itself bound, so an unbound rpc means the ordering assumption is
 * wrong and we want to hear about it.
 */
export const invoke: BrowserCall = (command, args) => {
  if (!captured) return Promise.reject(new Error(`${command}: the browser plugin is not active`))
  return captured(command, args)
}

const listeners = new Map<keyof BrowserEvents, Set<(payload: never) => void>>()

/** Subscribe to one of the main half's events. Returns the unsubscribe, for a React effect. */
export function on<K extends keyof BrowserEvents>(
  event: K,
  listener: (payload: BrowserEvents[K]) => void
): () => void {
  let set = listeners.get(event)
  if (!set) { set = new Set(); listeners.set(event, set) }
  const erased = listener as (payload: never) => void
  set.add(erased)
  return () => { listeners.get(event)?.delete(erased) }
}

/** Fan one event out. Called only by the entry, from its single `ctx.rpc.on` per event. */
export function dispatch<K extends keyof BrowserEvents>(event: K, payload: BrowserEvents[K]): void {
  const set = listeners.get(event)
  if (!set) return
  for (const listener of set) (listener as (payload: BrowserEvents[K]) => void)(payload)
}
