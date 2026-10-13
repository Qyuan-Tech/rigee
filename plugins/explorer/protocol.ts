/**
 * The explorer's contract: what its two halves say to each other.
 *
 * REALM-FREE, like every protocol.ts: compiled into both the node project and the web project, so
 * types and the small typed wrappers only — no node:*, no DOM — plus the one rule both halves have
 * to apply alike, which names a file may have.
 */

export interface ExplorerCommands {
  /**
   * Watch exactly these folders — the active workspace's — for entries appearing and disappearing,
   * replacing whatever was watched before. An empty list stops watching.
   */
  'explorer:watch': (args: { roots: string[] }) => void
  /**
   * An empty file, or a folder, called `name` in `dir`: its path. A name with slashes in it makes
   * the folders on the way, as VS Code's does. Rejects, saying why, if the name is taken.
   */
  'explorer:create': (args: { dir: string; name: string; folder: boolean }) => string
  /** Rename in place — `name` is the new last segment, never a path — and answer the new path. */
  'explorer:rename': (args: { path: string; name: string }) => string
  /** Copy or move entries into a folder, asking first where the user has to decide. See `Transfer`. */
  'explorer:transfer': (args: Transfer) => TransferResult
  /**
   * Delete, to the Trash unless `permanently`, once the user has said yes: what went. `unsaved` are
   * the open files among them with unsaved changes, which the question names.
   */
  'explorer:delete': (args: { paths: string[]; permanently: boolean; unsaved: string[] }) => string[]
  /** Show it selected in Finder, File Explorer or the file manager. */
  'explorer:reveal': (args: { path: string }) => void
  /** Put text on the clipboard: Copy Path, Copy Relative Path. */
  'explorer:copyText': (args: { text: string }) => void
}

export interface Transfer {
  sources: string[]
  /** The folder they go into. */
  target: string
  mode: 'copy' | 'move'
  /**
   * Dropped in from another application rather than taken from the tree. A name already taken in
   * the folder is then asked about — replace it or leave it — where a copy made inside the tree is
   * given the next free name instead, `name copy.txt`, as VS Code does.
   */
  external?: boolean
  /**
   * The folder is one of the workspace's own, so a folder dropped on it from outside may have been
   * meant to join the workspace rather than be copied into it: the user is asked which.
   */
  intoRoot?: boolean
  /** Files among the sources with unsaved changes. A move refuses them: see `filesMoved`. */
  unsaved?: string[]
}

export interface TransferResult {
  /** What went where, in order: for the tabs, the selection and the open folders to follow. */
  done: Array<{ from: string; to: string }>
  /** Folders the user chose to add to the workspace instead of copying. */
  addToWorkspace?: string[]
}

/**
 * Why a name cannot be given to a file or folder, or null when it can. Both halves ask: the tree as
 * you type, and main before anything reaches the disk, where a name that climbed out of its folder
 * would do real damage. Whether the name is already taken is a separate question — the tree reads
 * its listing, main the disk.
 *
 * `nested` allows slashes, for New File's `src/lib/new.ts`; a rename never does.
 */
export function nameProblem(name: string, options: { nested: boolean; windows: boolean }): string | null {
  if (name.trim() === '') return 'A file or folder name must be provided.'
  if (name.includes('\0')) return 'A name cannot contain a NUL character.'
  const parts = name.split(options.windows ? /[\\/]/ : '/')
  if (parts.length > 1 && !options.nested) return 'A name cannot contain a slash.'
  for (const part of parts) {
    if (part === '') return 'A name cannot start or end with a slash, or have two in a row.'
    if (part === '.' || part === '..') return `“${part}” is not a valid file or folder name.`
    if (options.windows && /[<>:"|?*]/.test(part)) return 'A name cannot contain any of < > : " | ? *'
  }
  return null
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
