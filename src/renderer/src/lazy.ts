/**
 * xterm must never be a top-level import.
 *
 * Measured on this project's stack: eager imports of the heavy renderer libraries cost +1230 ms to
 * first paint, a 4,481 kB main chunk and 58 MB of renderer output. Loading xterm when the first
 * terminal tab opens costs nothing the user notices.
 *
 * Monaco used to be here too. It is not the shell's concern any more — the text editor and the
 * source control diff are plugins, and they share `plugins/shared/monaco.ts`. The shell owns
 * terminals, so it owns this loader and nothing else.
 */

export interface XtermBundle {
  Terminal: typeof import('@xterm/xterm').Terminal
  FitAddon: typeof import('@xterm/addon-fit').FitAddon
  WebglAddon: typeof import('@xterm/addon-webgl').WebglAddon
  SearchAddon: typeof import('@xterm/addon-search').SearchAddon
}

let xtermP: Promise<XtermBundle> | null = null

export function loadXterm(): Promise<XtermBundle> {
  xtermP ??= Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-webgl'),
    import('@xterm/addon-search')
  ]).then(([core, fit, webgl, search]) => ({
    Terminal: core.Terminal,
    FitAddon: fit.FitAddon,
    WebglAddon: webgl.WebglAddon,
    SearchAddon: search.SearchAddon
  }))
  return xtermP
}
