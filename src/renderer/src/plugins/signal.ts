/**
 * One change notification for the whole plugin UI.
 *
 * Two things move under the shell's feet and both have to re-render the same handful of host
 * components: a plugin binding or unbinding a component (`bindings.ts`), and a plugin being
 * enabled or disabled (`registry.ts`). They are different modules with no business importing each
 * other, so the counter they share lives here.
 *
 * Coarse on purpose. Both events happen when a plugin starts or stops — a few times in a session,
 * never in a loop — so a finer-grained signal would cost more to maintain than it could save.
 */

let version = 0
const listeners = new Set<() => void>()

/** For `useSyncExternalStore`: a number that changes when anything about the plugin UI does. */
export function pluginUiVersion(): number {
  return version
}

export function subscribePluginUi(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function pluginUiChanged(): void {
  version++
  for (const listener of listeners) listener()
}
