import { lazy, Suspense } from 'react'
import type { PluginViewProps } from '../plugins/bindings'

/**
 * The plugins view, fetched the first time it is shown.
 *
 * It is not on screen at startup, and with searching GitHub, installing, updating and uninstalling
 * it is now too much to carry in the entry chunk, which `pnpm perf:check` holds to a budget that
 * everything drawn on the first frame has to fit in. Fetched anyway once startup is over, so that
 * opening it is instant rather than a beat late.
 */
const load = (): Promise<typeof import('./PluginsView')> => import('./PluginsView')
const PluginsView = lazy(() => load().then((m) => ({ default: m.PluginsView })))

export function LazyPluginsView(props: PluginViewProps): React.ReactElement {
  return (
    <Suspense fallback={null}>
      <PluginsView {...props} />
    </Suspense>
  )
}

setTimeout(() => { void load() }, 3000)
