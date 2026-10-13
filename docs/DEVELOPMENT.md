# Developing Rigee

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
| `pnpm search:selftest` | the workspace search engines — ripgrep, git grep, the plain walk — agreeing on a fixture, Chinese columns included |
| `pnpm panes:selftest` | 476 checks on the split tree, the editor groups and their layout, key chords, the shortcut table, the tab strip, the rules for naming workspace files, adding a folder to one without disturbing the rest of it, the Range headers a video element sends, the arithmetic of workspace heat, and when a terminal is at work |
| `pnpm perf:check` | asserts the startup budget against a real build (see Plugins) |
| `pnpm smoke:plugins` | asserts the plugin boundary: the text editor loads, pdf.js does not; an image opens fitted and zooms |
| `pnpm smoke:video` | records a film in the renderer, plays it from its `rigee-media://` URL, asserts 206 / 416 / 200 for ranges, resuming after a tab switch and in a split copy, the URL dying with the tab, and failures in words. `RIGEE_SMOKE_VIDEO_DIR` also surveys a folder of videos and reports which play; `RIGEE_SHOT` leaves a PNG |
| `pnpm smoke:markdown` | right-clicks a README in the explorer, opens its preview from the menu, and asserts what was drawn — GitHub's anchors, a table, a task list, an alert, front matter, code coloured without losing a tab — and what was not: no script ran, no style, no borrowed class, no bare id. Then pictures: one on disk shown, one on the web fetched only when asked (counted by a server it runs itself), one on another machine's share and one that is a symlink to /dev/zero refused, one written after the document shown at its next change. Links followed without the window navigating; closing a file's unsaved text tab with its preview open still asks; a thousand-column table and a link used 20,000 times stopped before they reach the page; and the file changing, the reader's place kept through redraws and tab switches, and its whole folder deleted and put back. `RIGEE_SHOT` leaves a PNG |
| `pnpm smoke:pdf` | renders a PDF and counts its pixels, then splits the row and puts a terminal beside it |
| `pnpm smoke:split` | opens a terminal, splits it twice, asserts three distinct ptys and that a split starts where its pane had `cd`'d to |
| `pnpm smoke:tabs` | the tab strip's menu on every kind of tab, a sweep that asks before stopping a running program, and the split buttons: copy a file and move a terminal, beside and below, nest a row in a column, and drag the divider across it |
| `pnpm smoke:persist` | builds tabs, splits, a two-group row and a group stacked under one, then reads back what reached disk |
| `pnpm smoke:migrate` | boots against a hand-built v2 document and asserts the upgrade kept everything |
| `pnpm smoke:terminal` | opens a terminal tab, types into it, waits for the shell to echo |
| `pnpm smoke:keys` | real keystrokes through the input pipeline: Shift+Enter's bytes, one paste, no leaked keys, splits, tabs, find |
| `pnpm smoke:editing` | workspace search, opening a result, saving, the unsaved-changes prompts, a file changed on disk, in-file find |
| `pnpm smoke:shutdown` | quits for real, and asserts plugin teardown finished before the app went |
| `pnpm smoke:diskplugin` | installs `examples/hello-plugin`, refuses it, approves it, loads it, tampers with it |
| `pnpm smoke:workspacefiles` | sets the workspace files folder in Settings, saves a workspace by name into it, and checks main refuses what it must; then where terminals start, saved and not, the question an unsaved workspace's terminal asks — Not Now, Save, Don't remind me again — a workspace's right-click menu adding a folder to its file with the comments intact, a folder's Open in Terminal Tab and Split, the explorer showing files created and deleted from outside, with Refresh for what the watcher ignores, and a saved workspace's tree headed by the folder its file is in — once, even when the file lists it, and saying so when it has gone |
| `pnpm smoke:heat` | boots on workspaces from before heat and asserts none comes up cold; then the list ordered and coloured by heat, held still under the pointer and re-sorted once it leaves, a switch and a minute of typing each counted once, a terminal printing in a workspace nobody is looking at counted and a prompt not, the cold ones removed through their checklist, and what reached the disk. `RIGEE_SHOT_DIR` leaves PNGs of the list, its cold run and the checklist |
| `pnpm smoke:fileops` | the explorer's file operations: the menus of a file, a folder and a workspace folder; a click opening a file and leaving the keyboard in the tree; Rename, New File and New Folder in a name box that refuses a taken name; Copy and Paste making `a copy.ts`; Cut and Paste and a drag moving, with tabs following; unsaved files refused a move; Delete asking first and closing the deleted file's tab; Copy Path; the arrows; and files from outside copied in, through the command a drop sends. Nothing reaches the real Trash unless `RIGEE_SMOKE_TRASH=1`. `RIGEE_SHOT_DIR` leaves PNGs of the name box, a cut row, a drop target and a selection |
| `pnpm smoke:running` | an agent and a build at work in a workspace nobody is looking at, counted on its row; both counted as finished unseen once they stop, the agent alive and silent and the build gone; the count followed to its terminal, a tab's dot and a split pane's outline cleared by looking; and neither somebody typing nor a quick command counted. Real programs under a real shell with job control. `RIGEE_SHOT_DIR` leaves PNGs of the counts and of a finished pane |
| `pnpm pack:check` | package, then boot the packaged app and assert it actually starts |
| `pnpm install:local` | build, package and install into /Applications, verified through `open` |
| `pnpm pack:mac` / `pack:win` / `pack:linux` / `pack:all` | installers into `release/<version>/` |

### Fixtures for the smoke modes

Three modes need a directory to point at, and two of them fail confusingly if you pick the wrong
one:

```bash
RIGEE_SMOKE_MULTIREPO=/private/tmp/repos pnpm smoke:multirepo   # a directory OF git repos
RIGEE_SMOKE_MULTIREPO=/private/tmp/repos pnpm smoke:explorer    # two or more folders
RIGEE_SMOKE_REPO=/private/tmp/bigrepo    pnpm smoke:scroll      # one repo, see below
```

**Use `/private/tmp`, not `/tmp`.** On macOS `/tmp` is a symlink, so `git rev-parse
--show-toplevel` answers with the resolved path while the workspace holds the one you passed. The
source control panel keys statuses by repository root, the two never match, and the panel sits on
"reading alpha…" for ever — which reads exactly like source control being broken.

**`smoke:scroll` needs a repository big enough to overflow both panels**: dozens of dirty files and
dozens of top-level entries. Against a tidy repo it fails with `explorer-fixture-too-small`, which
is the check refusing to pass vacuously rather than a regression.

`smoke:migrate` needs no fixture directory: it writes its own v2 `workspaces.json` into the
throwaway userData directory during module evaluation, which is the only moment early enough —
`loadState()` caches for the life of the process, so a document planted after boot is never read.

### Smoke runs that stay out of your way

`smoke:keys` and `smoke:editing` never show their window or take the foreground. The editing mode
answers the unsaved-changes prompts through `RIGEE_SMOKE_UNSAVED_ANSWER` instead of putting a dialog
on screen. `smoke:keys` also runs its panes on a sink
(`cat >/dev/null`) instead of your shell: it presses Enter, and in a real shell every one of those
keystrokes would be a command in your history. It does write to the clipboard — saved and put back
— so do not copy anything while it runs.

Any other mode can be kept off screen the same way:

```bash
RIGEE_SMOKE_HIDDEN=1 SHELL=/bin/sh HISTFILE=/dev/null pnpm smoke:split
```

Keystrokes in `smoke:keys` go through `webContents.sendInputEvent` — keyDown, char, keyUp — which is
the real input pipeline, keypress included; the other modes dispatch DOM events, which cannot show
a key that was swallowed and then typed itself anyway. Neither can reach Electron's menu, which
acts only on real OS key events; that is why the keys smoke asserts every consumed keydown was
cancelled, which is what keeps the menu from acting on it too.

### Screenshots

```bash
env -u ELECTRON_RUN_AS_NODE RIGEE_SMOKE=shot RIGEE_SHOT=/tmp/a.png electron .
```

Three environment variables change what is in the frame, and they compose:

| variable | what it does before the capture |
|---|---|
| `RIGEE_SHOT_VIEW` | clicks that activity bar item, by title — `Explorer`, `Plugins`, … |
| `RIGEE_SHOT_COLLAPSED` | shuts both side panels |
| `RIGEE_SHOT_SPLIT` | splits the centre into two groups, with a terminal in the new one; `down` stacks them |

`RIGEE_SHOT` also works with `smoke:pdf`, which leaves a PNG of the viewer it just asserted on.

## Layout

```
src/
  shared/      the domain model and the IPC contract; imported by all three targets
  main/        Electron main — the shell only
    pty/       pseudo-terminals, one per split pane
    plugins/   the main-side plugin host: cordis root, command registry, shell service
    store.ts   atomic JSON persistence
  preload/     the contextBridge surface (compiled to CJS — see below)
  renderer/    React shell — window, workspaces, the activity bar, tabs, terminals
    plugins/   the renderer-side host, the manifest registry and the component bindings
plugins/       the features, one folder each — OUTSIDE src/, see below
  text-editor/   Monaco, and the editor of last resort for every file
  explorer/      the file tree, and a watcher that keeps it current
  pdf/           the PDF reader
  image/         the image viewer
  video/         the video player, streaming through the shell's media scheme
  markdown/      the Markdown preview, offered in a file's menu and kept current as the file changes
  scm/           git: status, staging by line, commits, diffs
  search/        find in every file of the workspace
  browser/       Chromium tabs as native WebContentsViews
  shared/        what more than one plugin needs (the Monaco loader). Not a plugin.
packages/
  plugin-api/    the published contract a plugin is written against. Nothing app-specific.
examples/
  hello-plugin/  a worked third-party plugin, hand-written ESM, no build step
scripts/       self-tests, the startup budget check and the local installer
```

`plugins/` sits beside `src/` rather than inside it, and that is a statement of intent: a plugin is
not part of the application's source, it is something the application loads. The ones here are
bundled because they ship with the app, but they are written against the same contract a plugin
from somebody else's repository would be, and the directory boundary is what keeps "reaches into
the shell" from being the path of least resistance.

Three tsconfig projects, because the three targets genuinely differ: `tsconfig.node.json` (main,
no DOM), `tsconfig.preload.json` (DOM **and** Node — the preload straddles both), and
`tsconfig.web.json` (renderer, no Node). Plugins straddle two of them by file name:
`plugins/*/main/**` belongs to the node project, `plugins/*/renderer/**` to the web
project, and `manifest.ts` / `protocol.ts` to both. That split is mandatory, not tidiness — see
the plugin section below.

## Plugins

The shell is a window, a workspace model, a tab framework, terminals, persistence and an IPC
spine. Everything else is a plugin: the text editor, the PDF reader, source control and the
browser all live in `plugins/<id>/` and reach the shell only through `@rigee/plugin-api`
(`packages/plugin-api/`). The framework underneath is
[cordis](https://github.com/cordiverse/cordis).

A plugin is up to two halves, because Electron leaves no choice — a PDF renders in the sandboxed
renderer and the bytes it renders can only be read in main:

```
plugins/pdf/
  manifest.ts          what exists: id, version, contributions. Plain data, read in both realms.
  protocol.ts          the command and event types the two halves share. Realm-free.
  main/index.ts        default-exports a cordis Plugin. Node only.
  renderer/index.tsx   default-exports a cordis Plugin. DOM only.
```

`plugins/index.ts` lists the manifests; `registry.main.ts` and `registry.renderer.ts` hold the
dynamic-import thunks, one file per realm. A plugin installed from disk supplies the same manifest
in its `package.json` and names its own entry files instead — see "Plugins that did not ship with
the app" below.

**Contribution points.** `editors` (a viewer for files matching a selector), `tabs` (a tab type the
plugin owns outright, with its own persisted state), `views` (a side-bar panel), `statusBar`, and
`overlays` (a dialog mounted at the shell root while the plugin is active). All declarative: the
shell can draw the tab strip, draw the activity bar, resolve which viewer opens a `.pdf` and decide
what goes in the right rail without loading a line of plugin code.

**An editor can be offered rather than chosen.** One that declares `onRequest` never opens a file
by claiming it — a Markdown file is source, and clicking one must go on opening the text editor —
and is listed instead by `editorsOnRequest(path)`, which is what the explorer puts in a file's
right-click menu; picking it is `openFile({ path, viewType })`. Its tab sits beside the file's own,
because editor tabs are told apart by path *and* view type, and its `tabPrefix` names it
(`Preview README.md`) so the two read apart.

The two view slots are arranged differently and the difference is deliberate. **`slot: 'left'` is
an activity bar** — one icon per view down the rail, one view showing, the selection remembered in
the layout — so the explorer and the plugins view take turns in the same panel. **`slot: 'right'`
stacks**, which is where source control lives, so the changes stay visible beside the file tree.
Moving source control into the rail is a one-word change to its manifest; it is on the right
because seeing both at once is the one thing this layout does better than VS Code's.

**Enabling and disabling.** The plugins view switches a plugin off for real: the renderer disposes
its fiber, which un-binds every component it contributed; main disposes its own, which stops its
watchers and destroys its native views; and the registry stops reporting its contributions, so its
icon leaves the rail and its file types stop resolving. The set is persisted in
`PersistedState.disabledPlugins` and read by main BEFORE the first `plugin:invoke`, so a disabled
plugin does not start even once. `pnpm smoke:plugins` drives the whole round trip, including that
`.pdf` falls back to the text editor while the PDF plugin is off.

**The one shell-owned view.** `shell.plugins` is declared by the shell rather than a plugin,
because it has to stay reachable when every plugin is off — including itself, if it were one. It
is bound through the ordinary binding table in `main.tsx`, so the activity bar, the view host and
the namespace rules treat it exactly as they treat a contributed view. `SHELL_OWNER` is the
reserved owner id, and `useActivation` skips it: there is nothing to load.

**Activation is lazy and demand-driven.** A renderer half loads when something it contributed is
first needed — a tab of its view type renders, its panel mounts, its "new tab" button is pressed. A
main half loads when the renderer first calls one of its commands. Opening a `.ts` file loads the
text editor and nothing else; `pnpm smoke:plugins` asserts exactly that, because it is the property
the whole design exists to produce.

**Questions go through `ctx.shell.ask`.** A main half that has to ask the user something — the
explorer before it deletes, or replaces a file of the same name — asks through the shell, never
Electron's `dialog` directly. The smoke modes answer it through `askProbe` in src/main/index.ts, as
`menus` answers context menus in the renderer; a question put on screen any other way leaves a run
waiting for a person to come and press a button.

**Two IPC channels, forever.** `plugin:invoke` carries every renderer→main call and `plugin:event`
carries every push. Source control and the browser used to own twenty-two entries in
`REQUEST_CHANNELS` between them; the preload allowlist is a literal you can read in one screen
again, and authorisation happens in main's command registry, where a command nobody registered is
rejected.

### Plugins that did not ship with the app

A plugin from somebody else's repository lives in `<userData>/plugins/<id>/` and is an ordinary npm
package — `package.json` with the manifest under a `rigee` key, plus the two built entries. There
is a worked example in `examples/hello-plugin/`, hand-written ESM with no build step, and
`pnpm smoke:diskplugin` installs it into a throwaway data directory and drives the whole path.

```
<userData>/plugins/hello/
  package.json        { "rigee": { "id": "hello", "apiVersion": 1, "main": …, "renderer": … } }
  dist/main.js        ESM, default-exports a cordis Plugin. Node.
  dist/renderer.js    ESM, default-exports a cordis Plugin. DOM.
```

**The bundled plugins do not go through any of this.** They are in the build's module graph, so
each gets its own chunk, the manifests cost a kilobyte, and a launch that opens nothing loads none
of them. Two sources, one registry; nothing downstream can tell which is which.

**`@rigee/plugin-api` is the whole contract.** `packages/plugin-api/` is a real, publishable
package, and the in-repo plugins import it exactly as an external one would — there is not a single
`@renderer/*` or `@shared/*` import left under `plugins/`. The package declares the SHAPE and holds
no implementation; `renderer/src/plugins/shellHost.tsx` installs the behaviour once, at boot, before
anything can activate.

**Three bare specifiers, resolved by an import map.** A plugin leaves `react`, `react/jsx-runtime`
and `@rigee/plugin-api` external and gets the shell's copies. This is not tidiness: two Reacts in
one window makes hooks throw the moment a plugin's component renders inside the shell's tree, and a
second copy of the API package has no host installed. The map is written into index.html by
`pluginRuntime()` in `electron.vite.config.ts`, which also hashes it into `script-src` — an import
map can only be inline, and the alternative to a hash is `'unsafe-inline'`.

Two traps in that mechanism, both already paid for:

- **The shims must not be Rollup entries.** As entries they shared modules with the shell's entry,
  Rollup re-cut the chunks, and index.html went from preloading one chunk to four — startup began
  fetching the plugin runtime for plugins that may not exist. They read `globalThis.
  __rigeePluginRuntime` instead, so they import nothing and cannot perturb the graph.
  `pnpm perf:check` asserts the preload count and is what caught it.
- **`export * from 'react'` does not work.** react is CommonJS; Rollup cannot enumerate a CJS
  module's exports for a star re-export and emits a module exporting nothing. The names are read
  off the installed package at build time instead, so they cannot drift.

**Nothing crosses the bridge that cannot be cloned.** `plugins:list` sends only DISK manifests. A
bundled manifest may carry a `match` predicate as its file selector — the text editor claims
everything with one — and contextBridge answers a function with *"An object could not be cloned"*,
which reaches the caller naming no cause at all. The renderer already has those manifests
statically and composes the two lists itself.

**The custom scheme needs four privileges**, and `corsEnabled` is the non-obvious one: the packaged
renderer is a `file://` document, so every other scheme is cross-origin and Chromium rejects the
import before the handler runs. See `pluginScheme` for what each one buys.

**There is a second scheme, `rigee-media`, and Electron allows ONE `registerSchemesAsPrivileged`
call.** A media element cannot be handed bytes the way the image viewer is — a film is too big to
read whole, and seeking needs Range requests — so `src/main/media.ts` streams files by URL, and a
plugin's main half asks for one with `ctx.shell.serveFile(path, mime)`. The scheme has to be
declared before app ready, long before any plugin loads, which is why it is the shell's. Three
things each fail silently when missed: both schemes go in the one call in `src/main/index.ts`, or
the second is never privileged; the media scheme needs `stream: true`, or playback waits for the
whole file and seeking does nothing; and index.html's CSP needs `media-src rigee-media:`, or
`default-src` refuses it and the player is simply blank. A URL names a random token rather than a
path and dies with `releaseFile` or the plugin that asked, so the scheme cannot be used to walk the
disk; and its handler lives in the default session, which a browser tab's page is not in.

#### Trust

A plugin found on disk is **inert**: listed, manifest read, nothing imported — not in main, not in
the renderer — until the user approves that exact build. The grant (`<userData>/plugin-trust.json`)
pins a SHA-256 of the whole directory and the declared permission set, so an update, a tampered
file, or a version that has grown an appetite all revoke it and ask again. `pnpm smoke:diskplugin`
appends one byte to the example and asserts trust flips to `changed` and the renderer half stops
being servable.

**Be precise about what the permissions do, because it is not what the word suggests.** Nothing
enforces them at the call site, and nothing can in this architecture: a main half is an ES module
in the main process and imports `node:fs` itself, and a renderer half runs in the shell's own
JavaScript context and can reach `window.rigee` directly. What is enforced is *change detection* —
a plugin that asked only to read files and comes back wanting to run programs does not load until
the user has been asked again. The install prompt says so in those words and does not imply a
sandbox, because a user who believes in a boundary approves things they would otherwise read.

Real isolation means a separate context per plugin — a worker for the logic, a locked-down frame
for the UI, every contribution point becoming a message. That is a much larger change and is not
pretended at anywhere in this code.

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
plain Maps (`src/renderer/plugins/bindings.ts`) and the shell never touches cordis while
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

### Editor groups

The centre of the window is a set of groups, each with its own tab strip, its own tab list and its
own active tab — so a PDF can sit beside a terminal, or above it. The arithmetic is pure and lives
in `src/renderer/src/groups.ts`; the store holds one `GroupRow` per workspace (`rowsByWorkspace`,
still named for the row it was before groups could be stacked), and it persists as `groups` +
`groupLayout` + `groupSizes` + `activeGroupId`.

Two halves. `groups` is a flat list of the groups and their tabs, in reading order; `layout` is a
tree shaped like a terminal tab's split tree, with groups for leaves, and says only where each one
is drawn. Most of the shell wants the tabs and reads the list without ever walking the tree; only
splitting, closing a group and dragging a divider touch the layout. A split joins the split around
the group when that runs the same way — three across is one row of three — and closing a group
collapses any split left with one child and merges a row left inside a row, so the tree never
grows wrapper nodes. `groupSizes` is still written, as each group's share of the width, so that a
build from before stacking opens a newer document as a row; a document without `groupLayout` is
the row its `groupSizes` describe, which is why the field arrived without a version bump.

Three rules a plugin author has to know:

- **De-duplication is per group.** The same file open in two columns is the entire feature, so
  `openTab` only re-activates an equal tab within the group it is opening into. A plugin tab's
  `key` is what "equal" means, and a copy inherits it.
- **Some tabs copy, some move.** The split buttons — right and down — duplicate anything that can
  exist twice and MOVE anything whose renderer-side resources are keyed by tab id — a terminal's
  ptys, a browser tab's native view. A file always copies; a plugin's own tab type says which with
  `split: 'copy'` in its `tabs` contribution, and the default is `'move'` because a plugin that has
  not said it survives being in two places probably does not. Each button's title tells the user
  which it will be, so the gesture never lies about moving your terminal away.
- **A copy gets a NEW tab id**, because those same module-level maps are keyed by it. If the view
  keeps per-tab state worth carrying over — the PDF reader's page and zoom — call the shell API's
  `duplicatedFrom(tabId)` on first mount. It answers once, for a tab that really was split from
  another, so it belongs in a `useState` initialiser rather than in an effect body.

Emptying a group removes it and gives its space back, except for the last one, which stays to hold
the "Nothing open" state. A split deeper than the outermost one re-creates the group it wraps —
React cannot move a component to a new parent — which every pane survives, because switching tabs
does the same; the outermost split is drawn even around a lone group, so the first split either way
re-creates nothing. `pnpm panes:selftest` covers the arithmetic, `pnpm smoke:tabs` covers both
buttons and a real drag of the divider across a column, `pnpm smoke:persist` what reaches the disk,
and `pnpm smoke:pdf` covers the whole point of it: a PDF still rendering, with ink, beside a
terminal that got its own pty.

### Workspace heat

The side bar orders and colours the workspace list by how much each has been used lately. Three
files: `heat.ts` is the arithmetic and is pure, so `panes:selftest` holds it to its numbers;
`activity.ts` notices use and output; the side bar draws the result.

- **What is stored is raw, and where.** Minutes per day — `used` and `output` — a few weeks of
  them, in `WorkspaceUiState.activity`, never a score: weighing them differently later is a change
  to arithmetic, not to a document on disk. Not on `Workspace`, because `Workspace` is a type in
  `@rigee/plugin-api` and the shell's bookkeeping is nobody's contract; and the UI map is written
  whole by `saveAllUi`, so a workspace's record is pruned with the workspace.
- **Counted once a minute, which is what makes it cheap.** The output hook sits on every frame of
  every terminal and the input hook on every keystroke; each costs a clock read and a map lookup,
  and the store is written once a minute per workspace at most. Output must reach
  `OUTPUT_MINUTE_CHARS` in a minute to count, so a restored terminal drawing its prompt does not
  warm the workspace it is in.
- **Age is days of use, not calendar days.** A day counts if the user did something in some
  workspace that day; output alone does not make one, or a program left printing over a holiday
  would age everything else. Do not "simplify" this to wall-clock decay: the list would come back
  from two weeks away with every workspace cold.
- **Cold goes by recency, heat by score.** Cold is ten days of use with nothing at all in a
  workspace, however busy it once was — the one thing the side bar offers to remove, so its reason
  has to be one anybody can check. A workspace with no record is cool, never cold, which is how the
  ones that predate heat survive the upgrade.
- **The list scrolls.** It is capped at 220 px, so the cold run is usually below its fold. That is
  why *N cold* is in the header, and why `smoke:heat` scrolls a row into view before clicking it —
  a point below the fold is on the explorer, and a click there switches nothing.

### Terminals at work

The workspace list counts each workspace's terminals at work and those finished since the user
last looked; the tab strip and the pane mark the same. `paneWork.ts` is the pure part — when
printing is work and when it has stopped — and `paneWatch.ts` feeds it and writes the result.

- **Work is printing, not a process.** An agent's process outlives its work: it sits waiting for an
  answer with nothing on screen changing. Counting processes would call every workspace with
  Claude Code open busy for good, and its "finished" — the moment the user needs — would never
  come. A pane is working once it has printed for `WORK_MIN_MS` without a pause of `QUIET_MS`, and
  finished once such a pause follows. Output within `ECHO_MS` of a keystroke in that pane is the
  keystroke's echo and is left out, or typing to an agent would make it look busy.
- **Main is asked once, not polled.** When a pane first prints like work, `terminal:running` says
  whether a program is in front of its shell (on macOS that is a `ps`); a shell printing for itself
  is asked about again `RECHECK_MS` later. Nothing is asked on a timer, and the renderer's clock
  runs only while some pane is printing or at work, so idle shells cost nothing.
- **The store gets transitions only.** Output is noted per frame in module maps; `workingPanes` and
  `unseenPanes` change when a pane starts, stops, is looked at, or exits — a handful of writes a
  minute — which is what keeps it within the store's rule about high-churn state.
- **Seen means the keyboard went in.** A pane is marked unseen when it finishes unless it has the
  keyboard and the window is in front; it is cleared when its xterm takes focus, which a click, a
  tab shown, a count followed and the window coming back all produce. The focused terminal is held
  as the handle, not its pane id: a new pane takes the keyboard before its shell has an id.

## Things that will bite you

Each of these cost real debugging time. They are commented at the site too; this is the index.

**The app was called onestop, and `src/main/index.ts` still says so once.** Electron derives
`userData` from the app's name, so the rename moved it from `<appData>/onestop` to
`<appData>/rigee` — and every workspace, every restored tab, the key bindings, the disabled-plugin
set and every site signed into in a browser tab went quiet at the same moment. Nothing was deleted,
which somehow makes it worse: the data is right there and the app cannot see it.
`adoptLegacyUserData()` copies the two things worth keeping — `workspaces.json` and `Partitions/` —
on first launch, guarded on our own document not existing yet, and renames the partition directory
because Chromium looks that storage up by the partition string (`persist:rigee-browser`), so
copying the cookies without renaming the folder would sign everybody out anyway. The old directory
is left alone: an upgrade that deletes the previous version's data has no way back. That literal
`onestop` is load-bearing; it is not a rename that was missed.

**Quitting must WAIT for plugin teardown, not just start it.** `before-quit` is synchronous and
teardown is not, so it used to fire `pluginHost.dispose()` and let the process leave. Source
control's filesystem watchers are native: `@parcel/watcher`'s `unsubscribe()` finishes through a
napi async callback, and when that callback lands after Node has begun tearing the environment
down there is nowhere to deliver it — `PromiseRunner::onWorkComplete` calls `napi_fatal_error` and
the process aborts. What the user sees is a **SIGABRT crash report for an app that quit normally**,
minutes after the window closed, with `watcher.node` at the top of the stack. The handler now
cancels the quit once, awaits disposal (capped at 2 s so a wedged unsubscribe cannot turn "quit"
into "hang"), and re-issues it. The chain only works because every link returns its promise:
`ScmWatchers.unwatch` awaits the unsubscribes, `GitService.dispose` awaits the watchers, the scm
plugin's effect *returns* `() => git.dispose()` rather than voiding it, and cordis awaits a
disposer that hands back a promise.

`pnpm smoke:shutdown` guards it. Note what it does and does not do: it does **not** reproduce the
abort — that race is a few milliseconds wide and a one-repo quit exits 0 with or without the fix,
verified by patching the built main back to the old handler. It asserts the invariant instead
(teardown is finished by `will-quit`), and it slows teardown to 800 ms so the answer stops
depending on whether Electron's window-closing happens to outrun `dispose()` on the machine
running the test. Without that delay the old code passed too.

**The preload must compile to CJS.** `package.json` sets `"type": "module"`, so electron-vite
would emit an ESM preload, and an ESM preload under `sandbox: true` fails with *"Cannot use import
statement outside a module"* — `window.rigee` then silently never appears and the renderer dies
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

**A `SHELL` that ignores `-c` hangs startup for good.** The PATH recovery runs `$SHELL -ilc …`
before the renderer can finish booting, and waits for it. A wrapper script that always `exec`s an
interactive shell — the obvious way to give a smoke mode a clean one — leaves that shell reading the
probe's stdin, and an interactive shell ignores the SIGTERM the probe's timeout sends, so
`app:getPlatformInfo` never answers and the store is never ready. `smoke:running`'s `shell.sh` runs
the command when it is given `-c` and goes.

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
`callback` to the `authInfo` object and you get *"cb is not a function"*. Rigee registers once on
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
`rigee.app/Contents/MacOS/rigee` directly works perfectly in each case, which is exactly why
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
