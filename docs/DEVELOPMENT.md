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
| `pnpm panes:selftest` | 102 checks on the split tree, key chords and the tab strip, pure functions |
| `pnpm perf:check` | asserts the startup budget against a real build (see Plugins) |
| `pnpm smoke:plugins` | asserts the plugin boundary: the text editor loads, pdf.js does not |
| `pnpm smoke:pdf` | renders a PDF the app prints for itself and checks pixels reached the canvas |
| `pnpm smoke:split` | opens a terminal, splits it twice, asserts three distinct ptys |
| `pnpm smoke:persist` | builds tabs and splits, then reads back what was written to disk |
| `pnpm smoke:terminal` | opens a terminal tab, types into it, waits for the shell to echo |
| `pnpm pack:check` | package, then boot the packaged app and assert it actually starts |
| `pnpm install:local` | build, package and install into /Applications, verified through `open` |
| `pnpm pack:mac` / `pack:win` / `pack:linux` / `pack:all` | installers into `release/<version>/` |

### Fixtures for the smoke modes

Three modes need a directory to point at, and two of them fail confusingly if you pick the wrong
one:

```bash
ONESTOP_SMOKE_MULTIREPO=/private/tmp/repos pnpm smoke:multirepo   # a directory OF git repos
ONESTOP_SMOKE_MULTIREPO=/private/tmp/repos pnpm smoke:explorer    # two or more folders
ONESTOP_SMOKE_REPO=/private/tmp/bigrepo    pnpm smoke:scroll      # one repo, see below
```

**Use `/private/tmp`, not `/tmp`.** On macOS `/tmp` is a symlink, so `git rev-parse
--show-toplevel` answers with the resolved path while the workspace holds the one you passed. The
source control panel keys statuses by repository root, the two never match, and the panel sits on
"reading alpha…" for ever — which reads exactly like source control being broken.

**`smoke:scroll` needs a repository big enough to overflow both panels**: dozens of dirty files and
dozens of top-level entries. Against a tidy repo it fails with `explorer-fixture-too-small`, which
is the check refusing to pass vacuously rather than a regression.

## Layout

```
src/
  shared/      types + the IPC contract + the plugin contract; imported by all three targets
  main/        Electron main — the shell only
    pty/       pseudo-terminals, one per split pane
    plugins/   the main-side plugin host: cordis root, command registry, shell service
    store.ts   atomic JSON persistence
  preload/     the contextBridge surface (compiled to CJS — see below)
  renderer/    React shell — window, workspaces, explorer, tabs, terminals
    src/plugins/  the renderer-side host, the manifest registry and the component bindings
  plugins/     the features, one folder each
    text-editor/  Monaco, and the editor of last resort for every file
    pdf/          the PDF reader
    scm/          git: status, staging by line, commits, diffs
    browser/      Chromium tabs as native WebContentsViews
    shared/       what more than one plugin needs (the Monaco loader). Not a plugin.
scripts/       self-tests, the startup budget check and the local installer
```

Three tsconfig projects, because the three targets genuinely differ: `tsconfig.node.json` (main,
no DOM), `tsconfig.preload.json` (DOM **and** Node — the preload straddles both), and
`tsconfig.web.json` (renderer, no Node). Plugins straddle two of them by file name:
`src/plugins/*/main/**` belongs to the node project, `src/plugins/*/renderer/**` to the web
project, and `manifest.ts` / `protocol.ts` to both. That split is mandatory, not tidiness — see
the plugin section below.

## Plugins

The shell is a window, a workspace model, a tab framework, terminals, persistence and an IPC
spine. Everything else is a plugin: the text editor, the PDF reader, source control and the
browser all live in `src/plugins/<id>/` and reach the shell only through the contract in
`src/shared/plugin.ts`. The framework underneath is [cordis](https://github.com/cordiverse/cordis).

A plugin is up to two halves, because Electron leaves no choice — a PDF renders in the sandboxed
renderer and the bytes it renders can only be read in main:

```
src/plugins/pdf/
  manifest.ts          what exists: id, version, contributions. Plain data, read in both realms.
  protocol.ts          the command and event types the two halves share. Realm-free.
  main/index.ts        default-exports a cordis Plugin. Node only.
  renderer/index.tsx   default-exports a cordis Plugin. DOM only.
```

`src/plugins/index.ts` lists the manifests; `registry.main.ts` and `registry.renderer.ts` hold the
dynamic-import thunks, one file per realm.

**Contribution points.** `editors` (a viewer for files matching a selector), `tabs` (a tab type the
plugin owns outright, with its own persisted state), `views` (a side-bar panel), `statusBar`, and
`overlays` (a dialog mounted at the shell root while the plugin is active). All declarative: the
shell can draw the tab strip, resolve which viewer opens a `.pdf` and decide what goes in the right
rail without loading a line of plugin code.

**Activation is lazy and demand-driven.** A renderer half loads when something it contributed is
first needed — a tab of its view type renders, its panel mounts, its "new tab" button is pressed. A
main half loads when the renderer first calls one of its commands. Opening a `.ts` file loads the
text editor and nothing else; `pnpm smoke:plugins` asserts exactly that, because it is the property
the whole design exists to produce.

**Two IPC channels, forever.** `plugin:invoke` carries every renderer→main call and `plugin:event`
carries every push. Source control and the browser used to own twenty-two entries in
`REQUEST_CHANNELS` between them; the preload allowlist is a literal you can read in one screen
again, and authorisation happens in main's command registry, where a command nobody registered is
rejected.

### Things the framework will do to you

Each of these was verified by running cordis 4.0.0-rc.10, and each is silent when you get it wrong.

**`inject` is mandatory, and omitting it does not throw where you would look.** Reading
`ctx.commands` without declaring `inject: ['commands']` throws *"cannot get property "commands"
without inject"* — but a half whose injection cannot be satisfied never even runs: its fiber sits
in `PENDING` forever, `await ctx.plugin(...)` resolves **successfully**, and the symptom surfaces
minutes later as `unknown plugin command`. Both hosts assert the fiber reached `ACTIVE` so that
turns back into an error naming the plugin.

**`apply` must have a braced body.** cordis reads a plugin's return value as an effect and throws
`TypeError: Invalid effect` for anything that is not void, a function or an (async)iterable. So
`apply: (ctx) => ctx.contributions.editor(...)` — the shape a linter will suggest — fails at load.

**Errors inside `apply` print nothing by default.** cordis's default log exporter fills an
in-memory ring buffer. Both hosts register a `console.error` exporter at construction; without it a
plugin that throws on load simply does not appear, with no message anywhere.

**Never put a cordis service call on a render or per-event path, and bind it properly when you
take it off one.** Measured per call on this install:

| form | cost |
|---|---|
| `ctx.svc.method(…)` | 17,700 ns — rebuilds a shadow context on every property read |
| `const s = ctx.svc; s.method(…)` | 4,460 ns — still proxied per call |
| `const m = ctx.svc.method` | **throws** `Cannot read properties of undefined (reading 'ctx')` |
| `const m = s.method.bind(s)` | 219 ns |

The third row is the trap: cordis substitutes the shadow context only when the receiver is the
proxy itself, so a detached method reference has no `this` at all — and it fails at the first call,
not at capture. Bind at activation. This is also why the renderer keeps its component registry in
plain Maps (`src/renderer/src/plugins/bindings.ts`) and the shell never touches cordis while
rendering.

**Service methods must be prototype methods, never arrow-function fields.** `this.ctx` means "the
calling plugin's context" only because cordis swaps `thisArg` when the method is read; an arrow
closes over `this` at construction and would silently see the root's context, so `ctx.pluginId`
would be undefined for every caller.

**`root.fiber.dispose()` is a restart, not a teardown.** On the root fiber cordis maps dispose to
`restart()`: it unloads every plugin and every service and then brings the root back up, leaving
`root.commands` undefined and the host looking alive. Dispose the per-plugin fibers instead, which
is what `PluginHost.dispose()` does.

**An absent property on a Context throws rather than returning undefined.** It is a Proxy. Both
hosts install `ctx.accessor('pluginId', { get: () => undefined })` so the `no pluginId` guards in
the services are reachable code rather than decoration.

### The startup budget

`pnpm perf:check` runs against a real build and fails if:

- `index.html` gains a second `<link rel="modulepreload">`
- the entry chunk grows past its budget (276 kB measured before the plugin system)
- Monaco, pdf.js, xterm or cordis appear **in** the entry chunk, or stop having a chunk of their own
- pdf.js's runtime assets are missing from `out/renderer/pdfjs/`

The first three exist because a plugin system makes one specific regression trivially easy: a
single static import from the shell into a plugin pulls that plugin's whole chunk into the entry's
static graph, and nothing warns. It is the same failure that listing `monaco-editor` in
`manualChunks` once produced — dom-ready went from 0.83 s to 14.6 s.

### pdf.js, and two traps that only fire in the packaged app

**The worker must be `workerSrc`, pointing at a copied asset — not `workerPort`, and not Vite's
`?worker`.** With a port, `PDFWorker.create` caches one worker per port in a WeakMap: two open PDF
tabs share it, closing the first breaks the second, and because `#webWorker` is null in that path
`destroy()` never calls `terminate()` — one leaked 1.2 MB worker per document. With `workerSrc`,
pdf.js creates a dedicated worker per document and tears it down with the loading task.

**The runtime assets do not ship by themselves.** `pdfjs-dist` is a devDependency (promoting it
would drag 35 MB, plus 243 MB of `@napi-rs/canvas` prebuilds it never uses, into the production
closure), so `node_modules` is gone at runtime and `electron-builder` packs `out/**` and nothing
else. A small Vite plugin in `electron.vite.config.ts` copies the worker, `cmaps/`,
`standard_fonts/`, `iccs/` and the three `wasm` files the worker actually asks for into
`out/renderer/pdfjs/`, and serves the same URLs in dev. **`cMapUrl` is what makes Chinese PDFs
work**: any CIDFont using a predefined Adobe CMap renders blank or garbled without it, and the only
symptom is a `warn()` inside the worker.

Also: pass `useWorkerFetch: true` explicitly. pdf.js infers it with `/https?:/.test(protocol)`,
which is true in dev and false under a packaged `file://` renderer — two different code paths — and
`false` additionally hard-disables ICC colour management.

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

**`ELECTRON_RUN_AS_NODE` turns the app into a Node REPL.** Electron reads it before a line of our
code runs: with it set, the app binary *is* a Node interpreter, and given no script it drops into
a REPL. So `pnpm install:local` fails at "verify it boots" with

```
the packaged app never produced a smoke report:
Welcome to Node.js v24.21.0.
```

which looks like a broken build and is not. It leaks easily — anything that shells out to Electron
as Node can leave it in the environment, and it then survives for the life of that shell.
`install-local.sh` unsets it and says so, and the `smoke:*` scripts run under `env -u`. `dev` and
`preview` deliberately do not, because `env -u` is POSIX-only and those two still have to work on
Windows.

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
