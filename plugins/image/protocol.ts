/**
 * What the image viewer's two halves say to each other: one command, one direction, no events.
 * Decoding, scaling and drawing all happen in the renderer, where Chromium does them natively.
 *
 * REALM-FREE. Compiled into both the node project and the web project, so no node:*, no DOM, no
 * JSX — types, and the wrappers at the bottom that keep either half from spelling the command
 * name as a bare string.
 */

/** A whole image file, read off disk. */
export interface ImageFile {
  /** Over a plain ArrayBuffer, never a shared one: it goes straight into a Blob. */
  bytes: Uint8Array<ArrayBuffer>
  size: number
  /**
   * Named from the extension. Chromium sniffs the bytes whatever this says, so a `.png` that is
   * really a JPEG still shows — but a Blob should say what it holds.
   */
  mime: string
}

export interface ImageCommands {
  /** Read the whole file. Rejects for a missing file or one past the size cap. */
  'image:read': (args: { path: string }) => ImageFile
}

export type ImageCommand = keyof ImageCommands
export type ImageArgs<K extends ImageCommand> = Parameters<ImageCommands[K]>[0]
export type ImageResult<K extends ImageCommand> = Awaited<ReturnType<ImageCommands[K]>>

/** One typed call. What the renderer half uses instead of `invoke('image:read', …)`. */
export type ImageCall = <K extends ImageCommand>(command: K, args: ImageArgs<K>) => Promise<ImageResult<K>>

/** Wrap the host's untyped `invoke` in the command map, so a typo is a compile error. */
export function imageClient(invoke: (command: string, args: unknown) => Promise<unknown>): ImageCall {
  return (command, args) => invoke(command, args) as never
}

/**
 * Every handler the main half must provide, derived from the command map — so adding a command
 * here fails the build in main until it is answered.
 */
export type ImageHandlers = {
  [K in ImageCommand]: (args: ImageArgs<K>) => ImageResult<K> | Promise<ImageResult<K>>
}

export function registerImageCommands(
  register: (name: string, handler: (payload: unknown) => unknown) => void,
  handlers: ImageHandlers
): void {
  for (const [name, handler] of Object.entries(handlers)) {
    register(name, handler as (payload: unknown) => unknown)
  }
}
