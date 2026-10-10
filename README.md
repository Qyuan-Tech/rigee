# Rigee

One window for the whole loop: terminals, code, diffs and the web.

If you write code mostly by directing AI agents, your attention is probably split across a
terminal multiplexer, an editor you use to read diffs, and a browser full of docs. Rigee puts
those three in one window without pretending any of them is something it isn't — the editor is
the real VS Code editor, the browser is real Chromium, and the terminal is a real pseudo-terminal
running your own shell.

> **Status: early but usable.** Terminals with splits, the editor, browser tabs and source
> control — including staging individual lines — all work. See
> [What works today](#what-works-today).

## What it looks like

```
┌────────────────┬──────────────────────────────────────────┬──────────────────┐
│  WORKSPACES    │  ❯ terminal   ◧ App.tsx   ◎ docs    + ❯ ◎│  SOURCE CONTROL  │
│  ▸ rigee     │ ─────────────────────────────────────────│                  │
│  ▸ api         │                                          │  Message…        │
│  ▸ infra       │                                          │                  │
│                │                                          │  STAGED      2   │
│  EXPLORER      │        terminal / Monaco editor          │   index.ts    M  │
│  ▾ src         │              / Chromium                  │   util.ts     A  │
│    ▾ main      │                                          │                  │
│      index.ts  │                                          │  CHANGES     1   │
│    ▾ renderer  │                                          │   App.tsx     M  │
│      App.tsx   │                                          │                  │
└────────────────┴──────────────────────────────────────────┴──────────────────┘
```

- **Left** — workspaces and a file tree. A workspace is a named set of folders, like a VS Code
  multi-root workspace. Choose a workspace files folder in Settings and *Save Workspace As…* asks
  only for a name, filing it as `<folder>/<name>/<name>.code-workspace`. Right-click a workspace to
  add a folder to it or save it; a folder added to a saved workspace is written into its file too.
- **Centre** — tabs. A tab is a terminal (splittable), a file in Monaco, an image, a diff, or a
  Chromium page. Mix them freely and drag to reorder; right-click any of them for Close, Close
  Others, Close to the Right and Close All.
- **Right** — source control, aware of every git repo in the workspace at once.

## Install

Download the build for your platform from the
[latest release](https://github.com/Jason-Chang_citrix/rigee/releases/latest).

| Platform | File | Notes |
|---|---|---|
| macOS (Apple Silicon) | `rigee-<version>-arm64.dmg` | |
| macOS (Intel) | `rigee-<version>-x64.dmg` | |
| Windows | `rigee-<version>-x64-setup.exe` | Installs per-user, no admin prompt |
| Linux | `rigee-<version>-x86_64.AppImage` | `chmod +x` then run |
| Linux (Debian/Ubuntu) | `rigee_<version>_amd64.deb` | `sudo dpkg -i …` |

Builds are currently **unsigned**, so every OS will object the first time:

- **macOS** — right-click the app and choose *Open*, or
  `xattr -dr com.apple.quarantine /Applications/rigee.app`.
  Do **not** try to "fix" it with `codesign --deep`; see the note in
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
- **Windows** — SmartScreen shows "Windows protected your PC"; choose *More info → Run anyway*.
- **Linux** — nothing to bypass.

### Requirements

None. Terminals run your login shell directly — `$SHELL` on macOS and Linux, PowerShell on
Windows — so there is nothing to install and no WSL requirement. The status bar shows which shell
is in use.

Rigee recovers your real `PATH` at startup, so Homebrew, nvm, asdf and friends work even though
an app launched from Finder inherits almost none of it.

## What works today

| Area | State |
|---|---|
| Workspaces — multiple folders, persisted across restarts | works |
| File explorer — lazy-loaded tree, kept current as files are created and deleted, and a Refresh button | works |
| Editor — Monaco, syntax highlighting, view state kept per tab | works |
| Saving — Cmd/Ctrl+S, a dot on unsaved tabs, asked before closing or quitting over them | works |
| Find and replace in a file — Cmd+F, Cmd+Option+F (Ctrl+F, Ctrl+H) | works |
| Search the workspace — every file, case / whole word / regex, click a result to jump to it | works |
| Browser tabs — navigation, persistent logins, DevTools, `target=_blank` opens a tab | works |
| Terminals — one pseudo-terminal per pane, running your login shell | works |
| Split panes — Cmd+D beside, Shift+Cmd+D below (Ctrl+Shift+O / E elsewhere), draggable dividers | works |
| A split opens in the directory its pane had `cd`'d into (macOS and Linux) | works |
| Tab menu — Close, Close Others, Close to the Right, Close All, on every kind of tab | works |
| Keyboard shortcuts — Ghostty's defaults, every one rebindable, Ghostty config lines accepted | works |
| Scratch workspace — terminals without setting anything up | works |
| Source control — status, diff, stage, unstage, discard, commit, amend | works |
| Staging individual hunks and lines, and discarding them | works |
| Live refresh — the panel updates when git runs in your own terminal | works |
| HTTP auth prompt in browser tabs | works |
| Restoring tabs, splits and browser pages on next launch | works |
| PDF reader — continuous scrolling, text selection and search, outline, thumbnails | works |
| Image viewer — PNG, JPEG, GIF, WebP, AVIF, BMP, ICO; fit, zoom, pan | works |
| Video player — MP4, MOV, M4V, WebM, MKV, Ogg (H.264, HEVC, AV1, VP8, VP9); streamed from disk, so a long film starts at once and seeks anywhere | works |
| Workspace files folder — set once in Settings, then Save Workspace As… asks only for a name | works |
| Right-click a workspace — Add Folder to Workspace, Save Workspace As, Remove | works |
| A folder added to a saved workspace goes into its `.code-workspace` file, comments and settings kept | works |
| A saved workspace's terminals start in the folder its `.code-workspace` file is in | works |
| A terminal opened in an unsaved workspace offers to save it first — or not now, or never again | works |
| Right-click a folder in the explorer — Open in Terminal Tab, or Open in Terminal Split beside the terminal on screen | works |
| Plugins — the editor, explorer, PDF, images, source control and the browser are all plugins | works |
| Activity bar — icons down the left edge switch the side panel, VS Code style | works |
| Plugins view — what is installed, what it contributes, and a switch to turn it off | works |
| Terminals surviving a restart | **no** — the layout returns, the running processes do not |

## Plugins

Rigee's core is a shell: a window, workspaces, a tab framework, terminals and persistence. The
features are plugins, and they are not a second-class extension mechanism bolted on afterwards —
the text editor, the PDF reader, the image viewer, the video player, source control and the browser
are each a folder under `plugins/`, loaded on demand through two IPC channels and a declarative manifest.

That means the app you start has none of them running. Open a `.ts` file and the text editor loads;
open a `.pdf` and 437 kB of pdf.js arrives for the first time; never open one and it costs nothing.
`pnpm perf:check` fails the build if that stops being true.

The activity bar down the left edge is built from manifests alone, so the icons are there before
any plugin has loaded and pressing one is what fetches it. The plugins view behind the puzzle icon
lists what is installed, what each plugin contributes and whether it is running, and can switch one
off — which really does stop it: the panel disappears, its file types stop resolving, its git
watchers die, and the choice survives a restart.

The framework is [cordis](https://github.com/cordiverse/cordis): a plugin gets a Context, and
everything it registers through that Context — commands, components, listeners, watchers, native
views — is revoked when the plugin is disposed.

**Plugins do not have to ship with Rigee.** The contract is a published package,
[`@rigee/plugin-api`](packages/plugin-api), and the ones in this repository import it exactly as an
external plugin would — there is no back door into the shell for the built-in ones. Drop an npm
package into `<userData>/plugins/<id>/` and it appears in the plugins view, **inert**: nothing of it
is imported until you have approved that exact build. Approval is pinned to a hash of its contents,
so an update has to be approved again.

Be clear about what that does and does not buy. It is not a sandbox — a plugin runs with Rigee's own
access to your files, your terminals and the network, and the permission list in its manifest is
what its author says it needs, not something Rigee enforces. What is enforced is that unapproved
code does not run at all, and that code which changes has to be looked at again.

`examples/hello-plugin/` is a complete one in 80 lines. See `docs/DEVELOPMENT.md` for the
contribution points and the traps.

## Terminals

Each pane is its own pseudo-terminal running your login shell, and each terminal tab holds a tree
of panes you can split and resize. A new split starts in the directory the pane it came from is in
now — wherever you `cd`'d to — rather than back at the workspace's first folder. (On Windows, where
a shell's directory cannot be read from outside, it starts where that pane started.)

A new terminal tab starts in the workspace's own folder: the one its `.code-workspace` file is in,
once the workspace has been saved, and its first folder until then. That folder belongs to the
workspace rather than to any one of its repos, which makes it the place to start an agent that is
meant to see all of them. So a terminal opened in a workspace that has never been saved asks first,
before its shell starts — save it there and then, by name if Settings has a workspace files folder,
or *Not Now* to start in the first folder as before. It asks again with the next terminal;
*Don't remind me again* stops it, and Settings → General turns it back on.

Right-click any folder in the explorer — a repo at the top of the tree or anything inside it — for
*Open in Terminal Tab*, a new tab whose shell starts there, or *Open in Terminal Split*, a new pane
beside the active one in the terminal on screen (a new tab when no terminal is showing). Either way
the folder you picked wins, and nothing asks about saving the workspace.

Closing several tabs at once — Close Others, Close to the Right, Close All — asks first if it would
stop a program still running in a terminal it sweeps up. A shell sitting at its prompt closes
without a word.

They do not outlive the app: quitting Rigee ends the shells and whatever they were running. If
you need something to survive that, start it under a multiplexer inside a pane — typing `tmux` or
`screen` works exactly as it would in any other terminal.

### Keyboard shortcuts

The shortcuts are [Ghostty](https://ghostty.org)'s defaults, so the same keys do the same things in
both. Every one can be changed in Settings — the gear in the title bar, or `Cmd`+`,` — by pressing
the new key, or by pasting `keybind = …` lines straight out of a Ghostty config. Right-click a pane
to see the current ones.

| | macOS | Windows / Linux |
|---|---|---|
| Newline without submitting (Claude Code, zsh) | `Shift`+`Enter` | `Shift`+`Enter` |
| Copy / paste | `Cmd`+`C` / `Cmd`+`V` | `Ctrl`+`Shift`+`C` / `Ctrl`+`Shift`+`V` |
| Paste the last selection | `Shift`+`Cmd`+`V` | `Shift`+`Insert` (the clipboard, on Windows) |
| Split right / down | `Cmd`+`D` / `Shift`+`Cmd`+`D` | `Ctrl`+`Shift`+`O` / `Ctrl`+`Shift`+`E` |
| Previous / next pane | `Cmd`+`[` / `Cmd`+`]` | `Ctrl`+`Super`+`[` / `]` |
| Pane in a direction | `Cmd`+`Option`+arrow | `Ctrl`+`Alt`+arrow |
| Move a divider / even them out | `Cmd`+`Ctrl`+arrow / `Cmd`+`Ctrl`+`=` | `Ctrl`+`Shift`+`Super`+arrow |
| Zoom a pane | `Shift`+`Cmd`+`Enter` | `Ctrl`+`Shift`+`Enter` |
| Close the pane, then the tab | `Cmd`+`W` | — |
| New terminal tab / close tab | `Cmd`+`T` / `Cmd`+`Option`+`W` | `Ctrl`+`Shift`+`T` / `Ctrl`+`Shift`+`W` |
| Go to tab 1–8, the last tab | `Cmd`+`1`…`8`, `Cmd`+`9` | `Alt`+`1`…`8`, `Alt`+`9` |
| Previous / next tab | `Shift`+`Cmd`+`[` / `]`, `Ctrl`+`Tab` | `Ctrl`+`Page Up` / `Down`, `Ctrl`+`Tab` |
| Bigger / smaller / reset text | `Cmd`+`=` / `Cmd`+`-` / `Cmd`+`0` | `Ctrl`+`=` / `Ctrl`+`-` / `Ctrl`+`0` |
| Clear screen and scrollback | `Cmd`+`K` | — |
| Find in the terminal / next / previous | `Cmd`+`F` / `Cmd`+`G` / `Shift`+`Cmd`+`G` | `Ctrl`+`Shift`+`F` |
| Search every file in the workspace | `Shift`+`Cmd`+`F` | `Ctrl`+`Shift`+`Alt`+`F` |
| Start / end of line, delete line | `Cmd`+`←` / `Cmd`+`→`, `Cmd`+`Backspace` | — |
| Back / forward a word | `Option`+`←` / `Option`+`→` | — |
| Go to column 1–9 | `Cmd`+`Option`+`1`…`9` | `Alt`+`Shift`+`1`…`9` |
| Toggle the left / right panel | `Cmd`+`B` / `Cmd`+`Option`+`B` | `Ctrl`+`Shift`+`B` / `Ctrl`+`Shift`+`G` |
| Split into a new column | `Cmd`+`\` | `Ctrl`+`Shift`+`\` |
| Full screen | `Cmd`+`Enter`, `Cmd`+`Ctrl`+`F` | `F11` |

In the editor the keys are Monaco's own, as in VS Code: `Cmd`+`S` saves, `Cmd`+`F` finds in the file,
`Cmd`+`Option`+`F` replaces, `Cmd`+`G` finds the next one.

While a browser tab has the keyboard, the page gets its keys — `Cmd`+`B` is bold in a web editor,
not the side panel — except the ones every browser keeps for itself: switching, opening and closing
tabs, plus searching the workspace and opening Settings.

On Windows and Linux, plain `Ctrl`+letter stays with the shell — `Ctrl`+`C` interrupts, `Ctrl`+`D`
ends input, `Ctrl`+`W` deletes a word — which is why everything there has a `Shift` in it.

Shift+Enter sends ESC CR, the same thing Claude Code's own `/terminal-setup` binds in VS Code. A
program that turns on xterm's modifyOtherKeys, as vim does, gets `CSI 27;2;13~` instead, so Shift+Enter
in vim's insert mode is still a newline rather than a trip to normal mode.

There is also a tmux-style prefix, for anybody whose fingers expect one: press it, release it, then
one key. It is set, or turned off, in the same place.

| | |
|---|---|
| Split right | `Ctrl`+`A` then `|` |
| Split down | `Ctrl`+`A` then `-` |
| Close pane | `Ctrl`+`A` then `x` |
| Send a literal `Ctrl`+`A` | `Ctrl`+`A` twice |

Either side panel can be collapsed from the chevron in its header, or with the shortcuts above. A
collapsed panel leaves a labelled strip on that edge — click it to bring the panel back.

## Where Rigee keeps your data

| | |
|---|---|
| macOS | `~/Library/Application Support/rigee` |
| Linux | `~/.config/rigee` |
| Windows | `%APPDATA%\rigee` |

`workspaces.json` holds your workspaces, open tabs, split layouts, key bindings and settings. It is written
when things change, every 15 seconds, and on close, so an unexpected quit loses at most the last
few seconds of layout. Deleting the directory resets the app and loses nothing but layout.

## Building it yourself

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Licence

MIT
