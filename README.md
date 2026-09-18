# onestop

One window for the whole loop: terminals, code, diffs and the web.

If you write code mostly by directing AI agents, your attention is probably split across a
terminal multiplexer, an editor you use to read diffs, and a browser full of docs. onestop puts
those three in one window without pretending any of them is something it isn't — the terminal is
real tmux, the editor is the real VS Code editor, and the browser is real Chromium.

> **Status: early but usable.** Terminals, editor, browser tabs and source control all work.
> Hunk-level staging and the tmux split UI do not yet. See
> [What works today](#what-works-today).

## What it looks like

```
┌────────────────┬──────────────────────────────────────────┬──────────────────┐
│  WORKSPACES    │  ❯ terminal   ◧ App.tsx   ◎ docs    + ❯ ◎│  SOURCE CONTROL  │
│  ▸ onestop     │ ─────────────────────────────────────────│                  │
│  ▸ api         │                                          │  Message…        │
│  ▸ infra       │                                          │                  │
│                │                                          │  STAGED      2   │
│  EXPLORER      │         tmux pane / Monaco editor        │   index.ts    M  │
│  ▾ src         │              / Chromium                  │   util.ts     A  │
│    ▾ main      │                                          │                  │
│      index.ts  │                                          │  CHANGES     1   │
│    ▾ renderer  │                                          │   App.tsx     M  │
│      App.tsx   │                                          │                  │
└────────────────┴──────────────────────────────────────────┴──────────────────┘
```

- **Left** — workspaces and a file tree. A workspace is a named set of folders, like a VS Code
  multi-root workspace. Each one owns its own tmux session.
- **Centre** — tabs. A tab is a tmux pane, a file in Monaco, a diff, or a Chromium page. Mix them
  freely and drag to reorder.
- **Right** — source control, aware of every git repo in the workspace at once.

## Install

Download the build for your platform from the
[latest release](https://github.com/Jason-Chang_citrix/onestop/releases/latest).

| Platform | File | Notes |
|---|---|---|
| macOS (Apple Silicon) | `onestop-<version>-arm64.dmg` | |
| macOS (Intel) | `onestop-<version>-x64.dmg` | |
| Windows | `onestop-<version>-x64-setup.exe` | Installs per-user, no admin prompt |
| Linux | `onestop-<version>-x86_64.AppImage` | `chmod +x` then run |
| Linux (Debian/Ubuntu) | `onestop_<version>_amd64.deb` | `sudo dpkg -i …` |

Builds are currently **unsigned**, so every OS will object the first time:

- **macOS** — right-click the app and choose *Open*, or
  `xattr -dr com.apple.quarantine /Applications/onestop.app`.
- **Windows** — SmartScreen shows "Windows protected your PC"; choose *More info → Run anyway*.
- **Linux** — nothing to bypass.

### Requirements

**tmux** must be installed for terminal tabs. Everything else works without it. onestop finds it
even when launched from Finder, where an app inherits almost no PATH.

```bash
brew install tmux        # macOS
sudo apt install tmux    # Debian/Ubuntu
```

On **Windows**, terminals run through WSL2, so install WSL and then install tmux inside your
distribution. The status bar tells you which tmux was detected, or that none was.

## What works today

| Area | State |
|---|---|
| Workspaces — multiple folders, persisted across restarts | works |
| File explorer — lazy-loaded tree | works |
| Editor — Monaco, syntax highlighting, view state kept per tab | works |
| Browser tabs — navigation, persistent logins, DevTools, `target=_blank` opens a tab | works |
| Terminals — real tmux via control mode, one session per workspace | works |
| Scratch workspace — terminals without setting anything up | works |
| Source control — status, diff, stage, unstage, discard, commit, amend | works |
| Live refresh — the panel updates when git runs in your own terminal | works |
| Staging a hunk or a line range | **not implemented** — whole files only |
| Split panes, tmux window/tab mapping in the UI | partial — panes exist, the split UI does not |
| HTTP auth prompt in browser tabs | **not implemented** — auth requests are cancelled |

## Your tmux is safe

onestop never touches your default tmux server. Each workspace gets a private socket under the
app's data directory, so `tmux ls` in your own terminal keeps showing exactly what it showed
before, and nothing onestop does can kill your sessions.

Terminal tabs attach in tmux **control mode**, which means the session is a genuine tmux session:
it survives closing the app, and you can attach to it from a normal terminal with
`tmux -S <socket> attach`.

## Where onestop keeps your data

| | |
|---|---|
| macOS | `~/Library/Application Support/onestop` |
| Linux | `~/.config/onestop` |
| Windows | `%APPDATA%\onestop` |

`workspaces.json` holds your workspaces and open tabs. `tmux/` holds the per-workspace sockets.
Deleting the directory resets the app and loses nothing but layout.

## Building it yourself

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Licence

MIT
