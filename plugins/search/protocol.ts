import type { SearchQuery, SearchResult } from './types'

/**
 * The search contract between the plugin's two halves. Realm-free, like every protocol.ts.
 *
 * Two commands and no events. A search answers once, whole: ripgrep over a large repository is
 * done in well under a second, and streaming partial results into the panel would cost more in
 * re-rendering than it saves in waiting. `cancel` is what keeps typing cheap — every keystroke
 * starts a search, and the one it replaces is killed rather than left to finish.
 */
export interface SearchCommands {
  /** `id` names the search so a later `cancel` can find it. */
  'search:find': (args: SearchQuery & { id: string }) => SearchResult
  'search:cancel': (args: { id: string }) => void
}

export type SearchCommand = keyof SearchCommands
export type SearchArgs<K extends SearchCommand> = Parameters<SearchCommands[K]>[0]
export type SearchResultOf<K extends SearchCommand> = Awaited<ReturnType<SearchCommands[K]>>
export type SearchCall = <K extends SearchCommand>(command: K, args: SearchArgs<K>) => Promise<SearchResultOf<K>>

export type SearchHandlers = {
  [K in SearchCommand]: (args: SearchArgs<K>) => SearchResultOf<K> | Promise<SearchResultOf<K>>
}

export function searchClient(invoke: (command: string, args: unknown) => Promise<unknown>): SearchCall {
  return (command, args) => invoke(command, args) as never
}

export function registerSearchCommands(
  register: (name: string, handler: (payload: unknown) => unknown) => void,
  handlers: SearchHandlers
): void {
  for (const [name, handler] of Object.entries(handlers)) {
    register(name, handler as (payload: unknown) => unknown)
  }
}
