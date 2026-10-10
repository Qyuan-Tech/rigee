import { lazy } from 'react'

/**
 * The save form and the question a new terminal asks, fetched the first time either is shown.
 * Render them inside a Suspense.
 *
 * Neither is on screen at startup, and `pnpm perf:check` holds the entry chunk to a budget that
 * everything that is has to fit in. Fetched anyway once startup is over, so that the name field is
 * there to type into the moment it is wanted rather than a beat after.
 */
const load = (): Promise<typeof import('./SaveWorkspace')> => import('./SaveWorkspace')

export const SaveAsForm = lazy(() => load().then((m) => ({ default: m.SaveAsForm })))
export const SaveReminder = lazy(() => load().then((m) => ({ default: m.SaveReminder })))

setTimeout(() => { void load() }, 3000)
