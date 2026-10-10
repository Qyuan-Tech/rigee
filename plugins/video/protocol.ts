/**
 * What the video player's two halves say to each other: a URL to play a file from, and letting it
 * go. The bytes never cross IPC — the <video> element streams them itself, from the shell's media
 * scheme, asking for whichever stretch it is about to play.
 *
 * REALM-FREE. Compiled into both the node project and the web project, so no node:*, no DOM, no
 * JSX — types, and the wrappers at the bottom that keep either half from spelling a command name
 * as a bare string.
 */

/** A file the renderer can now play. */
export interface VideoSource {
  /** Streams the file, Range requests and all, until released. Names a token, not the path. */
  url: string
  size: number
  /** Named from the extension. Chromium sniffs the container whatever this says. */
  mime: string
}

export interface VideoCommands {
  /** Serve one file. Rejects for a file that is missing or is not a file. */
  'video:open': (args: { path: string }) => VideoSource
  /** Stop serving a URL `video:open` returned — when its player closes, or loads the file again. */
  'video:release': (args: { url: string }) => void
}

export type VideoCommand = keyof VideoCommands
export type VideoArgs<K extends VideoCommand> = Parameters<VideoCommands[K]>[0]
export type VideoResult<K extends VideoCommand> = Awaited<ReturnType<VideoCommands[K]>>

/** One typed call. What the renderer half uses instead of `invoke('video:open', …)`. */
export type VideoCall = <K extends VideoCommand>(command: K, args: VideoArgs<K>) => Promise<VideoResult<K>>

/** Wrap the host's untyped `invoke` in the command map, so a typo is a compile error. */
export function videoClient(invoke: (command: string, args: unknown) => Promise<unknown>): VideoCall {
  return (command, args) => invoke(command, args) as never
}

/** Every handler the main half must provide, derived from the command map. */
export type VideoHandlers = {
  [K in VideoCommand]: (args: VideoArgs<K>) => VideoResult<K> | Promise<VideoResult<K>>
}

export function registerVideoCommands(
  register: (name: string, handler: (payload: unknown) => unknown) => void,
  handlers: VideoHandlers
): void {
  for (const [name, handler] of Object.entries(handlers)) {
    register(name, handler as (payload: unknown) => unknown)
  }
}
