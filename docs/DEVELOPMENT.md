# Developing onestop

```bash
pnpm install
pnpm dev            # electron-vite dev --watch
```

Renderer edits hot-reload with state preserved. Main and preload edits rebuild and restart
Electron — that needs `--watch`, which `pnpm dev` already passes.

| command | what it does |
|---|---|
| `pnpm dev` | dev server + Electron, watching all three targets |
| `pnpm dev:renderer` | renderer only, no Electron restarts — good for pure UI work |
| `pnpm typecheck` | `tsc -b` over the three project references |
| `pnpm build` | typecheck, then build main / preload / renderer |
| `pnpm smoke` | launch headless, assert the shell mounted, exit non-zero if not |
| `pnpm tmux:selftest` | 26 checks against a real tmux server on a private socket |
| `pnpm git:selftest` | 48 checks against the git binary and a fixture repo |
| `pnpm smoke:terminal` | opens a terminal tab, types into it, waits for the shell to echo |
| `pnpm pack:check` | package, then boot the packaged app and assert it actually starts |
| `pnpm install:local` | build, package and install into /Applications, verified through `open` |
| `pnpm pack:mac` / `pack:win` / `pack:linux` / `pack:all` | installers into `release/<version>/` |

## Layout

```
src/
  shared/      types + the IPC contract; imported by all three targets
  main/        Electron main
    tmux/      control-mode client: parser, layout grammar, session manager
    browser.ts WebContentsView tab manager
    store.ts   atomic JSON persistence
  preload/     the contextBridge surface (compiled to CJS — see below)
  renderer/    React shell
scripts/       tmux-selftest.ts
```

Three tsconfig projects, because the three targets genuinely differ: `tsconfig.node.json` (main,
no DOM), `tsconfig.preload.json` (DOM **and** Node — the preload straddles both), and
`tsconfig.web.json` (renderer, no Node).

## Things that will bite you

Each of these cost real debugging time. They are commented at the site too; this is the index.

**The preload must compile to CJS.** `package.json` sets `"type": "module"`, so electron-vite
would emit an ESM preload, and an ESM preload under `sandbox: true` fails with *"Cannot use import
statement outside a module"* — `window.onestop` then silently never appears and the renderer dies
on `undefined.invoke`. `electron.vite.config.ts` forces `format: 'cjs'` and `index.cjs`.

**Never name a dynamically-imported package in `manualChunks`.** Doing so pulls it into the
entry's static graph, Vite emits a `<link rel="modulepreload">` for it, and the browser downloads
and parses it during startup — which exactly undoes the lazy import. Listing `monaco-editor` there
cost a 3.8 MB preload and took `dom-ready` from 0.83 s to 14.6 s. Monaco and xterm are loaded
through `src/renderer/src/lazy.ts`; Rollup already gives each its own chunk.

**Do not add `@electron/rebuild`.** node-pty is a Node-API addon shipping prebuilds for all six
targets, so nothing needs rebuilding. Running it anyway produces a host-arch binary in
`build/Release`, which node-pty's loader prefers over `prebuilds/`, and that poisons
cross-platform packaging. `electron-builder.yml` excludes those paths and sets `npmRebuild: false`.

**`window.open` inside a `WebContentsView` must adopt, not create.** `createWindow(options)`
receives the already-created guest on `options.webContents` — a field that is **not** declared in
`BrowserWindowConstructorOptions`. Returning a freshly constructed view's `webContents` throws
*"Invalid webContents"* for every `webPreferences` combination. See `src/main/browser.ts`.

**The `login` event has four different arities.** On `app` it takes five arguments, on
`WebContents` four, on `ClientRequest` two, on `UtilityProcess` three, and `Session` has no such
event at all. Dropping `authenticationResponseDetails` from the `WebContents` form binds
`callback` to the `authInfo` object and you get *"cb is not a function"*. onestop registers once on
`app` and routes by the `webContents` argument.

**Pin the dependency versions.** electron-vite 5 constrains vite to ≤7, `@vitejs/plugin-react` 6
requires vite 8, and `@types/node@latest` still points at the 22 line while Electron 44 runs Node
24. The set in `package.json` is one that actually installs and builds together.

**A BaseWindow does not focus its child views.** A BrowserWindow hands keyboard focus to its own
webContents; a BaseWindow does not hand it to a WebContentsView. The window looks alive, the DOM
reports focus wherever it was set programmatically, and yet nothing the user types reaches the
app — not the terminal, not the commit box. `focusActiveView()` is called after load, on window
focus, and whenever a browser tab is shown or hidden. `pnpm smoke` asserts `shellFocused=true`.

**Copy app bundles with `ditto`, never `cp -R`.** A macOS bundle carries metadata that plain
`cp` does not faithfully reproduce, and Electron validates its own bundle at startup — Info.plist
holds an `ElectronAsarIntegrity` SHA256 of app.asar. A `cp -R` copy dies before main runs: no
window, no stdout, and a lone `codesign_util.cc: task_name_for_pid: (os/kern) failure (5)` on
stderr. Use `pnpm install:local`, which does this correctly.

**Verify installs with `open`, not by running the binary.** Both of the bundle-corruption bugs
above reproduce only through LaunchServices; invoking
`onestop.app/Contents/MacOS/onestop` directly works perfectly in each case, which is exactly why
they survived several rounds of "it works here".

**Never run `codesign --force --deep --sign -` on the built app.** `--deep` is deprecated and
signs Electron's nested helper bundles in a way Electron itself rejects: the app dies at startup
with `codesign_util.cc: task_name_for_pid: (os/kern) failure (5)` and, launched from Finder,
simply never appears. electron-builder already leaves the bundle in a launchable state; on Intel
macOS an unsigned app runs once `xattr -dr com.apple.quarantine` has been applied. If an arm64
bundle genuinely needs an ad-hoc signature, sign it without `--deep` and verify by launching it
through `open`, not by running the binary directly — the binary runs fine either way, which is
what makes this so easy to miss.

**Do not hand-list packages in electron-builder `files`.** It packs `dependencies` and their
transitive deps already. An allowlist written when there was one dependency silently dropped
`picomatch`, which `@parcel/watcher` requires, and the packaged app then threw during module
evaluation and produced no window, no log and no exit code worth reading — the failure mode is
invisible. Prune *inside* packages, never choose packages. `pnpm pack:check` boots the packaged
app so this cannot ship again.

**Do not watch directories with chokidar.** It opens one fs.watch per directory, and a
GUI-launched app on macOS inherits `launchctl limit maxfiles` — a soft limit of **256**, not the
1M a terminal reports. Watching any real repository dies with EMFILE. @parcel/watcher uses one
FSEvents stream instead.

**A long-lived `git cat-file --batch` caches the index it started with.** After `git add`, the
same process keeps returning the pre-add blob for `:0:<path>`. Since the user's own terminal is
a likely place to run `git add`, the reader accepts object ids only and callers resolve specs
through `rev-parse` first.

## The tmux client

`src/main/tmux/` speaks tmux control mode over a pipe. No pty is involved: `-C` (never `-CC`,
which calls `tcgetattr(stdin)` and exits when stdin is not a tty) needs no terminal, which is also
what lets Windows pipe through `wsl.exe` without ConPTY.

Four protocol rules the code depends on, all verified against tmux 3.6a:

1. **Attach with `-f pause-after=N`, always.** Without it tmux kills the client once the head of
   the output queue is 300 s old, and every terminal in the app dies with it.
2. **Only guard blocks with `flags == 1` answer your commands.** Config parsing and hooks emit
   blocks too, sharing one server-global counter, so a queue that pops on every `%begin`
   desynchronises permanently.
3. **A block closes only on a terminator byte-identical to its own `%begin` triple.** In-band
   command output is not escaped, so a pane displaying the text `%end 1 2 3` will close a naive
   parser's block early and feed raw escape sequences into the notification dispatcher.
4. **`%layout-change` is the only signal that panes came or went.** There is no `%pane-add` or
   `%pane-close`; the layout tree is diffed instead.

Also: never issue `run-shell`, `if-shell` or `display-popup` on the control stream. Their output is
printed later with no framing at all, so a payload containing `%exit` is indistinguishable from a
real notification. Shell out from the main process instead.

### Running the self-test

```bash
pnpm tmux:selftest
```

It starts a real tmux server **on a private socket** and exercises the parser, the layout grammar,
both write paths and their 64-byte boundary, splits, and capture-pane.

> Every tmux command in this repo and its tests is pinned to a private socket with `-S`. A bare
> `tmux kill-server` during development once destroyed fourteen live sessions belonging to the
> person working on it. If you add tmux code, carry the flag — including on cleanup commands at
> the end of a shell one-liner, which is exactly where it got forgotten.

Two failures the self-test hit early on were the test's fault, not the client's, and are worth
knowing before you write more terminal tests:

- In canonical mode, `VEOF` (Ctrl-D) only flushes the current line buffer. It signals end-of-file
  solely on an **empty** line, so one Ctrl-D after a payload with no trailing newline hands the
  bytes over but leaves the reader running.
- `MAX_CANON` caps a cooked-mode line at 1024 bytes on macOS. A 4 KiB single line simply cannot be
  delivered to a reader that has not put the tty in raw mode.

## Releases

Tag and push:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` typechecks, runs the tmux self-test against a real tmux on the
runner, builds every platform, and attaches the installers to a GitHub release. `workflow_dispatch`
runs the same thing without publishing.

macOS artifacts are built on `macos-latest` rather than `ubuntu-latest`, because `dmg` needs
`hdiutil` and signing needs `codesign` — neither exists on Linux. Linux and Windows artifacts do
both come off `ubuntu-latest`.

### Signing

Builds are unsigned. To sign:

- **macOS** — drop `mac.identity: null` from `electron-builder.yml`, set `CSC_LINK` and
  `CSC_KEY_PASSWORD`, keep `hardenedRuntime` and `build/entitlements.mac.plist` (V8's JIT and
  dlopen'ing node-pty both need those entitlements), then set `notarize.teamId` with `APPLE_ID` and
  `APPLE_APP_SPECIFIC_PASSWORD`.
- **Windows** — provide `CSC_LINK` / `CSC_KEY_PASSWORD`. Without an OV or EV certificate SmartScreen
  will still warn until the binary builds reputation.

Never commit certificates. `.gitignore` already covers `*.p12`, `*.pfx`, `*.pem`, `*.cer` and
`.env`.
