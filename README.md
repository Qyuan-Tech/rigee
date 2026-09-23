# rigee

One window for the whole loop: terminals, code, diffs and the web.

If you write code mostly by directing AI agents, your attention is probably split across a
terminal multiplexer, an editor you use to read diffs, and a browser full of docs. rigee puts
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
  multi-root workspace.
- **Centre** — tabs. A tab is a terminal (splittable), a file in Monaco, a diff, or a Chromium
  page. Mix them freely and drag to reorder.
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

rigee recovers your real `PATH` at startup, so Homebrew, nvm, asdf and friends work even though
an app launched from Finder inherits almost none of it.

## What works today

| Area | State |
|---|---|
| Workspaces — multiple folders, persisted across restarts | works |
| File explorer — lazy-loaded tree | works |
| Editor — Monaco, syntax highlighting, view state kept per tab | works |
| Browser tabs — navigation, persistent logins, DevTools, `target=_blank` opens a tab | works |
| Terminals — one pseudo-terminal per pane, running your login shell | works |
| Split panes — Cmd/Ctrl+D beside, Shift+Cmd/Ctrl+D below, draggable dividers | works |
| Scratch workspace — terminals without setting anything up | works |
| Source control — status, diff, stage, unstage, discard, commit, amend | works |
| Staging individual hunks and lines, and discarding them | works |
| Live refresh — the panel updates when git runs in your own terminal | works |
| HTTP auth prompt in browser tabs | works |
| Restoring tabs, splits and browser pages on next launch | works |
| PDF reader — continuous scrolling, text selection and search, outline, thumbnails | works |
| Plugins — the editor, explorer, PDF, source control and the browser are all plugins | works |
| Activity bar — icons down the left edge switch the side panel, VS Code style | works |
| Plugins view — what is installed, what it contributes, and a switch to turn it off | works |
| Terminals surviving a restart | **no** — the layout returns, the running processes do not |

## Plugins

rigee's core is a shell: a window, workspaces, a tab framework, terminals and persistence. The
features are plugins, and they are not a second-class extension mechanism bolted on afterwards —
the text editor, the PDF reader, source control and the browser are each a folder under
`plugins/`, loaded on demand through two IPC channels and a declarative manifest.

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
views — is revoked when the plugin is disposed. See `docs/DEVELOPMENT.md` for the contribution
points and the traps.

## Terminals

Each pane is its own pseudo-terminal running your login shell, and each terminal tab holds a tree
of panes you can split and resize.

They do not outlive the app: quitting rigee ends the shells and whatever they were running. If
you need something to survive that, start it under a multiplexer inside a pane — typing `tmux` or
`screen` works exactly as it would in any other terminal.

Splitting uses a tmux-style prefix: press the prefix, release it, then the action key. Right-click
a pane for the same commands with their current bindings shown, and change them from the gear in
the title bar.

| | |
|---|---|
| Split right | `Ctrl`+`A` then `|` |
| Split down | `Ctrl`+`A` then `-` |
| Close pane | `Ctrl`+`A` then `x` |
| Send a literal `Ctrl`+`A` | `Ctrl`+`A` twice |
| Split right / down (also) | `Cmd`/`Ctrl` + `D`, `Shift` + `Cmd`/`Ctrl` + `D` |
| New terminal tab | `Cmd`/`Ctrl` + `T` |
| Close tab | `Cmd`/`Ctrl` + `W` |
| Toggle the sidebars | `Cmd`/`Ctrl` + `B`, `Shift` + `Cmd`/`Ctrl` + `G` |

Either side panel can be collapsed from the chevron in its header, or with the shortcuts above. A
collapsed panel leaves a labelled strip on that edge — click it to bring the panel back.

## Where rigee keeps your data

| | |
|---|---|
| macOS | `~/Library/Application Support/rigee` |
| Linux | `~/.config/rigee` |
| Windows | `%APPDATA%\rigee` |

`workspaces.json` holds your workspaces, open tabs, split layouts and key bindings. It is written
when things change, every 15 seconds, and on close, so an unexpected quit loses at most the last
few seconds of layout. Deleting the directory resets the app and loses nothing but layout.

## Building it yourself

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Licence

MIT
