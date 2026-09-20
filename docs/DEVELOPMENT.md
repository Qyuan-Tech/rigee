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
| `pnpm git:selftest` | 58 checks against the git binary and a fixture repo |
| `pnpm panes:selftest` | 36 checks on the split tree and key chords, pure functions |
| `pnpm smoke:split` | opens a terminal, splits it twice, asserts three distinct ptys |
| `pnpm smoke:persist` | builds tabs and splits, then reads back what was written to disk |
| `pnpm smoke:terminal` | opens a terminal tab, types into it, waits for the shell to echo |
| `pnpm pack:check` | package, then boot the packaged app and assert it actually starts |
| `pnpm install:local` | build, package and install into /Applications, verified through `open` |
| `pnpm pack:mac` / `pack:win` / `pack:linux` / `pack:all` | installers into `release/<version>/` |

## Layout

```
src/
  shared/      types + the IPC contract; imported by all three targets
  main/        Electron main
    pty/       pseudo-terminals, one per split pane
    git/       status parsing, blobs, selective patching, filesystem watching
    browser.ts WebContentsView tab manager
    store.ts   atomic JSON persistence
  preload/     the contextBridge surface (compiled to CJS — see below)
  renderer/    React shell
scripts/       self-tests and the local installer
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

**The renderer builds without sourcemaps, and that is deliberate.** Mapping the 4 MB minified
Monaco chunk back over its ~1500 sources needs more than 2 GB of build heap. A 16 GB laptop gives
Node a ~4.3 GB old space and the build squeaks through at 4.1 GB peak RSS; a 7 GB GitHub runner
gives it ~2 GB, so CI aborted with *"Ineffective mark-compacts near heap limit"* — an error whose
only clue is a V8 stack trace with no mention of what was being built. The maps were reaching
nobody in any case: `electron-builder.yml` excludes `**/*.map`, so all 18 MB were generated and
then discarded at packaging time. `electron-vite dev` still serves unminified sources with full
maps, which is where renderer debugging happens. Main keeps its sourcemap; it is 66 kB and free.
The workflow also sets `NODE_OPTIONS=--max-old-space-size=4096` as margin, not as the fix.

**Each platform is packaged on its own runner, and Windows especially.** Nothing in this project
is compiled at package time, so cross-building looks like it should work — but the *packaging*
tools are native. Building `--win` on Linux gets all the way through makensis, produces all three
installers, and then dies in `finishBuild` with `spawn wine ENOENT`: `signAndEditExecutable`
stamps the icon, version block and manifest into each finished installer using rcedit, a Windows
binary. Installing wine would work and is brittle; turning the flag off ships an installer with a
blank icon. macOS is the same story with `hdiutil` and `codesign`.

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

**`saveWorkspaces` must not prune the UI map.** It used to drop UI belonging to workspaces absent
from the list it was given, which silently destroyed the Scratch workspace's tabs on every single
save — Scratch is synthesised rather than persisted, so it is absent by design. Pruning belongs to
`saveAllUi`, which receives every live workspace. Smoke modes run against a throwaway userData
directory for the same reason this was hard to notice: tests that write the developer's real
state are tests nobody trusts.

**Re-register the bundle with `lsregister` when replacing it.** LaunchServices caches a bundle's
code identity per path, so installing over an existing app leaves the old registration behind and
it refuses to launch the new one — `open` reports success, the process dies before main, and
stderr says only `codesign_util.cc: task_name_for_pid: (os/kern) failure (5)`. `lsregister -u`
before the copy and `-f` after fixes it; `pnpm install:local` does both.

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

## Terminals

`src/main/pty/manager.ts` runs one pseudo-terminal per pane through node-pty. This replaced a tmux
control-mode client, which is worth knowing because the git history is full of it: tmux bought
session persistence — shells that outlive the app and can be re-attached from outside it — at the
cost of an intricate protocol sitting between us and every keystroke. Plain ptys mean the split
layout is ours (`src/renderer/src/paneTree.ts`) rather than a mirror of tmux's, and Windows needs
no WSL. Anyone who wants a multiplexer can type `tmux` in a pane.

Two things about the data path:

- **Bytes do not go over ipcMain.** A build or an agent streaming output is thousands of writes a
  second, each one a structured-clone hop through the single ipcRenderer queue. Every workspace
  gets a MessagePort instead, with output coalesced on a 6 ms tick and keystrokes travelling back
  the same way so typing never queues behind anything else.
- **xterm instances never enter the store.** They live in a module map keyed by
  `<tabId>:<leafId>`, so re-rendering the layout re-parents a DOM node instead of recreating a
  terminal, and output cannot trigger a React render. The key is the *leaf* id, not the pty id:
  the leaf exists before a pty does and survives it being replaced.

Backpressure keeps the tail, not the head. A pane that outruns the renderer has its pending buffer
truncated to the most recent bytes — a terminal's value is in what just happened, and the
alternative is unbounded memory.

## Selective staging

`src/main/git/patch.ts` rewrites a unified diff so `git apply` stages, unstages or discards only
the lines the user picked. The whole trick is in one rule: for a change the user did *not* select,
work out which side of it exists in the image the patch will be applied onto, and turn that side
into context. Forward onto the index, an unselected `-` becomes context and an unselected `+` is
dropped; reversed, the opposite.

Three details that each cost a test to find:

- `\ No newline at end of file` belongs to the line **above** it and must be re-emitted after that
  line whatever it becomes — including a `-` demoted to context.
- Split the diff on `\n` only. A CR is content, and `/\r?\n/` silently strips it so the patch will
  not apply to a CRLF file.
- Keep `-U3` and never pass `--unidiff-zero`. Zero context leaves `git apply` nothing to verify
  against, and it misapplies quietly rather than failing.

`git diff` is empty for an untracked file, so `hunks()` marks one intent-to-add first; that yields
a `new file mode` hunk and per-line staging then works.

## Releases

Tag and push:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` typechecks, runs the self-tests, builds, and attaches the
installers to a GitHub release. `workflow_dispatch` runs the same thing without publishing.

Linux and Windows artifacts both come off `ubuntu-latest` — electron-builder repackages prebuilt
Electron binaries and node-pty ships prebuilds for all six targets, so nothing is compiled and no
wine is needed for an unsigned NSIS build. macOS needs its own `macos-latest` job because `dmg`
creation calls `hdiutil` and signing calls `codesign`.

If every job starts failing in a few seconds with no step logs and logs that 404, that is not the
YAML: it is a job that never started, meaning no runner was available to the repository. A
workflow containing no `uses:` at all is the quickest way to tell the two apart — see
`.github/workflows/probe.yml`.

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
