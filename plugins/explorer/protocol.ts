/**
 * The explorer's contract: what its two halves say to each other.
 *
 * REALM-FREE, like every protocol.ts: compiled into both the node project and the web project, so
 * types and the small typed wrappers only — no node:*, no DOM.
 */

export interface ExplorerCommands {
  /**
   * Watch exactly these folders — the active workspace's — for entries appearing and disappearing,
   * replacing whatever was watched before. An empty list stops watching.
   */
  'explorer:watch': (args: { roots: string[] }) => void
}

/** Pushes from main. Plugin-local names: the envelope carries the plugin id. */
export interface ExplorerEvents {
  /**
   * Entries were created, deleted or renamed. `dirs` holds every directory whose listing may now be
   * different — the parent of each path that changed, and the path itself in case it was a
   * directory — spelled the way the folder was given to `explorer:watch`, not as the disk resolves it.
   */
  changed: { dirs: string[] }
}

export type ExplorerCommand = keyof ExplorerCommands
export type ExplorerArgs<K extends ExplorerCommand> = Parameters<ExplorerCommands[K]>[0]
export type ExplorerResult<K extends ExplorerCommand> = Awaited<ReturnType<ExplorerCommands[K]>>

export type ExplorerCall = <K extends ExplorerCommand>(command: K, args: ExplorerArgs<K>) => Promise<ExplorerResult<K>>

export function explorerClient(invoke: (command: string, args: unknown) => Promise<unknown>): ExplorerCall {
  return (command, args) => invoke(command, args) as never
}

export function explorerEmitter(
  emit: (event: string, payload: unknown) => void
): <K extends keyof ExplorerEvents>(event: K, payload: ExplorerEvents[K]) => void {
  return (event, payload) => { emit(event, payload) }
}

export function explorerSubscriber(
  on: (event: string, listener: (payload: never) => void) => void
): <K extends keyof ExplorerEvents>(event: K, listener: (payload: ExplorerEvents[K]) => void) => void {
  return (event, listener) => { on(event, listener as (payload: never) => void) }
}

export type ExplorerHandlers = {
  [K in ExplorerCommand]: (args: ExplorerArgs<K>) => ExplorerResult<K> | Promise<ExplorerResult<K>>
}

export function registerExplorerCommands(
  register: (name: string, handler: (payload: unknown) => unknown) => void,
  handlers: ExplorerHandlers
): void {
  for (const [name, handler] of Object.entries(handlers)) {
    register(name, handler as (payload: unknown) => unknown)
  }
}
