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
  A saved workspace's file tree starts with the folder its file is in — tinted and tagged
  *Workspace*, above the repos — because that folder is the workspace's own. The tree does to
  files what VS Code's does: new, rename, cut, copy, paste, delete, drag in from Finder or around
  the tree — see [the explorer](#the-explorer).
  The list is ordered by [heat](#workspace-heat): the workspaces you have been busiest in come
  first, orange when hot and amber when warm, and the ones you have not touched in a while fade
  out below a *Cold* divider, with a checklist for removing them. Each row also counts the
  [terminals at work](#terminals-at-work) in it — an agent or a build printing — and, in green, the
  ones that have finished since you last looked; click a count to go to that terminal.
- **Centre** — tabs. A tab is a terminal (splittable), a file in Monaco, an image, a Markdown
  preview, a diff, or a Chromium page. Mix them freely and drag to reorder; right-click any of them for Close, Close
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
| Markdown preview — right-click a `.md` for *Open Preview*: GitHub-flavoured, code coloured, redrawn as the file changes on disk, pictures from the web only when asked | works |
| Workspace files folder — set once in Settings, then Save Workspace As… asks only for a name | works |
| Right-click a workspace — Add Folder to Workspace, Save Workspace As, Remove | works |
| A folder added to a saved workspace goes into its `.code-workspace` file, comments and settings kept | works |
| A saved workspace's terminals start in the folder its `.code-workspace` file is in | works |
| A saved workspace's explorer starts with that folder, marked out from the repos below it | works |
| Workspace heat — the list ordered by how much each workspace has been used lately, hot and warm ones coloured, with how long since anything happened in each | works |
| Cold workspaces — nothing in them for ten days of use — faded under their own divider, with a checklist to remove them | works |
| Terminals at work — a spinning count on the workspace's row, a light along it, and a spinner on the tab, while an agent or a build is printing | works |
| Finished unseen — a green count on the workspace, a dot on the tab and an outline on the split pane until you click into it; the count takes you there | works |
| A terminal opened in an unsaved workspace offers to save it first — or not now, or never again | works |
| Right-click a folder in the explorer — Open in Terminal Tab, or Open in Terminal Split beside the terminal on screen | works |
| Explorer file operations — New File, New Folder, Rename, Cut, Copy, Paste, Delete to the Trash, Copy Path, Copy Relative Path, Reveal in Finder, from the right-click menu or VS Code's keys | works |
| Explorer selection — click, Cmd/Ctrl-click and Shift-click, the arrows with Shift, Cmd/Ctrl+A | works |
| Drag files in from Finder or Explorer to copy them; drag inside the tree to move, holding Option (Ctrl elsewhere) to copy | works |
| Tabs follow a file renamed or moved in the explorer, and close when it is deleted there | works |
| Plugins — the editor, explorer, PDF, images, source control and the browser are all plugins | works |
| Activity bar — icons down the left edge switch the side panel, VS Code style | works |
| Plugins view — what is installed, what it contributes, and a switch to turn it off | works |
| Terminals surviving a restart | **no** — the layout returns, the running processes do not |

## Plugins

Rigee's core is a shell: a window, workspaces, a tab framework, terminals and persistence. The
features are plugins, and they are not a second-class extension mechanism bolted on afterwards —
the text editor, the PDF reader, the image viewer, the video player, the Markdown preview, source
control and the browser are each a folder under `plugins/`, loaded on demand through two IPC channels and a declarative manifest.

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

## The explorer

The tree works on files the way VS Code's does. Right-click a file or a folder for *New File…*,
*New Folder…*, *Reveal in Finder*, *Cut*, *Copy*, *Paste*, *Copy Path*, *Copy Relative Path*,
*Rename…* and *Delete* — the menu shows each one's key — or use the keys with the tree focused:

| | macOS | Windows / Linux |
|---|---|---|
| Cut / copy / paste | `Cmd`+`X` / `Cmd`+`C` / `Cmd`+`V` | `Ctrl`+`X` / `Ctrl`+`C` / `Ctrl`+`V` |
| Delete, to the Trash | `Cmd`+`Backspace`, or `Backspace` alone | `Delete` |
| Delete for good | `Option`+`Cmd`+`Backspace` | `Shift`+`Delete` |
| Rename | `Enter` or `F2` | `F2` |
| Open, keeping the keyboard in the tree | `Space`, or a click | `Space`, or a click |
| Open and start typing | `Cmd`+`Down`, or a double-click | `Enter`, or a double-click |
| Copy Path / Copy Relative Path | `Option`+`Cmd`+`C` / `Shift`+`Option`+`Cmd`+`C` | `Shift`+`Alt`+`C` / `Ctrl`+`Shift`+`Alt`+`C` |
| Reveal in Finder / File Explorer | `Option`+`Cmd`+`R` | `Shift`+`Alt`+`R` |
| Select several | `Cmd`-click, `Shift`-click, `Shift`+arrows, `Cmd`+`A` | `Ctrl`-click, `Shift`-click, `Shift`+arrows, `Ctrl`+`A` |

Every delete asks first. Rename and New File put a box in the tree, which says as you type when a
name is taken; a name like `src/lib/new.ts` makes the folders on the way. Pasting into the folder a
file came from duplicates it — `a.ts` becomes `a copy.ts`, then `a copy 2.ts`. With several rows
selected, the menu and the keys act on all of them. The workspace's own folders cannot be cut,
renamed or deleted from the tree: that is a change to the workspace, not to a file.

Drag files in from Finder or Explorer to copy them into the folder under the pointer, which lights
up with everything shown inside it; a name already there is asked about. Drag rows around the tree
to move them, holding `Option` (`Ctrl` elsewhere) to copy instead. A folder dropped on one of the
workspace's own folders asks whether it should join the workspace or be copied in, and one dropped
in the empty space below the tree joins the workspace, as before.

A single click opens a file and leaves the keyboard in the tree, so the arrows and Delete keep
acting on the tree; double-click to start typing in the file. A file renamed or moved in the tree
takes its tabs with it, and one deleted there closes them. A file with unsaved changes is not
renamed or moved until they are saved or undone, and deleting one says that they will be lost.

A Markdown file's menu starts with *Open Preview*: the file rendered, GitHub-flavoured, in a tab
beside its own, and redrawn as it changes on disk — so a plan an agent is writing can be watched as
it grows. Pictures from the web are not fetched until you press *Show remote images*.

## Workspace heat

The workspace list shows at a glance where the work is. Each workspace has a heat — how much it has
been used lately — and the list is ordered by it, with Scratch always first:

| | |
|---|---|
| **Hot** — orange, filled | about an hour of use today, or more spread over the last few days |
| **Warm** — amber | ten minutes or so today, or an agent busy in it |
| **Cool** — grey | little use lately |
| **Cold** — faded, below a divider | nothing at all in it for ten days of use |

On the right of each row is how long since anything happened there — `5m`, `3h`, `2d`, `3w` — and
hovering a row says what its heat is made of.

What counts is a minute in which you did something in the workspace: switched to it, typed, clicked
or scrolled in it. A minute in which its terminals printed in earnest — an agent at work or a
build, even while you are in another workspace — counts for a tenth as much, and all of that
together can make a workspace warm but never hot: an agent keeps its workspace from going cold, but
only you make one hot. A shell drawing its prompt does not count. Each day of use is worth a
quarter less than the one after it.

Time is counted in **days you used Rigee**, not calendar days, so a weekend or a holiday changes
nothing — you do not come back to a list of cold workspaces. Workspaces that existed before heat
did start counting from the day you upgrade, so none of them is cold until ten days of use have
gone by without it.

The list holds still while the pointer is over it, so nothing moves under a click; it re-sorts when
the pointer leaves. Cold workspaces are never removed for you. *N cold* in the header, or *Review…*
on the divider, opens a checklist of them, all ticked; untick any you want to keep, and *Remove*
does for the rest what a workspace's own remove button does — its tabs close, asking first about
unsaved files, and its folders and `.code-workspace` file stay where they are.

## Terminals at work

The same list says what is still running and what has finished without you. While a terminal in a
workspace is at work, its row shows a spinning count — how many are — with a light running along
the row, and the terminal's tab shows a spinner in place of its icon. When one stops and you were
not looking at it, the row shows a green count of those, the tab a green dot, and the pane — a
split, say — a green outline. Clicking a count takes you to the first terminal it counts; clicking
into a pane, or opening its tab, is looking at it, and its marks go.

**At work means printing**, not merely having a program in the terminal. An agent at work prints
all the time — its spinner, its elapsed seconds — and falls silent when it is done or wants an
answer, while its process lives on; so does vim's, or an idle ssh session's. So a terminal counts
as at work once a program in front of its shell has printed for two seconds without a pause of six,
and as finished once a six-second pause follows: an agent waiting for you — permission prompts
included — a build done, a shell back at its prompt. What your own typing echoes back does not
count, and neither does a command that is over in under two seconds. A program that runs without
printing anything is not counted.

## Where Rigee keeps your data

| | |
|---|---|
| macOS | `~/Library/Application Support/rigee` |
| Linux | `~/.config/rigee` |
| Windows | `%APPDATA%\rigee` |

`workspaces.json` holds your workspaces, open tabs, split layouts, key bindings, settings, and how
much each workspace has been used lately — minutes a day, a few weeks of them. It is written
when things change, every 15 seconds, and on close, so an unexpected quit loses at most the last
few seconds of layout. Deleting the directory resets the app and loses nothing but layout.

## Building it yourself

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Licence

MIT
