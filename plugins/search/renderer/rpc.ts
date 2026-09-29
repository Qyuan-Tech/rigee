import { searchClient, type SearchCall } from '../protocol'

/** The plugin's line to main, parked for components. See plugins/scm/renderer/rpc.ts. */
let live: SearchCall | null = null

export function connect(invoke: (command: string, args: unknown) => Promise<unknown>): () => void {
  live = searchClient(invoke)
  return () => { live = null }
}

export const search: SearchCall = (command, args) => {
  if (!live) return Promise.reject(new Error(`search is not active, cannot ${command}`))
  return live(command, args)
}
