import { app, BrowserWindow, clipboard, dialog, net, protocol, shell, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  rmSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { isUtf8 } from 'node:buffer'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { deflateSync } from 'node:zlib'
import { popupContextMenu } from './contextMenu'
import { mediaScheme, registerMediaProtocol, servedCount } from './media'
import { ensureShellPath } from './env'
import { installMenu } from './menu'
import { forwardShortcuts } from './shortcuts'
import { confirmUnsaved, hasUnsavedChanges, registerUnsavedHandlers, resetUnsaved } from './unsaved'
import { PtyManager } from './pty/manager'
import {
  addFoldersToWorkspaceFile,
  parseWorkspaceFile,
  resolveWorkspaceFilesDir,
  serializeWorkspaceFile
} from './workspaceFile'
import { emit, handle } from './ipc'
import {
  appSettings,
  disabledPlugins,
  EXPLORER_PLUGIN_ID,
  loadState,
  saveAllUi,
  saveDisabledPlugins,
  saveKeybindings,
  saveSettings,
  saveWorkspaces
} from './store'
import { namedWorkspaceFile, WORKSPACE_FILE_EXTENSION, workspaceNameProblem } from '@shared/workspaceFiles'
import type { PluginHost } from './plugins/host'
import type { AskOptions } from './plugins/shell'
import {
  approvePlugin,
  diskLoaders,
  installedPlugins,
  pluginScheme,
  registerPluginProtocol,
  rendererEntryUrl,
  revokePlugin,
  scanDiskPlugins
} from './plugins/installed'
import { initTrustStore } from './plugins/trust'
import { PLUGIN_MANIFESTS } from '@plugins/index'
import { PERSISTED_STATE_VERSION, type FileStat, type Workspace, type WorkspaceActivity } from '@shared/types'

const execFileAsync = promisify(execFile)
const __dirnameESM = dirname(fileURLToPath(import.meta.url))

const T0 = Date.now()
const mark = (label: string): void => {
  console.log(`[perf] ${label} +${Date.now() - T0}ms (uptime ${Math.round(process.uptime() * 1000)}ms)`)
}
mark('main module evaluated')

/**
 * Where the data lives, pinned, so that the product's NAME can never move it again.
 *
 * Electron derives `userData` from the application's name, and on macOS that name comes from the
 * bundle — so capitalising the product to `Rigee` would have silently relocated
 * `~/Library/Application Support/rigee` to `…/Rigee`. It happens to survive on a default APFS
 * volume, which is case-insensitive, and would NOT survive on a case-sensitive one or on Linux:
 * every workspace, every restored tab, the key bindings and every signed-in browser session go
 * quiet at once, with the data still sitting there under the old spelling. That already happened
 * once, on the rename from onestop, and `adoptLegacyUserData` below is the apology for it.
 *
 * So the storage path is now stated outright instead of being a consequence of a display string.
 * `rigee`, lower case, for ever: it is an identifier, and the name on the Dock is free to change
 * without anybody having to think about this again.
 *
 * MUST be the first thing that touches paths — before the smoke override below, and before
 * anything calls `getPath('userData')`.
 */
app.setPath('userData', join(app.getPath('appData'), 'rigee'))

/**
 * Every smoke mode runs against a throwaway data directory.
 *
 * Without this the tests read and write the developer's real workspaces.json — and the
 * persistence test in particular would overwrite their actual open tabs with its fixtures. Has to
 * happen before anything calls getPath('userData').
 */
if (process.env.RIGEE_SMOKE) {
  const dir = process.env.RIGEE_SMOKE_DATA ?? join(tmpdir(), `rigee-smoke-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  app.setPath('userData', dir)
  console.log(`[smoke] userData = ${dir}`)
  // The migrate mode's fixture can only be planted here. `loadState()` caches for the life of the
  // process, so a v2 document written once the window is up would never be read — the mode would
  // assert against a freshly created v3 document and pass without migrating anything.
  if (process.env.RIGEE_SMOKE === 'migrate') plantV2Document(dir)
  // Same reason: the plugin directory is scanned once, at app ready. A plugin copied in after
  // that is not in the snapshot, and the mode would assert against an empty registry.
  if (process.env.RIGEE_SMOKE === 'diskplugin') plantExamplePlugin(dir)
  // The keys mode types into terminals — Enter included — so its panes run a sink rather than
  // the user's shell, where every one of those keystrokes would be a command in their history.
  // And it never shows its window or takes the foreground: it runs while somebody is working.
  // The workspace files mode asks each pane's process where it started, which a real shell's rc
  // file is free to answer differently by changing directory; a sink stays where it was put.
  if (process.env.RIGEE_SMOKE === 'keys' || process.env.RIGEE_SMOKE === 'workspacefiles') {
    const sink = join(dir, 'sink.sh')
    writeFileSync(sink, '#!/bin/sh\nexec cat >/dev/null\n', { mode: 0o755 })
    process.env.SHELL = sink
  }
  // The heat mode starts from workspaces that predate heat, so its document has to be there before
  // `loadState()` first reads it. Its terminals print what it needs them to: a build's worth from a
  // folder called chatty, after a pause long enough to have switched away from it; a prompt's worth
  // anywhere else.
  if (process.env.RIGEE_SMOKE === 'heat') {
    plantHeatDocument(dir)
    const printer = join(dir, 'printer.sh')
    writeFileSync(
      printer,
      '#!/bin/sh\n' +
        'case "$(pwd)" in\n' +
        '  */chatty) sleep 3; i=0; while [ "$i" -lt 400 ]; do echo "compiling module $i of 400 ......................................"; i=$((i + 1)); done ;;\n' +
        "  *) printf 'ready$ ' ;;\n" +
        'esac\n' +
        'exec cat >/dev/null\n',
      { mode: 0o755 }
    )
    process.env.SHELL = printer
  }
  // The running mode needs a real shell with job control — a program in front of it is what main
  // reports as running — and nothing from anybody's rc files; and two programs to run in it: an
  // agent that works for four seconds and then waits for an answer, alive and silent, and a build
  // that prints for three and exits.
  if (process.env.RIGEE_SMOKE === 'running') {
    // Asked `-ilc <command>` — the PATH probe at startup — it runs the command and goes, as any shell
    // would. An interactive shell there would wait on the probe's stdin, and ignores the SIGTERM its
    // timeout sends, so startup would wait for ever.
    const shell = join(dir, 'shell.sh')
    writeFileSync(
      shell,
      '#!/bin/sh\n' +
        'case "$1" in -*c*) shift; exec /bin/sh -c "$1" ;; esac\n' +
        "export PS1='$ ' HISTFILE=/dev/null\n" +
        'unset ENV\n' +
        'exec /bin/sh -i\n',
      { mode: 0o755 }
    )
    writeFileSync(
      join(dir, 'agent.sh'),
      'i=0\n' +
        'while [ "$i" -lt 40 ]; do printf \'\\r| working on it (%d)\' "$i"; sleep 0.1; i=$((i + 1)); done\n' +
        "printf '\\nWaiting for your answer: '\n" +
        'read answer\n'
    )
    writeFileSync(
      join(dir, 'build.sh'),
      'i=0\n' +
        'while [ "$i" -lt 30 ]; do echo "compiling $i of 30"; sleep 0.1; i=$((i + 1)); done\n' +
        'echo built\n'
    )
    process.env.SHELL = shell
  }
}

/**
 * A smoke run that must not put a window in front of the person using the machine: the keys mode
 * always, any other mode with RIGEE_SMOKE_HIDDEN=1. Hidden AND kept out of the foreground — on
 * macOS an app that merely launches can still take the focus, so it becomes an accessory app.
 */
const HIDDEN_SMOKE =
  !!process.env.RIGEE_SMOKE &&
  (process.env.RIGEE_SMOKE === 'keys' || process.env.RIGEE_SMOKE === 'editing' || process.env.RIGEE_SMOKE_HIDDEN === '1')
if (HIDDEN_SMOKE && process.platform === 'darwin') {
  void app.whenReady().then(() => app.setActivationPolicy('accessory'))
}

/** Files above this are opened read-only with a warning rather than streamed into Monaco. */
const MAX_EDITABLE_BYTES = 8 * 1024 * 1024

let window: BrowserWindow | null = null
let ptys: PtyManager | null = null

const shellWc = (): WebContents | null =>
  window && !window.webContents.isDestroyed() ? window.webContents : null

// ---------------------------------------------------------------------------
// Plugins
//
// The host is built on the first `plugin:invoke` and not a moment earlier. cordis costs a
// measured 10.4 ms to import and 3.5 ms to construct a Context — small against a 409 ms
// module-eval budget, and entirely avoidable, because nothing before that first call needs it.
// Both imports are dynamic for the same reason: a static one would put cordis and the main-half
// registry in the boot path whether or not any plugin is ever used.
// ---------------------------------------------------------------------------

let pluginHost: PluginHost | null = null
let pluginHostP: Promise<PluginHost> | null = null

/**
 * Answers the questions plugins ask through `ShellService.ask`, for the smoke modes — as `menus`
 * answers menus in the renderer. It sees each question and says which button was pressed.
 */
const askProbe: { answer: ((options: AskOptions) => number) | null } = { answer: null }

async function askUser(options: AskOptions): Promise<number> {
  if (askProbe.answer) return askProbe.answer(options)
  const box = { noLink: true, ...options }
  const { response } = window ? await dialog.showMessageBox(window, box) : await dialog.showMessageBox(box)
  return response
}

function plugins(): Promise<PluginHost> {
  pluginHostP ??= (async () => {
    const [{ PluginHost }, { MAIN_HALVES }] = await Promise.all([
      import('./plugins/host'),
      import('@plugins/registry.main')
    ])
    const host = new PluginHost(
      // Bundled first, disk second, and a disk plugin cannot shadow a bundled one because
      // discovery rejects an id that is already taken. The disk half re-checks trust when it is
      // actually called, so revoking approval stops the code running rather than stopping it
      // running next launch.
      { ...MAIN_HALVES, ...diskLoaders() },
      {
        window: () => window,
        webContents: shellWc,
        send: (payload) => emit(shellWc(), 'plugin:event', payload),
        ask: askUser
      },
      // Read from disk rather than waited for from the renderer: the first `plugin:invoke` can
      // arrive before the plugins view has ever been opened, and a disabled plugin must not start
      // even once.
      disabledPlugins()
    )
    pluginHost = host
    return host
  })()
  return pluginHostP
}

// ---------------------------------------------------------------------------
// Window
//
// A BrowserWindow, not a BaseWindow + WebContentsView.
//
// BaseWindow looked like the tidier structure — the shell would be just another child view, so it
// could be raised above a browser tab when an overlay needs to cover one. But a BaseWindow does
// not give keyboard focus to a child view the way a BrowserWindow gives it to its own
// webContents, and `webContents.focus()` sets the flag without actually routing keystrokes. The
// result was an app that looked completely normal and accepted no typing anywhere: not the
// terminal, not the commit box. Browser tabs still composite above the shell as child views of
// contentView, which is all the layering we actually need today.
// ---------------------------------------------------------------------------

function createWindow(): void {
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    show: false,
    // Matches --bg-deep, so the window does not flash a different shade before the renderer paints.
    backgroundColor: '#1a1c25',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirnameESM, '../preload/index.cjs'), // .cjs, never .mjs — see vite config
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  })

  ptys = new PtyManager(shellWc, (workspaceId, paneId, exitCode) =>
    emit(shellWc(), 'terminal:exit', { workspaceId, paneId, exitCode })
  )

  // The trusted shell never opens windows itself; anything it tries goes to the real browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.once('ready-to-show', () => {
    mark('ready-to-show')
    if (!HIDDEN_SMOKE) window?.show()
  })

  window.webContents.once('did-finish-load', () => {
    mark('shell did-finish-load')
    if (!HIDDEN_SMOKE) window?.show()
    focusActiveView()
    if (process.env.RIGEE_SMOKE === 'terminal') void runTerminalSmoke()
    else if (process.env.RIGEE_SMOKE === 'split') void runSplitSmoke()
    else if (process.env.RIGEE_SMOKE === 'persist') void runPersistSmoke()
    else if (process.env.RIGEE_SMOKE === 'tabs') void runTabsSmoke()
    else if (process.env.RIGEE_SMOKE === 'quit') void runQuitSmoke()
    else if (process.env.RIGEE_SMOKE === 'shutdown') void runShutdownSmoke()
    else if (process.env.RIGEE_SMOKE === 'copy') void runCopySmoke()
    else if (process.env.RIGEE_SMOKE === 'mouse') void runMouseSmoke()
    else if (process.env.RIGEE_SMOKE === 'scratch') void runScratchSmoke()
    else if (process.env.RIGEE_SMOKE === 'scroll') void runScrollSmoke()
    else if (process.env.RIGEE_SMOKE === 'explorer') void runExplorerSmoke()
    else if (process.env.RIGEE_SMOKE === 'fileops') void runFileOpsSmoke()
    else if (process.env.RIGEE_SMOKE === 'multirepo') void runMultiRepoSmoke()
    else if (process.env.RIGEE_SMOKE === 'shot') void captureShot()
    // These three must stay ABOVE the catch-all below, which matches any truthy value: a branch
    // added after it silently never runs and the generic check reports a cheerful green.
    else if (process.env.RIGEE_SMOKE === 'plugins') void runPluginsSmoke()
    else if (process.env.RIGEE_SMOKE === 'pdf') void runPdfSmoke()
    else if (process.env.RIGEE_SMOKE === 'migrate') void runMigrateSmoke()
    else if (process.env.RIGEE_SMOKE === 'diskplugin') void runDiskPluginSmoke()
    else if (process.env.RIGEE_SMOKE === 'keys') void runKeysSmoke()
    else if (process.env.RIGEE_SMOKE === 'editing') void runEditingSmoke()
    else if (process.env.RIGEE_SMOKE === 'workspacefiles') void runWorkspaceFilesSmoke()
    else if (process.env.RIGEE_SMOKE === 'video') void runVideoSmoke()
    else if (process.env.RIGEE_SMOKE === 'heat') void runHeatSmoke()
    else if (process.env.RIGEE_SMOKE === 'running') void runRunningSmoke()
    else if (process.env.RIGEE_SMOKE) void runSmokeTest()
  })

  window.on('focus', focusActiveView)
  window.on('closed', () => { window = null })
  // Closing the window with unsaved edits asks first, the way quitting does. A quit that already
  // asked has released them, so this does not ask twice.
  resetUnsaved()
  // A renderer that crashed or reloaded took its unsaved text with it. Asking about it afterwards
  // would offer to save edits that no longer exist — and Save would wait on a page that cannot answer.
  window.webContents.on('render-process-gone', resetUnsaved)
  // On a navigation that COMMITTED — one that is only starting may turn into a download and leave
  // the page, and its unsaved text, exactly where they were.
  window.webContents.on('did-navigate', resetUnsaved)
  window.on('close', (event) => {
    if (!hasUnsavedChanges()) return
    event.preventDefault()
    const closing = window
    void confirmUnsaved(closing, shellWc(), false).then((go) => { if (go) closing?.close() })
  })

  // Without these, a renderer that fails to boot just shows nothing and the window never appears.
  window.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[shell] did-fail-load ${code} ${desc} ${url}`)
    window?.show()
  })
  window.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error(`[shell] preload-error ${preloadPath}:`, error)
  })
  window.webContents.on('render-process-gone', (_e, details) => {
    console.error('[shell] render-process-gone', details)
  })
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      console.error(`[shell:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`)
    }
  })
  window.webContents.on('did-start-loading', () => mark('shell did-start-loading'))
  window.webContents.on('dom-ready', () => mark('shell dom-ready'))

  // Load first so renderer boot overlaps any main-side initialisation.
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const indexHtml = join(__dirnameESM, '../renderer/index.html')
  const loading = devUrl
    ? window.webContents.loadURL(devUrl)
    : window.webContents.loadFile(indexHtml)
  loading.catch((err: unknown) => {
    console.error(`[shell] failed to load ${devUrl ?? indexHtml}:`, err)
    window?.show()
  })
}

/**
 * End-to-end check of splitting: open a terminal, split it twice, and assert that each pane ends
 * up with its own live pty and its own xterm instance — and that a split starts in the directory
 * the pane it came from had `cd`'d into, not back at the workspace's folder.
 */
async function runSplitSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  // Somewhere no shell starts by accident, named so that seeing it in a pane can mean one thing.
  const elsewhere = join(tmpdir(), `rigee-split-cwd-${process.pid}`)
  mkdirSync(elsewhere, { recursive: true })
  try {
    const result = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store, getTerminal, paneKey, newTerminalTab } = window.__rigee
        const trail = []

        let scratch = null
        for (let i = 0; i < 60; i++) {
          scratch = store.getState().workspaces.find(w => w.id === '__scratch__')
          if (scratch && store.getState().ready) break
          await sleep(250)
        }
        if (!scratch) return JSON.stringify({ ok: false, stage: 'no-scratch', trail })
        store.getState().setActiveWorkspace(scratch.id)

        const tab = newTerminalTab()
        store.getState().openTab(scratch.id, tab)

        // Across every group: a tab's id is unique in the whole row, but which column holds it is
        // not something this check has any business caring about.
        const current = () => {
          const row = store.getState().rowsByWorkspace[scratch.id]
          return row ? row.groups.flatMap(g => g.tabs).find(t => t.id === tab.id) : undefined
        }
        const leafIds = (n) => n.kind === 'leaf' ? [n.id] : n.children.flatMap(leafIds)

        /** Wait until every leaf has a pty bound and an xterm instance. */
        const settle = async (want) => {
          for (let i = 0; i < 120; i++) {
            await sleep(250)
            const t = current()
            if (!t) continue
            const ids = leafIds(t.root)
            if (ids.length !== want) continue
            const bound = ids.filter(id => {
              const h = getTerminal(paneKey(t.id, id))
              return h && h.paneId
            })
            if (bound.length === want) return { t, ids }
          }
          const t = current()
          return { t, ids: t ? leafIds(t.root) : [] }
        }

        let st = await settle(1)
        if (st.ids.length !== 1) return JSON.stringify({ ok: false, stage: 'first-pane', trail })
        trail.push('1 pane bound')

        const read = (hh) => {
          const b = hh.term.buffer.active
          let out = ''
          for (let i = 0; i < b.length; i++) out += (b.getLine(i)?.translateToString(true) ?? '')
          return out
        }
        const waitFor = async (hh, text) => {
          for (let i = 0; i < 60; i++) {
            if (read(hh).includes(text)) return true
            await sleep(250)
          }
          return false
        }

        // Somewhere else first. The arithmetic is so the line typed cannot pass for its output.
        const elsewhere = ${JSON.stringify(elsewhere)}
        const marker = elsewhere.split(/[\\\\/]/).pop()
        const first = getTerminal(paneKey(st.t.id, st.ids[0]))
        first.term.input(" cd '" + elsewhere + "' && echo CWD-READY-$((6*7))" + String.fromCharCode(13), true)
        if (!(await waitFor(first, 'CWD-READY-42'))) return JSON.stringify({ ok: false, stage: 'cd-never-ran', trail })

        // Split beside, exactly as the keybinding does.
        // Deliver it where a real keypress lands. The binding runs from xterm's key hook, so a
        // window-level dispatch would never reach it.
        const press = (init) => {
          const target = document.activeElement ?? window
          target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
        }
        press({ key: 'd', metaKey: true })
        st = await settle(2)
        trail.push('after split#1: ' + st.ids.length + ' leaves')
        if (st.ids.length !== 2) {
          return JSON.stringify({ ok: false, stage: 'split-1-failed', trail,
            shape: st.t ? JSON.stringify(st.t.root) : 'no tab' })
        }

        // The new pane opened where the first one had gone, not where the workspace is.
        const second = getTerminal(paneKey(st.t.id, st.t.activeLeafId))
        second.term.input(' pwd' + String.fromCharCode(13), true)
        if (!(await waitFor(second, marker))) {
          return JSON.stringify({ ok: false, stage: 'split-did-not-inherit-the-directory', trail,
            screen: read(second).slice(-400) })
        }
        trail.push('split opened in ' + marker)

        // Split below.
        press({ key: 'd', metaKey: true, shiftKey: true })
        st = await settle(3)
        trail.push('after split#2: ' + st.ids.length + ' leaves')
        if (st.ids.length !== 3) {
          return JSON.stringify({ ok: false, stage: 'split-2-failed', trail })
        }

        // Every pane must be a distinct pty and a distinct terminal.
        const ptys = new Set()
        for (const id of st.ids) {
          const h = getTerminal(paneKey(st.t.id, id))
          if (!h || !h.paneId) return JSON.stringify({ ok: false, stage: 'unbound-pane', trail })
          ptys.add(h.paneId)
        }
        if (ptys.size !== 3) {
          return JSON.stringify({ ok: false, stage: 'ptys-not-distinct', trail,
            ptys: [...ptys] })
        }
        trail.push('3 distinct ptys')

        // Typing must reach only the focused pane.
        const active = st.t.activeLeafId
        const h = getTerminal(paneKey(st.t.id, active))
        h.term.input('echo SPLIT-OK-$((8*8))' + String.fromCharCode(13), true)
        for (let i = 0; i < 40; i++) {
          await sleep(250)
          if (read(h).includes('SPLIT-OK-64')) {
            const others = st.ids.filter(id => id !== active)
              .map(id => read(getTerminal(paneKey(st.t.id, id))))
            if (others.some(o => o.includes('SPLIT-OK-64'))) {
              return JSON.stringify({ ok: false, stage: 'output-leaked-across-panes', trail })
            }
            return JSON.stringify({ ok: true, stage: 'split-and-echo', trail })
          }
        }
        return JSON.stringify({ ok: false, stage: 'no-echo-in-active-pane', trail })
      })()`,
      true
    )) as string
    console.log('[smoke:split]', result)
    rmSync(elsewhere, { recursive: true, force: true })
    app.exit(JSON.parse(result).ok ? 0 : 1)
  } catch (err) {
    console.error('[smoke:split] threw:', err)
    rmSync(elsewhere, { recursive: true, force: true })
    app.exit(1)
  }
}

/**
 * Ten repos in one workspace must read as ten repos, not ten crushed commit boxes.
 *
 * Every repo section used to be `flex: 1` in the panel's column, so N repos each received 1/N of
 * the height — around 80px for content needing 200 — and they overlapped instead of stacking.
 * Nothing overflows and nothing throws; the sections just silently squash, which is why the
 * assertion here is on the RENDERED HEIGHT of each section rather than on the panel's geometry.
 *
 * Point RIGEE_SMOKE_MULTIREPO at a directory of git repos.
 */
async function runMultiRepoSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  const dir = process.env.RIGEE_SMOKE_MULTIREPO
  if (!dir) { console.error('[smoke:multirepo] set RIGEE_SMOKE_MULTIREPO'); app.exit(1); return }
  const repos = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(dir, e.name))
    .sort()
  try {
    const result = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store } = window.__rigee
        const trail = []
        // What the panel actually says, on every failure. Source control is a plugin now, so a
        // blank panel can mean the plugin did not load, or loaded and could not reach git — and
        // the difference is written on screen in both cases.
        const rightPane = () => document.querySelectorAll('.pane')[1]
        const panelText = () =>
          ((rightPane() || {}).innerText || '(no right pane)')
            .replace(/\\s+/g, ' ').trim().slice(0, 200)
        const fail = (stage, extra) =>
          JSON.stringify(Object.assign({ ok: false, stage, trail, panel: panelText() }, extra || {}))

        for (let i = 0; i < 60; i++) { if (store.getState().ready) break; await sleep(250) }

        // Positional, and only correct while the editor groups stay .group. A group matched here
        // would make every measurement below one of the centre pane, which looks like source
        // control rendering nothing rather than like a selector that moved.
        if (rightPane() && rightPane().querySelector('.tabstrip')) {
          return fail('an-editor-group-matched-.pane')
        }
        const repos = ${JSON.stringify(repos)}
        store.getState().addWorkspace({
          id: 'ws-multi', name: 'multi', createdAt: Date.now(), lastOpenedAt: Date.now(),
          folders: repos.map(p => ({ path: p, name: p.split('/').pop(),
                                     isGitRepo: true, repoRoot: p }))
        })
        await sleep(6000)

        // The parent of a scm__head element is the section root in either shape, old or new,
        // so the measurement below is comparable across the change. (No backticks in here: this
        // whole block is inside a template literal and one would end it.)
        let sections = [...document.querySelectorAll('.scm__repo')]
        if (sections.length === 0) {
          sections = [...document.querySelectorAll('.scm__head')].map(h => h.parentElement)
          trail.push('using the pre-change structure')
        }
        trail.push('repo sections rendered: ' + sections.length + ' of ' + repos.length)
        if (sections.length !== repos.length) return fail('not-every-repo-rendered')

        // Measure first, assert after, so a run against the old shape still reports numbers.
        const heights = sections.map(el => Math.round(el.getBoundingClientRect().height))
        trail.push('section heights: ' + heights.join(','))
        const rects = sections.map(el => el.getBoundingClientRect())

        // A section too short to hold a branch line and a commit box has been crushed. 60px is
        // well under the ~200 they need and well over a collapsed header.
        const MIN = 60
        const crushed = heights.filter(h => h < MIN)
        trail.push('sections under ' + MIN + 'px: ' + crushed.length)

        const headers = [...document.querySelectorAll('.scm__repo-header')]
        trail.push('collapsible headers: ' + headers.length)
        if (headers.length !== repos.length) return fail('missing-repo-headers', { heights })

        // With headers present, "short" means collapsed on purpose rather than squashed.
        const headerH = Math.round(headers[0].getBoundingClientRect().height)
        if (heights.some(h => h < headerH - 1)) return fail('sections-crushed', { heights, headerH })

        // Overlap: each section must start at or below the previous one's bottom.
        for (let i = 1; i < rects.length; i++) {
          if (rects[i].top < rects[i - 1].bottom - 1) {
            return fail('sections-overlap', { i, prevBottom: rects[i-1].bottom, top: rects[i].top })
          }
        }

        // Dirty repos open, clean ones collapsed: ten repos should read as a list.
        const open = sections.filter(el => el.querySelector('.scm__head')).length
        trail.push('expanded sections: ' + open)
        if (open === sections.length) return fail('clean-repos-should-start-collapsed')
        if (open === 0) return fail('repos-with-changes-should-start-open')

        // The panel scrolls them rather than letting them escape.
        const body = document.querySelector('.scm__body')
        trail.push('panel scrollHeight/clientHeight: ' + body.scrollHeight + '/' + body.clientHeight)
        if (getComputedStyle(body).overflowY !== 'auto') return fail('panel-does-not-scroll')
        const limit = document.querySelector('.shell').getBoundingClientRect().bottom
        if (body.getBoundingClientRect().bottom > limit + 2) return fail('panel-runs-past-the-window')

        // And a collapsed repo can be opened.
        const closed = sections.find(el => !el.querySelector('.scm__head'))
        closed.querySelector('.scm__repo-header').click()
        await sleep(300)
        if (!closed.querySelector('.scm__head')) return fail('header-click-does-not-expand')

        return JSON.stringify({ ok: true, trail })
      })()`,
      true
    )) as string
    console.log('[smoke:multirepo]', result)
    app.exit(JSON.parse(result).ok ? 0 : 1)
  } catch (err) {
    console.error('[smoke:multirepo] threw:', err)
    app.exit(1)
  }
}

/**
 * The explorer remembers which folders were open, per workspace and across a restart.
 *
 * Expansion used to live in each DirNode. Switching workspaces unmounts the whole tree, so the
 * state went with it and coming back re-expanded everything from defaults — losing exactly the
 * arrangement you had set up in the project you were working in.
 *
 * Point RIGEE_SMOKE_MULTIREPO at a directory of folders; two of them become two workspaces.
 */
async function runExplorerSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  const dir = process.env.RIGEE_SMOKE_MULTIREPO
  if (!dir) { console.error('[smoke:explorer] set RIGEE_SMOKE_MULTIREPO'); app.exit(1); return }
  const roots = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => join(dir, e.name)).sort().slice(0, 2)
  if (roots.length < 2) { console.error('[smoke:explorer] need two folders'); app.exit(1); return }
  try {
    const result = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store } = window.__rigee
        const trail = []
        const st = () => store.getState()
        const fail = (stage, extra) =>
          JSON.stringify(Object.assign({ ok: false, stage, trail }, extra || {}))

        for (let i = 0; i < 60; i++) { if (st().ready) break; await sleep(250) }
        const roots = ${JSON.stringify(roots)}
        roots.forEach((p, i) => store.getState().addWorkspace({
          id: 'ws-exp' + i, name: 'exp' + i, createdAt: Date.now(), lastOpenedAt: Date.now(),
          folders: [{ path: p, name: p.split('/').pop(), isGitRepo: true, repoRoot: p }]
        }))
        await sleep(1200)

        // Read where a PLUGIN's state lives, because the explorer is one: the shell no longer has
        // an \`expandedDirs\` of its own to look at.
        const EXPLORER = '${EXPLORER_PLUGIN_ID}'
        const expandedOf = (ws) =>
          ((st().pluginStateByWorkspace[ws] || {})[EXPLORER]?.expandedDirs ?? []).slice().sort()
        const setExpanded = (ws, paths) =>
          st().setPluginState(ws, EXPLORER, { expandedDirs: paths })

        // A first visit opens the roots.
        store.getState().setActiveWorkspace('ws-exp0')
        await sleep(1200)
        trail.push('ws-exp0 on arrival: ' + JSON.stringify(expandedOf('ws-exp0')))
        if (expandedOf('ws-exp0').length !== 1) return fail('roots-not-open-on-first-visit')

        // Collapse everything in A, so its state is distinctive and not just the default.
        setExpanded('ws-exp0', [])
        await sleep(400)
        const rowsCollapsed = document.querySelectorAll('.explorer__body .row').length
        trail.push('ws-exp0 rows while collapsed: ' + rowsCollapsed)

        // Visit B, which must get its own defaults rather than A's.
        store.getState().setActiveWorkspace('ws-exp1')
        await sleep(1200)
        trail.push('ws-exp1 on arrival: ' + JSON.stringify(expandedOf('ws-exp1')))
        if (expandedOf('ws-exp1').length !== 1) return fail('second-workspace-did-not-seed')

        // Back to A: still collapsed. This is the report.
        store.getState().setActiveWorkspace('ws-exp0')
        await sleep(1200)
        trail.push('ws-exp0 on return: ' + JSON.stringify(expandedOf('ws-exp0')))
        if (expandedOf('ws-exp0').length !== 0) {
          return fail('returning-to-a-workspace-reset-its-expansion', { got: expandedOf('ws-exp0') })
        }
        if (document.querySelectorAll('.explorer__body .row').length !== rowsCollapsed) {
          return fail('rendered-tree-does-not-match-remembered-state')
        }

        // The button is a toggle, not a one-way collapse.
        const btn = () => [...document.querySelectorAll('.section-header .icon-button')]
          .find(b => b.title === 'Collapse all folders' || b.title === 'Expand folders')
        trail.push('button now says: ' + btn().title)
        if (btn().title !== 'Expand folders') return fail('button-should-offer-expand-when-collapsed')
        btn().click()
        await sleep(600)
        trail.push('after expand: ' + JSON.stringify(expandedOf('ws-exp0')))
        if (expandedOf('ws-exp0').length === 0) return fail('expand-did-nothing')
        if (btn().title !== 'Collapse all folders') return fail('button-should-offer-collapse-when-open')
        btn().click()
        await sleep(600)
        if (expandedOf('ws-exp0').length !== 0) return fail('collapse-did-nothing')
        trail.push('toggle works both ways')

        // Source control's colours. Only with a fixture that says what to expect: name -> badge,
        // where a folder expects '•', the colour it takes from a change beneath it.
        const expect = ${process.env.RIGEE_SMOKE_EXPECT_DECOR ?? 'null'}
        if (expect) {
          setExpanded('ws-exp0', [roots[0], ...Object.keys(expect).filter(k => k.includes('/')).map(k => roots[0] + '/' + k.split('/')[0])])
          const seen = () => Object.fromEntries([...document.querySelectorAll('.explorer__body .row')]
            .filter(r => r.querySelector('.explorer__badge'))
            .map(r => [r.querySelector('.row__label').textContent, r.querySelector('.explorer__badge').textContent]))
          const want = Object.fromEntries(Object.entries(expect).map(([k, v]) => [k.split('/').pop(), v]))
          let got = {}
          for (let i = 0; i < 40; i++) {
            got = seen()
            if (JSON.stringify(Object.entries(got).sort()) === JSON.stringify(Object.entries(want).sort())) break
            await sleep(250)
          }
          trail.push('decorations: ' + JSON.stringify(got))
          if (JSON.stringify(Object.entries(got).sort()) !== JSON.stringify(Object.entries(want).sort())) {
            return fail('decorations-wrong', { got, want })
          }
          const clean = [...document.querySelectorAll('.explorer__body .row')]
            .find(r => r.querySelector('.row__label').textContent === 'clean.txt')
          if (!clean || clean.querySelector('.explorer__badge') || clean.querySelector('.row__label').style.color) {
            return fail('clean-file-decorated')
          }
        }

        // And it reaches disk, so a restart keeps it.
        setExpanded('ws-exp0', [roots[0]])
        await sleep(2000)
        return JSON.stringify({ ok: true, trail, expectOnDisk: roots[0] })
      })()`,
      true
    )) as string
    const info = JSON.parse(result) as { ok: boolean; trail?: string[]; expectOnDisk?: string }
    let persisted: string[] = []
    if (info.ok) {
      const file = join(app.getPath('userData'), 'workspaces.json')
      try {
        const doc = JSON.parse(readFileSync(file, 'utf8')) as {
          ui?: Record<string, { pluginState?: Record<string, { expandedDirs?: string[] }> }>
        }
        persisted = doc.ui?.['ws-exp0']?.pluginState?.[EXPLORER_PLUGIN_ID]?.expandedDirs ?? []
      } catch { /* reported below */ }
    }
    const ok = info.ok && persisted.length === 1 && persisted[0] === info.expectOnDisk
    console.log('[smoke:explorer]', JSON.stringify({ ...info, ok, persisted }))
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[smoke:explorer] threw:', err)
    app.exit(1)
  }
}

/**
 * The explorer's file operations, VS Code's. The right-click menus of a file, a folder and a
 * workspace folder; a click opening a file and leaving the keyboard in the tree; Rename in place,
 * refused while the name is taken, with the file's tab following it and a renamed folder staying
 * open; New File and New Folder in a name box, a nested name making its folders; Copy and Paste
 * making `a copy.ts` and `a copy 2.ts`; Cut and Paste moving, the tab following; a drag inside the
 * tree moving, and refusing to drop a folder into itself; unsaved files refused a rename and a move;
 * Delete from the keyboard asking first, landing on the next row and closing the deleted file's
 * tab; several deleted at once; Copy Path and Copy Relative Path; the arrows and Shift; and files
 * from outside copied in, with a name already taken asked about and a folder dropped on a
 * workspace folder asked whether it should join the workspace instead.
 *
 * A drop from Finder cannot be made from a script — a synthetic drag carries no paths — so that
 * part is driven through the command a drop sends, and the drag itself only as far as the folder
 * lighting up under it. The questions are answered through `askProbe`, never on screen. Nothing
 * reaches the real Trash unless RIGEE_SMOKE_TRASH=1: the trash question is answered Cancel, and
 * what is deleted is deleted for good, inside the throwaway data directory.
 *
 * With RIGEE_SHOT_DIR set it photographs the name box refusing a name, a cut row, a folder lit up
 * under a drag and a selection with the keyboard's row outlined, which are reviewed by looking.
 */
async function runFileOpsSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  const root = join(app.getPath('userData'), 'fileops')
  const repo = join(root, 'repo')
  const outside = join(root, 'outside')
  rmSync(root, { recursive: true, force: true })
  for (const dir of [join(repo, 'src'), join(repo, 'docs'), join(outside, 'dropped-dir')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 2\n')
  writeFileSync(join(repo, 'docs', 'readme.md'), '# readme\n')
  writeFileSync(join(repo, 'notes.txt'), 'hello\n')
  writeFileSync(join(outside, 'dropped.txt'), 'from outside\n')
  writeFileSync(join(outside, 'dropped-dir', 'inner.txt'), 'inner\n')

  const trail: string[] = []
  const asked: string[] = []
  /** The button to press for each question, in order. A question nobody planned for is cancelled. */
  const answers: string[] = []
  askProbe.answer = (options) => {
    asked.push(options.message)
    const want = answers.shift()
    const index = want === undefined ? -1 : (options.buttons ?? []).indexOf(want)
    return index >= 0 ? index : (options.cancelId ?? 0)
  }
  // Copy Path writes the user's clipboard. Put it back.
  const savedClipboard = await clipboard.readText()
  const finish = async (ok: boolean, stage: string, extra?: unknown): Promise<void> => {
    askProbe.answer = null
    await clipboard.writeText(savedClipboard)
    console.log('[smoke:fileops]', JSON.stringify({ ok, stage, trail, asked, ...(extra === undefined ? {} : { extra }) }))
    app.exit(ok ? 0 : 1)
  }
  const at = (...parts: string[]): string => join(repo, ...parts)
  /** The disk's word for it, rather than the tree's. */
  const onDisk = async (path: string, present: boolean, ms = 4000): Promise<boolean> => {
    for (let waited = 0; waited < ms && existsSync(path) !== present; waited += 100) {
      await new Promise((r) => setTimeout(r, 100))
    }
    return existsSync(path) === present
  }
  /** With RIGEE_SHOT_DIR set, a PNG of the window now, for reviewing by eye what a check cannot judge. */
  const shoot = async (name: string): Promise<void> => {
    const dir = process.env.RIGEE_SHOT_DIR
    if (!dir) return
    // Past the rows' background transition, or a row just selected is photographed half lit.
    await new Promise((r) => setTimeout(r, 300))
    writeFileSync(join(dir, `${name}.png`), (await wc.capturePage()).toPNG())
    trail.push(`photographed ${name}`)
  }
  const mac = process.platform === 'darwin'
  type Outcome = { ok: boolean; stage?: string } & Record<string, unknown>
  const stage = async (code: string): Promise<Outcome> =>
    (await wc.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const { store, menus } = window.__rigee
      const mac = ${mac}
      const p = ${JSON.stringify({
        repo,
        notes: at('notes.txt'),
        renamed: at('renamed.txt'),
        src: at('src'),
        docs: at('docs'),
        a: at('src', 'a.ts'),
        b: at('src', 'b.ts'),
        c: at('src', 'c.ts'),
        aCopy: at('src', 'a copy.ts'),
        aCopy2: at('src', 'a copy 2.ts'),
        lib: at('src', 'lib'),
        library: at('src', 'library'),
        deep: at('src', 'library', 'deep'),
        libDeep: at('src', 'lib', 'deep'),
        readme: at('docs', 'readme.md'),
        movedReadme: at('src', 'readme.md'),
        draggedB: at('docs', 'b.ts'),
        dropped: join(outside, 'dropped.txt'),
        droppedDir: join(outside, 'dropped-dir')
      })}
      const fail = (stage, extra) => Object.assign({ ok: false, stage }, extra || {})
      // React renders what a key or a click changed in a microtask, not before dispatchEvent returns.
      const settle = () => sleep(30)
      const until = async (test, ms = 6000) => {
        for (let waited = 0; waited < ms; waited += 50) { const v = test(); if (v) return v; await sleep(50) }
        return null
      }
      const body = () => document.querySelector('.explorer__body')
      const row = (path) => [...document.querySelectorAll('.explorer__body [data-path]')].find(el => el.dataset.path === path) || null
      const rows = () => [...document.querySelectorAll('.explorer__body [data-path]')].map(el => el.dataset.path)
      const key = (init, target) => {
        const e = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init))
        ;(target || body()).dispatchEvent(e)
        return e.defaultPrevented
      }
      // The platform's command key: Cmd on a Mac, Ctrl elsewhere.
      const cmd = (k, extra) => key(Object.assign({ key: k, code: 'Key' + k.toUpperCase() }, mac ? { metaKey: true } : { ctrlKey: true }, extra || {}))
      const enter = (target) => key({ key: 'Enter', code: 'Enter' }, target)
      const rename = () => key(mac ? { key: 'Enter', code: 'Enter' } : { key: 'F2', code: 'F2' })
      const trash = () => key(mac ? { key: 'Backspace', code: 'Backspace' } : { key: 'Delete', code: 'Delete' })
      const destroy = () => key(mac ? { key: 'Backspace', code: 'Backspace', metaKey: true, altKey: true } : { key: 'Delete', code: 'Delete', shiftKey: true })
      // A click gives the tree the keyboard first, as the mousedown before a real one does.
      const click = (el, init) => { body().focus(); el.dispatchEvent(new MouseEvent('click', Object.assign({ bubbles: true, cancelable: true }, init || {}))) }
      const menu = async (el, pick) => {
        let offered = null
        menus.answer = (items) => { offered = items; return pick }
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
        await until(() => offered)
        menus.answer = null
        return offered
      }
      const type = (el, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const box = () => document.querySelector('.explorer__input')
      const problem = () => document.querySelector('.explorer__problem')?.textContent ?? null
      const selected = () => [...document.querySelectorAll('.explorer__row--selected')].map(el => el.dataset.path)
      const focusedRow = () => document.querySelector('.explorer__row--focused')?.dataset.path ?? null
      const tabs = () => Object.values(store.getState().rowsByWorkspace).flatMap(r => r.groups.flatMap(g => g.tabs)).filter(t => t.kind === 'editor')
      const tabOf = (path) => tabs().find(t => t.filePath === path) || null
      const drag = (from, over, init) => {
        const dataTransfer = new DataTransfer()
        const fire = (el, type) => {
          const e = new DragEvent(type, Object.assign({ bubbles: true, cancelable: true, dataTransfer }, init || {}))
          el.dispatchEvent(e)
          return e.defaultPrevented
        }
        fire(from, 'dragstart')
        const accepted = fire(over, 'dragover')
        return { accepted, drop: () => fire(over, 'drop'), cancel: () => fire(body(), 'dragend') }
      }
      ${code}
    })()`, true)) as Outcome

  try {
    // --- the workspace ------------------------------------------------------------------
    const ready = await stage(`
      if (!(await until(() => store.getState().ready, 15000))) return fail('never-ready')
      store.getState().addWorkspace({
        id: 'ws-fileops', name: 'fileops', createdAt: Date.now(), lastOpenedAt: Date.now(),
        folders: [{ path: p.repo, name: 'repo', isGitRepo: false, repoRoot: null }]
      })
      store.getState().setActiveWorkspace('ws-fileops')
      return (await until(() => row(p.notes))) ? { ok: true } : fail('the-tree-never-showed-the-repo')`)
    if (!ready.ok) return finish(false, ready.stage ?? 'workspace')

    // --- the menus ----------------------------------------------------------------------
    const offered = await stage(`
      const labels = (items) => items.map(i => i.kind === 'separator' ? '—'
        : i.label + (i.accelerator ? ' [' + i.accelerator + ']' : '') + (i.enabled === false ? ' (off)' : ''))
      return { ok: true,
        file: labels(await menu(row(p.notes), null)),
        folder: labels(await menu(row(p.src), null)),
        root: labels(await menu(row(p.repo), null)) }`)
    const file = (offered.file ?? []) as string[]
    const folder = (offered.folder ?? []) as string[]
    const top = (offered.root ?? []) as string[]
    trail.push(`a file's menu: ${file.join(' | ')}`)
    trail.push(`a folder's menu starts: ${folder.slice(0, 3).join(' | ')}; a workspace folder's: ${top.join(' | ')}`)
    const has = (menu: string[], label: string): boolean => menu.some((l) => l.startsWith(label))
    for (const label of ['Reveal in', 'Open in Terminal Tab', 'Open in Terminal Split', 'Cut [CmdOrCtrl+X]', 'Copy [CmdOrCtrl+C]', 'Paste [CmdOrCtrl+V] (off)', 'Copy Path', 'Copy Relative Path', 'Rename…', 'Delete [']) {
      if (!has(file, label)) return finish(false, 'file-menu-lacks', label)
    }
    if (has(file, 'New File')) return finish(false, 'file-menu-offers-new-file')
    if (folder[0] !== 'New File…' || folder[1] !== 'New Folder…') return finish(false, 'folder-menu-does-not-start-with-new', folder)
    if (!has(top, 'New File…') || !has(top, 'Paste') || !has(top, 'Copy Path')) return finish(false, 'workspace-folder-menu-lacks-its-items', top)
    if (['Cut', 'Rename…', 'Delete', 'Copy Relative Path'].some((label) => has(top, label))) return finish(false, 'workspace-folder-can-be-cut-renamed-or-deleted', top)

    // --- a click opens a file and leaves the keyboard here ---------------------------------
    const clicked = await stage(`
      click(row(p.notes))
      if (!(await until(() => tabOf(p.notes)))) return fail('a-click-opened-no-tab')
      if (!(await until(() => document.querySelector('.monaco-editor'), 15000))) return fail('the-editor-never-came-up')
      await sleep(600)
      if (document.activeElement !== body()) return fail('the-editor-took-the-keyboard-from-the-tree', { focused: document.activeElement?.className })
      return selected().join() === p.notes ? { ok: true } : fail('the-clicked-row-is-not-selected', { selected: selected() })`)
    if (!clicked.ok) return finish(false, clicked.stage ?? 'click', clicked)
    trail.push('a click opened notes.txt in the editor and left the keyboard in the tree')

    // --- Rename -----------------------------------------------------------------------------
    const renaming = await stage(`
      rename()
      const input = await until(box)
      if (!input) return fail('no-name-box')
      if (document.activeElement !== input) return fail('the-name-box-does-not-have-the-keyboard')
      const picked = [input.selectionStart, input.selectionEnd].join('-')
      type(input, 'src')
      await settle()
      const refused = problem()
      enter(input)
      await sleep(300)
      return box() ? { ok: true, picked, refused } : fail('enter-on-a-taken-name-closed-the-box')`)
    if (!renaming.ok) return finish(false, renaming.stage ?? 'rename', renaming)
    await shoot('fileops-name-refused')
    const renamed = await stage(`
      type(box(), 'renamed.txt')
      enter(box())
      if (!(await until(() => !box() && row(p.renamed)))) return fail('the-renamed-row-never-appeared', { problem: problem() })
      const tab = tabOf(p.renamed)
      if (!tab || tab.title !== 'renamed.txt' || tabOf(p.notes)) return fail('the-tab-did-not-follow-the-rename', { tabs: tabs().map(t => t.filePath) })
      if (document.activeElement !== body()) return fail('the-keyboard-did-not-come-back-to-the-tree')
      return { ok: true, picked: ${JSON.stringify(renaming.picked)}, refused: ${JSON.stringify(renaming.refused)} }`)
    if (!renamed.ok) return finish(false, renamed.stage ?? 'rename', renamed)
    if (renamed.picked !== '0-5') return finish(false, 'rename-did-not-select-the-name-without-its-extension', renamed.picked)
    if (!String(renamed.refused).includes('already exists')) return finish(false, 'a-taken-name-was-not-refused', renamed.refused)
    if (!(await onDisk(at('notes.txt'), false)) || !(await onDisk(at('renamed.txt'), true))) return finish(false, 'rename-did-not-reach-the-disk')
    trail.push(`Rename picked the name up to its extension, refused "src" (${renamed.refused}), and the tab followed renamed.txt`)

    // --- New File, New Folder ---------------------------------------------------------------
    const made = await stage(`
      await menu(row(p.src), 'new-file')
      const input = await until(box)
      if (!input) return fail('no-new-file-box')
      // The folder has just opened; what is taken in it is known once its listing is in.
      if (!(await until(() => row(p.a)))) return fail('src-never-listed')
      type(input, 'a.ts')
      await settle()
      const refused = problem()
      type(input, 'c.ts')
      enter(input)
      if (!(await until(() => row(p.c)))) return fail('the-new-file-never-appeared', { problem: problem() })
      if (!(await until(() => tabOf(p.c)))) return fail('the-new-file-did-not-open')
      if (selected().join() !== p.c) return fail('the-new-file-is-not-selected', { selected: selected() })
      // The header's New Folder lands in the folder of the row the keyboard is on.
      body().focus()
      document.querySelector('.section-header button[title="New Folder…"]').click()
      const folderBox = await until(box)
      if (!folderBox) return fail('no-new-folder-box')
      type(folderBox, 'lib/deep')
      enter(folderBox)
      if (!(await until(() => row(p.libDeep)))) return fail('the-nested-folder-is-not-in-sight', { rows: rows() })
      // A folder renamed while open stays open under its new name.
      await menu(row(p.lib), 'rename')
      const libBox = await until(box)
      if (!libBox) return fail('no-folder-rename-box')
      type(libBox, 'library')
      enter(libBox)
      if (!(await until(() => row(p.deep)))) return fail('the-renamed-folder-did-not-stay-open', { rows: rows() })
      return { ok: true, refused }`)
    if (!made.ok) return finish(false, made.stage ?? 'new', made)
    if (!String(made.refused).includes('already exists')) return finish(false, 'new-file-took-a-taken-name', made.refused)
    if (!(await onDisk(at('src', 'c.ts'), true)) || !statSync(at('src', 'library', 'deep')).isDirectory()) return finish(false, 'new-entries-not-on-disk')
    trail.push('New File refused a.ts and made c.ts, opened; New Folder made lib/deep from the header; lib renamed to library stayed open')

    // --- Copy and Paste, Cut and Paste ------------------------------------------------------
    const pasted = await stage(`
      click(row(p.a))
      cmd('c')
      cmd('v')
      if (!(await until(() => row(p.aCopy) && selected().join() === p.aCopy))) return fail('paste-made-no-copy', { rows: rows() })
      cmd('v')
      if (!(await until(() => row(p.aCopy2)))) return fail('a-second-paste-made-no-second-copy', { rows: rows() })
      click(row(p.docs))
      if (!(await until(() => row(p.readme)))) return fail('docs-did-not-open')
      click(row(p.readme))
      await until(() => tabOf(p.readme))
      cmd('x')
      await settle()
      if (!row(p.readme).classList.contains('explorer__row--cut')) return fail('a-cut-row-is-not-faded')
      return { ok: true }`)
    if (!pasted.ok) return finish(false, pasted.stage ?? 'paste', pasted)
    await shoot('fileops-cut')
    const moved = await stage(`
      click(row(p.b))
      cmd('v')
      if (!(await until(() => row(p.movedReadme) && !row(p.readme)))) return fail('cut-and-paste-moved-nothing', { rows: rows() })
      if (document.querySelector('.explorer__row--cut')) return fail('the-cut-outlived-its-paste')
      if (!tabOf(p.movedReadme) || tabOf(p.readme)) return fail('the-tab-did-not-follow-the-move', { tabs: tabs().map(t => t.filePath) })
      return { ok: true }`)
    if (!moved.ok) return finish(false, moved.stage ?? 'move', moved)
    if (!(await onDisk(at('src', 'a copy.ts'), true)) || !(await onDisk(at('src', 'a copy 2.ts'), true))) return finish(false, 'copies-not-on-disk')
    if (!(await onDisk(at('docs', 'readme.md'), false)) || !(await onDisk(at('src', 'readme.md'), true))) return finish(false, 'move-not-on-disk')
    trail.push('Copy and Paste made "a copy.ts" then "a copy 2.ts"; Cut faded readme.md and Paste moved it into src, its tab following')

    // --- dragging inside the tree ------------------------------------------------------------
    const dragged = await stage(`
      const intoItself = drag(row(p.src), row(p.library))
      intoItself.cancel()
      if (intoItself.accepted) return fail('a-folder-would-drop-into-itself')
      const nowhere = drag(row(p.a), row(p.src))
      nowhere.cancel()
      if (nowhere.accepted) return fail('a-move-into-its-own-folder-was-offered')
      const copyHere = drag(row(p.a), row(p.src), mac ? { altKey: true } : { ctrlKey: true })
      copyHere.cancel()
      if (!copyHere.accepted) return fail('a-copy-into-its-own-folder-was-refused')
      const move = drag(row(p.b), row(p.docs))
      await settle()
      if (!move.accepted || !row(p.docs).classList.contains('explorer__row--drop')) return fail('a-drag-onto-a-folder-was-not-offered-or-not-lit', move)
      window.__fileopsDrag = move
      return { ok: true }`)
    if (!dragged.ok) return finish(false, dragged.stage ?? 'drag', dragged)
    await shoot('fileops-drop')
    const dropped = await stage(`
      window.__fileopsDrag.drop()
      if (!(await until(() => row(p.draggedB) && !row(p.b)))) return fail('the-drop-moved-nothing', { rows: rows() })
      if (document.querySelector('.explorer__row--drop')) return fail('the-drop-left-the-folder-lit')
      return { ok: true }`)
    if (!dropped.ok) return finish(false, dropped.stage ?? 'drop', dropped)
    if (!(await onDisk(at('docs', 'b.ts'), true)) || !(await onDisk(at('src', 'b.ts'), false))) return finish(false, 'drag-not-on-disk')
    trail.push('a drag moved b.ts into docs; a folder into itself and a move into its own folder were refused, a copy there offered')

    // --- unsaved changes ----------------------------------------------------------------------
    answers.push('OK')
    const unsaved = await stage(`
      store.setState({ dirtyFiles: { [p.a]: true } })
      click(row(p.a))
      rename()
      const input = await until(box)
      if (!input) return fail('no-name-box')
      type(input, 'z.ts')
      enter(input)
      const refused = await until(() => problem())
      key({ key: 'Escape', code: 'Escape' }, box())
      cmd('x')
      click(row(p.draggedB))
      cmd('v')
      await sleep(600)
      const stayed = !!row(p.a)
      key({ key: 'Escape', code: 'Escape' })
      store.setState({ dirtyFiles: {} })
      await settle()
      return { ok: true, refused, stayed, faded: !!document.querySelector('.explorer__row--cut') }`)
    if (!String(unsaved.refused).includes('unsaved changes')) return finish(false, 'an-unsaved-file-was-renamed', unsaved)
    if (!unsaved.stayed || !asked.some((q) => q.includes('has unsaved changes'))) return finish(false, 'an-unsaved-file-was-moved', unsaved)
    if (unsaved.faded) return finish(false, 'escape-did-not-drop-the-cut')
    if (!existsSync(at('src', 'a.ts'))) return finish(false, 'the-unsaved-file-left-its-folder')
    trail.push(`an unsaved a.ts was refused a rename (${unsaved.refused}) and a move; Escape let go of the cut`)

    // --- Delete -----------------------------------------------------------------------------------
    answers.push('Cancel')
    const kept = await stage(`
      click(row(p.aCopy2))
      if (!trash()) return fail('delete-was-not-the-trees')
      await sleep(400)
      return row(p.aCopy2) ? { ok: true } : fail('cancel-deleted-it-anyway')`)
    if (!kept.ok) return finish(false, kept.stage ?? 'cancel', kept)
    if (!asked.some((q) => q === 'Are you sure you want to delete “a copy 2.ts”?')) return finish(false, 'delete-did-not-ask', asked)
    if (!existsSync(at('src', 'a copy 2.ts'))) return finish(false, 'cancel-deleted-it-anyway')

    answers.push('Delete')
    const gone = await stage(`
      const order = rows()
      const next = order[order.indexOf(p.aCopy2) + 1]
      destroy()
      if (!(await until(() => !row(p.aCopy2)))) return fail('permanent-delete-left-the-row')
      return (await until(() => focusedRow() === next)) ? { ok: true, next } : fail('the-keyboard-did-not-land-on-the-next-row', { focused: focusedRow(), next })`)
    if (!gone.ok) return finish(false, gone.stage ?? 'delete', gone)
    if (!asked.some((q) => q.startsWith('Are you sure you want to permanently delete “a copy 2.ts”'))) return finish(false, 'permanent-delete-did-not-ask', asked)
    if (!(await onDisk(at('src', 'a copy 2.ts'), false))) return finish(false, 'permanent-delete-not-on-disk')

    answers.push('Delete', 'Delete')
    const closed = await stage(`
      row(p.draggedB).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      if (!(await until(() => tabOf(p.draggedB)))) return fail('a-double-click-opened-nothing')
      click(row(p.draggedB))
      destroy()
      if (!(await until(() => !row(p.draggedB) && !tabOf(p.draggedB)))) return fail('the-deleted-files-tab-stayed', { tabs: tabs().map(t => t.filePath) })
      click(row(p.aCopy))
      click(row(p.c), mac ? { metaKey: true } : { ctrlKey: true })
      await settle()
      if (selected().length !== 2) return fail('cmd-click-did-not-add-to-the-selection', { selected: selected() })
      destroy()
      if (!(await until(() => !row(p.aCopy) && !row(p.c)))) return fail('deleting-two-left-one', { rows: rows() })
      return tabOf(p.c) ? fail('the-tab-of-one-of-the-two-stayed') : { ok: true }`)
    if (!closed.ok) return finish(false, closed.stage ?? 'delete-open', closed)
    if (!asked.some((q) => q.includes('these 2 items'))) return finish(false, 'deleting-two-did-not-say-so', asked)
    if (!(await onDisk(at('docs', 'b.ts'), false)) || !(await onDisk(at('src', 'c.ts'), false))) return finish(false, 'deletions-not-on-disk')
    trail.push('Delete asked, kept the file on Cancel, deleted it for good on Delete and moved to the next row; a deleted open file lost its tab; two went at once')

    if (process.env.RIGEE_SMOKE_TRASH === '1') {
      writeFileSync(at('src', 'rigee-smoke-trash.txt'), 'to the Trash\n')
      answers.push(process.platform === 'win32' ? 'Move to Recycle Bin' : 'Move to Trash')
      const trashed = await stage(`
        const path = ${JSON.stringify(at('src', 'rigee-smoke-trash.txt'))}
        if (!(await until(() => row(path)))) return fail('the-file-for-the-trash-never-appeared')
        click(row(path))
        trash()
        return (await until(() => !row(path))) ? { ok: true } : fail('the-trashed-row-stayed')`)
      if (!trashed.ok || !(await onDisk(at('src', 'rigee-smoke-trash.txt'), false))) return finish(false, trashed.stage ?? 'trash')
      trail.push('a file went to the real Trash')
    }

    // --- Copy Path, Copy Relative Path ------------------------------------------------------------
    await stage(`await menu(row(p.a), 'copy-path'); await sleep(300); return { ok: true }`)
    const copiedPath = await clipboard.readText()
    await stage(`await menu(row(p.a), 'copy-relative-path'); await sleep(300); return { ok: true }`)
    const copiedRelative = await clipboard.readText()
    if (copiedPath !== at('src', 'a.ts') || copiedRelative !== join('src', 'a.ts')) {
      return finish(false, 'copy-path-copied-the-wrong-thing', { copiedPath, copiedRelative })
    }
    trail.push(`Copy Path gave ${copiedPath}, Copy Relative Path ${copiedRelative}`)

    // --- the arrows -------------------------------------------------------------------------------
    const walked = await stage(`
      click(row(p.a))
      const order = rows()
      const i = order.indexOf(p.a)
      key({ key: 'ArrowDown', code: 'ArrowDown' })
      await settle()
      if (focusedRow() !== order[i + 1]) return fail('arrow-down-did-not-move', { focused: focusedRow() })
      key({ key: 'ArrowUp', code: 'ArrowUp', shiftKey: true })
      key({ key: 'ArrowUp', code: 'ArrowUp', shiftKey: true })
      await settle()
      if (selected().length !== 3 || focusedRow() !== order[i - 1]) return fail('shift-arrows-did-not-extend', { selected: selected(), focused: focusedRow() })
      return { ok: true, count: order.length }`)
    if (!walked.ok) return finish(false, walked.stage ?? 'arrows', walked)
    await shoot('fileops-selection')
    const everything = await stage(`
      const order = rows()
      cmd('a')
      await settle()
      if (selected().length !== order.length) return fail('select-all-missed-rows')
      key({ key: 'Escape', code: 'Escape' })
      await settle()
      return selected().length === 1 ? { ok: true } : fail('escape-did-not-narrow-the-selection')`)
    if (!everything.ok) return finish(false, everything.stage ?? 'select-all', everything)
    trail.push('the arrows walked the rows, Shift extended the selection, Cmd+A took everything and Escape let go of it')

    // --- from outside -------------------------------------------------------------------------------
    // The drag, as far as a script can take it: a file from outside lights up the folder under it.
    const lit = await stage(`
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(new File(['x'], 'from-finder.txt'))
      const e = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer })
      row(p.a).dispatchEvent(e)
      await settle()
      const lit = row(p.src).classList.contains('explorer__row--drop') && row(p.a).classList.contains('explorer__row--drop')
      return { ok: e.defaultPrevented && lit, accepted: e.defaultPrevented, lit }`)
    if (!lit.ok) return finish(false, 'a-file-from-outside-was-not-offered-a-folder', lit)
    await shoot('fileops-drop-from-outside')
    await stage(`
      body().dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }))
      await settle()
      return document.querySelector('.explorer__row--drop') ? fail('leaving-left-the-folder-lit') : { ok: true }`)
    const invoke = async (payload: unknown): Promise<Outcome> =>
      stage(`return { ok: true, result: await window.rigee.invoke('plugin:invoke', { command: 'explorer:transfer', payload: ${JSON.stringify(payload)} }) }`)
    await invoke({ sources: [join(outside, 'dropped.txt')], target: at('src'), mode: 'copy', external: true })
    if (!(await onDisk(at('src', 'dropped.txt'), true))) return finish(false, 'a-file-from-outside-was-not-copied')
    answers.push('Cancel')
    const clash = await invoke({ sources: [join(outside, 'dropped.txt')], target: at('src'), mode: 'copy', external: true })
    if (!asked.some((q) => q === '“dropped.txt” already exists in “src”. Replace it?')) return finish(false, 'a-taken-name-from-outside-was-not-asked-about', asked)
    if ((clash.result as { done: unknown[] }).done.length !== 0) return finish(false, 'cancel-copied-it-anyway')
    answers.push('Copy Folder')
    await invoke({ sources: [join(outside, 'dropped-dir')], target: repo, mode: 'copy', external: true, intoRoot: true })
    if (!(await onDisk(at('dropped-dir', 'inner.txt'), true))) return finish(false, 'copy-folder-did-not-copy-it')
    answers.push('Add Folder to Workspace')
    const joined = await invoke({ sources: [join(outside, 'dropped-dir')], target: repo, mode: 'copy', external: true, intoRoot: true })
    const add = (joined.result as { addToWorkspace?: string[] }).addToWorkspace
    if (add?.[0] !== join(outside, 'dropped-dir')) return finish(false, 'add-to-workspace-was-not-the-answer', joined)
    if (!asked.some((q) => q === 'Add “dropped-dir” to the workspace, or copy it into “repo”?')) return finish(false, 'a-folder-on-a-workspace-folder-was-not-asked-about', asked)
    trail.push('from outside: a drag lit the folder under it; a file was copied in, a taken name asked about, and a folder on a workspace folder offered Add or Copy')

    return finish(true, 'done')
  } catch (err) {
    console.error('[smoke:fileops] threw:', err)
    return finish(false, 'threw', String(err))
  }
}

/**
 * Both side panels stay inside the window once they are full, and the explorer collapses.
 *
 * Written while chasing "source control has no scrollbar". It turned out both panels always did
 * scroll — the thumb was 8% white and simply invisible — so what this guards is the surrounding
 * claim rather than the one reported: that the panes remain clipped to the window and that their
 * scroll containers really are scroll containers. Worth keeping, because a short list looks
 * correct under any layout and only a full one can tell the difference. Hence RIGEE_SMOKE_REPO.
 *
 * Note it asserts on the CONTAINERS, not the rows. Rows below the fold legitimately have bottoms
 * past the window — that is what scrolling is — and an assertion on row geometry would only hold
 * while the panel was broken.
 */
async function runScrollSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  const repo = process.env.RIGEE_SMOKE_REPO
  if (!repo) { console.error('[smoke:scroll] set RIGEE_SMOKE_REPO'); app.exit(1); return }
  try {
    const result = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store } = window.__rigee
        const trail = []
        const fail = (stage, extra) =>
          JSON.stringify(Object.assign({ ok: false, stage, trail }, extra || {}))

        for (let i = 0; i < 60; i++) {
          if (store.getState().ready) break
          await sleep(250)
        }
        store.getState().addWorkspace({
          id: 'ws-scroll', name: 'scroll', createdAt: Date.now(), lastOpenedAt: Date.now(),
          folders: [{ path: ${JSON.stringify(repo)}, name: 'scroll',
                      isGitRepo: true, repoRoot: ${JSON.stringify(repo)} }]
        })
        // Long enough for the status read and the explorer's first directory listing.
        await sleep(4000)

        const bottom = (el) => Math.round(el.getBoundingClientRect().bottom)
        const lastRowBottom = (root) => {
          const rows = [...root.querySelectorAll('.row')]
          return rows.length ? bottom(rows[rows.length - 1]) : 0
        }
        const panes = document.querySelectorAll('.pane')
        const [left, right] = [panes[0], panes[1]]
        const shell = document.querySelector('.shell')
        const limit = bottom(shell)

        // Positional, and only correct while the editor groups stay .group. A group matched here
        // would be measured as the source control panel, and every assertion below would be
        // reporting on the centre of the window instead.
        if (!right || right.querySelector('.tabstrip')) return fail('an-editor-group-matched-.pane')

        trail.push('window bottom: ' + limit)
        // Kept as measurements: on the broken layout the PANE bottoms matched these, which is
        // how the bug was identified in the first place.
        trail.push('explorer last row bottom: ' + lastRowBottom(left) + ' (pane ' + bottom(left) + ')')
        trail.push('scm last row bottom: ' + lastRowBottom(right) + ' (pane ' + bottom(right) + ')')

        // Find whatever element actually contains the rows, old shape or new.
        const containerOf = (root) => {
          const rows = [...root.querySelectorAll('.row')]
          if (!rows.length) return null
          let el = rows[rows.length - 1].parentElement
          while (el && el !== root) {
            const st = getComputedStyle(el)
            if (st.overflowY === 'auto' || st.overflowY === 'scroll') return el
            el = el.parentElement
          }
          return null
        }
        const scm = containerOf(right)
        const exp = containerOf(left)
        trail.push('scm container: ' + (scm ? scm.className || scm.tagName : 'NONE — nothing clips the list'))
        trail.push('exp container: ' + (exp ? exp.className || exp.tagName : 'NONE — nothing clips the list'))
        if (!scm) return fail('source-control-has-no-scroll-container')
        if (!exp) return fail('explorer-has-no-scroll-container')
        trail.push('scm rows ' + scm.querySelectorAll('.row').length +
          ', scrollHeight/clientHeight ' + scm.scrollHeight + '/' + scm.clientHeight)
        trail.push('explorer rows ' + exp.querySelectorAll('.row').length +
          ', scrollHeight/clientHeight ' + exp.scrollHeight + '/' + exp.clientHeight)

        // A fixture that does not overflow would make every assertion below vacuous.
        if (scm.scrollHeight <= scm.clientHeight + 2) return fail('scm-fixture-too-small')
        if (exp.scrollHeight <= exp.clientHeight + 2) return fail('explorer-fixture-too-small')

        if (getComputedStyle(scm).overflowY !== 'auto') return fail('scm-does-not-scroll')
        if (getComputedStyle(exp).overflowY !== 'auto') return fail('explorer-does-not-scroll')
        // The panes and their scroll containers must fit. Individual ROWS legitimately extend
        // past the fold once scrolling works — that is what a scroll container is — so asserting
        // on row geometry would only be correct while the bug was present.
        if (bottom(left) > limit + 2) return fail('left-pane-runs-past-the-window')
        if (bottom(right) > limit + 2) return fail('right-pane-runs-past-the-window')
        if (bottom(exp) > limit + 2) return fail('explorer-body-runs-past-the-window')
        if (bottom(scm) > limit + 2) return fail('scm-body-runs-past-the-window')

        // Collapse all closes the roots and everything under them.
        const before = exp.querySelectorAll('.row').length
        const btn = [...document.querySelectorAll('.section-header .icon-button')]
          .find(b => b.title === 'Collapse all folders')
        if (!btn) return fail('no-collapse-all-button')
        btn.click()
        await sleep(400)
        const after = exp.querySelectorAll('.row').length
        trail.push('explorer rows before/after collapse: ' + before + '/' + after)
        if (after !== 1) return fail('collapse-all-should-leave-only-the-root', { before, after })

        return JSON.stringify({ ok: true, trail })
      })()`,
      true
    )) as string
    console.log('[smoke:scroll]', result)
    app.exit(JSON.parse(result).ok ? 0 : 1)
  } catch (err) {
    console.error('[smoke:scroll] threw:', err)
    app.exit(1)
  }
}

/**
 * End-to-end check that Scratch stays reachable once real workspaces exist.
 *
 * Scratch is the workspace with no folders — somewhere to open a terminal and decide the directory
 * yourself — so being able to get back to it after opening a project is the whole point of it.
 */
async function runScratchSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  try {
    const result = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store, newTerminalTab } = window.__rigee
        const trail = []
        const st = () => store.getState()

        for (let i = 0; i < 60; i++) {
          if (st().ready && st().workspaces.some(w => w.id === '__scratch__')) break
          await sleep(250)
        }
        const fail = (stage, extra) =>
          JSON.stringify(Object.assign({ ok: false, stage, trail }, extra || {}))

        const editorTab = (id) => ({ id, kind: 'editor', title: id, pinned: false,
          filePath: '/' + id + '.ts', repoId: null, readOnly: false })
        const tabsOf = (ws) => {
          const row = st().rowsByWorkspace[ws]
          return row ? row.groups.reduce((all, g) => all.concat(g.tabs), []) : []
        }
        // EVERY strip, joined. One group's strip would answer "what is in the left column", and a
        // tab that opened in another column would read as the centre not having changed at all.
        const stripText = () =>
          [...document.querySelectorAll('.tabstrip')].map(s => s.textContent || '').join(' | ')

        trail.push('workspaces at boot: ' + st().workspaces.map(w => w.id).join(','))
        if (!st().workspaces.some(w => w.id === '__scratch__')) return fail('no-scratch-at-boot')

        // Open a real workspace, the way picking a folder would.
        store.getState().addWorkspace({
          id: 'ws-probe', name: 'probe', folders: [{ path: '/tmp', name: 'tmp', isGitRepo: false, repoRoot: null }],
          createdAt: Date.now(), lastOpenedAt: Date.now()
        })
        await sleep(400)
        trail.push('after addWorkspace active=' + st().activeWorkspaceId)
        trail.push('workspaces now: ' + st().workspaces.map(w => w.id).join(','))

        const rows = [...document.querySelectorAll('.row--clickable')]
        trail.push('sidebar rows: ' + rows.map(r => (r.querySelector('.row__label')||{}).textContent).join(' | '))
        const scratchRow = rows.find(r => ((r.querySelector('.row__label')||{}).textContent || '') === 'Scratch')
        if (!scratchRow) return fail('scratch-row-not-rendered')

        scratchRow.click()
        await sleep(500)
        trail.push('after clicking Scratch active=' + st().activeWorkspaceId)
        if (st().activeWorkspaceId !== '__scratch__') return fail('click-did-not-switch')

        trail.push('row marked selected: ' + scratchRow.className.includes('row--selected'))
        trail.push('centre shows: ' + JSON.stringify(stripText().slice(0, 40)))

        // And a terminal must actually open there.
        store.getState().openTab('__scratch__', newTerminalTab())
        await sleep(1500)
        trail.push('scratch tabs: ' + tabsOf('__scratch__').length)
        const panes = document.querySelectorAll('.term__pane').length
        trail.push('rendered terminal panes: ' + panes)
        if (panes < 1) return fail('no-terminal-in-scratch')

        // Switching workspaces must actually change what the centre shows. Asserted on the
        // rendered tab strip rather than on store state, because "the middle does not change"
        // is a claim about pixels, not about a variable.
        store.getState().setActiveWorkspace('ws-probe')
        store.getState().openTab('ws-probe', editorTab('probe-only-file'))
        await sleep(600)
        const onProbe = stripText()
        scratchRow.click()
        await sleep(600)
        const onScratch = stripText()
        trail.push('tabstrip on ws-probe: ' + JSON.stringify(onProbe.slice(0, 50)))
        trail.push('tabstrip on scratch:  ' + JSON.stringify(onScratch.slice(0, 50)))
        if (onProbe === onScratch) return fail('centre-did-not-change-between-workspaces')
        if (!onProbe.includes('probe-only-file')) return fail('other-workspace-tabs-not-shown')
        if (onScratch.includes('probe-only-file')) return fail('scratch-shows-other-workspace-tabs')

        // The case where "nothing happened" would be literally true: a browser tab in the other
        // workspace is a native view composited OVER the whole page, so if leaving the workspace
        // does not hide it the screen simply does not change.
        store.getState().setActiveWorkspace('ws-probe')
        store.getState().openTab('ws-probe', {
          id: 'scratch-probe-browser', kind: 'custom', viewType: 'browser.page',
          title: 'probe', pinned: false, state: { url: 'about:blank' }
        })
        await sleep(1800)
        trail.push('browser tab open in ws-probe')
        scratchRow.click()
        await sleep(800)
        trail.push('back on scratch, active=' + st().activeWorkspaceId)

        return JSON.stringify({ ok: true, trail })
      })()`,
      true
    )) as string
    const info = JSON.parse(result) as { ok: boolean; trail?: string[] }
    // Asked in main, because only main knows what is actually composited over the window. The
    // browser plugin exposes it as a command precisely so this check did not have to survive the
    // feature moving out of the shell.
    const stillVisible = pluginHost
      ? ((await pluginHost.invoke('browser:visibleIds', {})) as string[])
      : []

    // And the workspace must still be on disk. A workspace that vanishes across a restart looks
    // exactly like "clicking workspaces does nothing": there is nothing left to click.
    await new Promise((r) => setTimeout(r, 2500))
    const file = join(app.getPath('userData'), 'workspaces.json')
    let persistedIds: string[] = []
    try {
      persistedIds = (JSON.parse(readFileSync(file, 'utf8')) as { workspaces?: { id: string }[] })
        .workspaces?.map((w) => w.id) ?? []
    } catch { /* reported as an empty list below */ }

    const ok = info.ok && stillVisible.length === 0 && persistedIds.includes('ws-probe')
    console.log('[smoke:scratch]', JSON.stringify({
      ...info,
      ok,
      browserViewsStillVisibleOnScratch: stillVisible
    }))
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[smoke:scratch] threw:', err)
    app.exit(1)
  }
}

/**
 * Output stays reachable while a program owns the mouse.
 *
 * Run claude, vim, htop or tmux and it turns on mouse reporting; from then on xterm hands every
 * drag to the program rather than selecting with it. Correct — the program asked for the mouse —
 * but it also means nothing on screen can be selected, and a terminal whose output cannot be
 * copied is not much of a terminal.
 *
 * WHAT THIS DOES NOT COVER: the Option-drag itself. Synthetic MouseEvents do not drive xterm's
 * selection service here — a plain drag with no mouse reporting at all selects nothing either, so
 * the harness, not the feature, is what fails. Rather than assert something that would pass
 * whatever the setting was, this checks the three things it genuinely can: that writing the real
 * DECSET sequences puts the terminal into mouse-reporting mode, that the live Terminal really
 * carries macOptionClickForcesSelection, and that Select All still works once a program holds the
 * mouse — that last being the menu's escape hatch and the part with no modifier to remember.
 * Option-drag was confirmed by hand.
 */
async function runMouseSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  try {
    const result = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store, newTerminalTab, getTerminal, paneKey } = window.__rigee
        const trail = []
        const fail = (stage, extra) =>
          JSON.stringify(Object.assign({ ok: false, stage, trail }, extra || {}))

        let scratch = null
        for (let i = 0; i < 60; i++) {
          scratch = store.getState().workspaces.find(w => w.id === '__scratch__')
          if (scratch && store.getState().ready) break
          await sleep(250)
        }
        if (!scratch) return fail('no-scratch')
        store.getState().setActiveWorkspace(scratch.id)

        const tab = newTerminalTab()
        store.getState().openTab(scratch.id, tab)
        let handle = null
        for (let i = 0; i < 60; i++) {
          await sleep(250)
          const row = store.getState().rowsByWorkspace[scratch.id]
          const t = row && row.groups.flatMap(g => g.tabs).find(x => x.id === tab.id)
          if (t) handle = getTerminal(paneKey(tab.id, t.activeLeafId))
          if (handle) break
        }
        if (!handle) return fail('no-terminal')
        const term = handle.term

        term.write('SELECTME-ABCDEFGHIJ-0123456789\\r\\n')
        await sleep(500)

        // The scenario: exactly what a full-screen program sends — button+drag tracking, SGR.
        term.write('\\x1b[?1002h\\x1b[?1006h')
        await sleep(400)
        trail.push('mouseTrackingMode: ' + term.modes.mouseTrackingMode)
        if (term.modes.mouseTrackingMode === 'none') return fail('mouse-reporting-did-not-engage')

        // The setting has to be on the live Terminal, not merely in the source.
        trail.push('macOptionClickForcesSelection: ' + term.options.macOptionClickForcesSelection)
        if (term.options.macOptionClickForcesSelection !== true) {
          return fail('option-drag-selection-not-enabled')
        }

        // Select All works regardless of what the program did with the mouse.
        term.clearSelection()
        await sleep(60)
        term.selectAll()
        if (!term.getSelection().includes('SELECTME')) return fail('select-all-does-not-work')
        trail.push('select all works')

        return JSON.stringify({ ok: true, trail })
      })()`,
      true
    )) as string
    console.log('[smoke:mouse]', result)
    app.exit(JSON.parse(result).ok ? 0 : 1)
  } catch (err) {
    console.error('[smoke:mouse] threw:', err)
    app.exit(1)
  }
}

/**
 * End-to-end check that a terminal selection can be copied and the clipboard pasted back.
 *
 * xterm.js deliberately ships no copy or paste bindings — it hands you `getSelection()` and
 * `paste()` and leaves the policy to the host — so this is entirely our own wiring and worth
 * holding down. Driven through a real keydown on xterm's textarea, which is where
 * attachCustomKeyEventHandler actually runs, and read back through the OS clipboard rather than
 * anything we control.
 */
async function runCopySmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  // This is the user's clipboard, not ours. Put it back. Electron 44 models the clipboard on
  // the W3C API, so every call here is async — in older versions these were plain strings.
  const saved = await clipboard.readText()
  try {
    const marker = `COPYTEST-${Date.now()}`
    await clipboard.writeText('')

    const setup = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store, newTerminalTab, getTerminal, paneKey } = window.__rigee

        let scratch = null
        for (let i = 0; i < 60; i++) {
          scratch = store.getState().workspaces.find(w => w.id === '__scratch__')
          if (scratch && store.getState().ready) break
          await sleep(250)
        }
        if (!scratch) return JSON.stringify({ ok: false, stage: 'no-scratch' })
        store.getState().setActiveWorkspace(scratch.id)

        const tab = newTerminalTab()
        store.getState().openTab(scratch.id, tab)

        let handle = null
        for (let i = 0; i < 60; i++) {
          await sleep(250)
          const row = store.getState().rowsByWorkspace[scratch.id]
          const t = row && row.groups.flatMap(g => g.tabs).find(x => x.id === tab.id)
          if (t) handle = getTerminal(paneKey(tab.id, t.activeLeafId))
          if (handle) break
        }
        if (!handle) return JSON.stringify({ ok: false, stage: 'no-terminal' })

        // Straight into the buffer: this exercises selection and copy, not the shell.
        handle.term.write('${marker}\\r\\n')
        await sleep(400)
        handle.term.selectAll()
        const selected = handle.term.getSelection()
        if (!selected.includes('${marker}')) {
          return JSON.stringify({ ok: false, stage: 'nothing-selected', selected: selected.slice(0, 80) })
        }

        const isMac = navigator.platform.toLowerCase().includes('mac')
        const ev = isMac
          ? { key: 'c', code: 'KeyC', metaKey: true }
          : { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }
        handle.term.textarea.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...ev }))
        await sleep(50)
        return JSON.stringify({ ok: true, selectedChars: selected.length,
          combo: isMac ? 'cmd+c' : 'ctrl+shift+c' })
      })()`,
      true
    )) as string

    let ok = false
    let copied = ''
    if ((JSON.parse(setup) as { ok: boolean }).ok) {
      // Give the async clipboard write a moment to land.
      for (let i = 0; i < 40; i++) {
        copied = await clipboard.readText()
        if (copied.includes(marker)) break
        await new Promise((r) => setTimeout(r, 100))
      }
      ok = copied.includes(marker)
    }

    // Before app.exit, which does not run `finally`.
    await clipboard.writeText(saved)
    console.log('[smoke:copy]', JSON.stringify({
      ok, setup: JSON.parse(setup), clipboard: copied.trim().slice(0, 60)
    }))
    app.exit(ok ? 0 : 1)
  } catch (err) {
    await clipboard.writeText(saved)
    console.error('[smoke:copy] threw:', err)
    app.exit(1)
  }
}

/**
 * End-to-end check of the keyboard: what real keystrokes put on the wire, and what they do.
 *
 * Driven through `webContents.sendInputEvent` — keyDown, char, keyUp — which is Chromium's real
 * input pipeline, keypress included, unlike the synthetic DOM events the other smokes dispatch.
 * That difference is the point. A key the terminal consumed without cancelling still produced a
 * keypress that typed itself — Shift+Enter arrived as a newline AND a submit — and a synthetic
 * keydown can never show it. What this cannot reach is Electron's menu, which only acts on real
 * NSEvents; for that the check is that every consumed keydown was cancelled, which is what stops
 * the menu acting on it too (Cmd+V pasting twice was exactly that).
 *
 * The window is never shown and the panes run a sink instead of a shell — see the smoke setup at
 * the top of this file — so it can run while somebody is using the machine.
 */
async function runKeysSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  const mac = process.platform === 'darwin'
  const mod = mac ? 'meta' : 'control'
  const trail: string[] = []
  const failed: string[] = []
  const expect = (label: string, ok: boolean, detail?: unknown): void => {
    trail.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
    if (!ok) failed.push(label)
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const js = async <T>(code: string): Promise<T> => (await wc.executeJavaScript(code, true)) as T
  type Mod = 'shift' | 'control' | 'alt' | 'meta' | 'isautorepeat'

  /** One keystroke, the way a keyboard delivers it. Returns what reached the pty meanwhile. */
  const press = async (
    keyCode: string,
    modifiers: Mod[] = [],
    char?: string,
    wait = 150
  ): Promise<{ data: string[]; prevented: boolean[] }> => {
    await js(`window.__keys.reset()`)
    keystroke(wc, keyCode, modifiers, char)
    await sleep(wait)
    return js(`window.__keys.read()`)
  }
  const click = async (selector: string, button: 'left' | 'right' = 'left', wait = 200): Promise<boolean> => {
    const ok = await clickAt(wc, selector, button)
    await sleep(wait)
    return ok
  }
  /** Poll the page until `code` is true: for UI that arrives in its own time, like a lazy dialog. */
  const waitFor = async (code: string, ms = 5000): Promise<boolean> => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (await js<boolean>(code)) return true
      await sleep(100)
    }
    return false
  }
  // Open, and holding the keyboard: on whichever page it opened on, that page's first field has it.
  const dialogReady = `window.__rigee.store.getState().settingsOpen && !!document.activeElement?.closest('.modal--settings')`
  const state = (): Promise<{
    tabs: number
    activeTab: string | null
    leaves: string[]
    activeLeaf: string | null
    panesOnScreen: number
    fontSize: number
    searchOpen: boolean
    focus: string
    leftCollapsed: boolean
    rightCollapsed: boolean
    settingsOpen: boolean
    sizes: number[] | null
    baseY: number
  }> => js(`window.__keys.state()`)

  const saved = await clipboard.readText()
  try {
    const setup = await js<{ ok: boolean; stage?: string }>(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const { store, newTerminalTab, getTerminal, paneKey } = window.__rigee
      let scratch = null
      for (let i = 0; i < 80; i++) {
        scratch = store.getState().workspaces.find(w => w.id === '__scratch__')
        if (scratch && store.getState().ready) break
        await sleep(250)
      }
      if (!scratch) return { ok: false, stage: 'no-scratch' }
      store.getState().setActiveWorkspace(scratch.id)
      store.getState().openTab(scratch.id, newTerminalTab())

      const row = () => store.getState().rowsByWorkspace[scratch.id]
      const group = () => row().groups.find(g => g.id === row().activeGroupId)
      const tab = () => group().tabs.find(t => t.id === group().activeTabId)
      const leafIds = (n) => n.kind === 'leaf' ? [n.id] : n.children.flatMap(leafIds)
      const active = () => { const t = tab(); return t && t.kind === 'terminal' ? getTerminal(paneKey(t.id, t.activeLeafId)) : null }

      const K = window.__keys = {
        data: [], downs: [],
        reset() {
          K.data = []; K.downs = []
          // Every pane, including ones split off since the last keystroke.
          for (const g of row().groups) for (const t of g.tabs) {
            if (t.kind !== 'terminal') continue
            for (const id of leafIds(t.root)) {
              const h = getTerminal(paneKey(t.id, id))
              if (h && !h.__probed) { h.__probed = true; h.term.onData(d => K.data.push(d)) }
            }
          }
          if (!store.getState().settingsOpen && !document.querySelector('.term__search input')) active()?.term.focus()
        },
        read() { return { data: K.data, prevented: K.downs.map(e => e.defaultPrevented) } },
        write(text) { return new Promise(r => active().term.write(text, r)) },
        state() {
          const t = tab(), s = store.getState(), h = active()
          const ae = document.activeElement
          return {
            tabs: group().tabs.length,
            activeTab: t ? t.id : null,
            leaves: t && t.kind === 'terminal' ? leafIds(t.root) : [],
            activeLeaf: t && t.kind === 'terminal' ? t.activeLeafId : null,
            panesOnScreen: document.querySelectorAll('.term__pane').length,
            fontSize: h ? h.term.options.fontSize : 0,
            searchOpen: !!document.querySelector('.term__search'),
            focus: ae ? (ae.className || ae.tagName) : '',
            leftCollapsed: s.layout.leftCollapsed,
            rightCollapsed: s.layout.rightCollapsed,
            settingsOpen: s.settingsOpen,
            sizes: t && t.kind === 'terminal' && t.root.kind === 'split' ? t.root.sizes : null,
            baseY: h ? h.term.buffer.active.baseY : -1
          }
        }
      }
      // Capture phase, so it sees each keydown first; defaultPrevented is read after dispatch.
      window.addEventListener('keydown', e => K.downs.push(e), true)

      for (let i = 0; i < 80; i++) {
        await sleep(250)
        const h = active()
        if (h && h.paneId) { K.reset(); return { ok: true } }
      }
      return { ok: false, stage: 'no-terminal' }
    })()`)
    if (!setup.ok) {
      console.log('[smoke:keys]', JSON.stringify(setup))
      await clipboard.writeText(saved)
      app.exit(1)
      return
    }
    const fontDefault = (await state()).fontSize

    // --- Shift+Enter ---------------------------------------------------------
    let r = await press('Enter', ['shift'], '\r')
    expect('Shift+Enter sends ESC CR and nothing else', JSON.stringify(r.data) === JSON.stringify(['\x1b\r']), r)
    expect('and the keydown was cancelled', r.prevented[0] === true, r.prevented)
    r = await press('Enter', [], '\r')
    expect('plain Enter is still CR', JSON.stringify(r.data) === JSON.stringify(['\r']), r)
    await js(`window.__keys.write('\\x1b[>4;2m')`)
    r = await press('Enter', ['shift'], '\r')
    expect('under modifyOtherKeys 2 (vim) it is CSI 27;2;13~', JSON.stringify(r.data) === JSON.stringify(['\x1b[27;2;13~']), r)
    await js(`window.__keys.write('\\x1b[>4m')`)
    r = await press('Enter', ['shift'], '\r')
    expect('and back to ESC CR when the program resets it', JSON.stringify(r.data) === JSON.stringify(['\x1b\r']), r)

    // --- paste ---------------------------------------------------------------
    const marker = `rigee-keys-${Date.now()}`
    await js(`window.__keys.write('\\x1b[?2004h')`)
    await clipboard.writeText(marker)
    const pasteKey: [string, Mod[]] = mac ? ['V', ['meta']] : ['V', ['control', 'shift']]
    r = await press(pasteKey[0], pasteKey[1], undefined, 400)
    expect('paste sends the clipboard once, bracketed',
      JSON.stringify(r.data) === JSON.stringify([`\x1b[200~${marker}\x1b[201~`]), r)
    expect('and the keydown was cancelled, so the menu cannot paste it again', r.prevented[0] === true, r.prevented)
    await clipboard.writeText('')
    r = await press(pasteKey[0], pasteKey[1], undefined, 400)
    expect('an empty clipboard still sends an empty bracketed paste (Claude Code\'s image signal)',
      JSON.stringify(r.data) === JSON.stringify(['\x1b[200~\x1b[201~']), r)
    if ((await clipboard.readText()) === '') await clipboard.writeText(saved)

    // --- the prefix no longer leaks -------------------------------------------
    r = await press('A', ['control'], '\x01')
    expect('the prefix arms without reaching the shell', r.data.length === 0 && r.prevented[0] === true, r)
    r = await press('Q', [], 'q')
    expect('an unbound key after it is swallowed, keypress and all', r.data.length === 0, r)

    // --- line editing ------------------------------------------------------------
    if (mac) {
      r = await press('Left', ['meta'])
      expect('Cmd+Left is ^A', JSON.stringify(r.data) === JSON.stringify(['\x01']), r)
      r = await press('Right', ['meta'])
      expect('Cmd+Right is ^E', JSON.stringify(r.data) === JSON.stringify(['\x05']), r)
      r = await press('Backspace', ['meta'])
      expect('Cmd+Backspace is ^U', JSON.stringify(r.data) === JSON.stringify(['\x15']), r)
      r = await press('Left', ['alt'])
      expect('Option+Left is ESC b', JSON.stringify(r.data) === JSON.stringify(['\x1bb']), r)
    }

    // --- font size ---------------------------------------------------------------
    r = await press('=', [mod], mac ? undefined : '=')
    expect('Cmd/Ctrl+= makes the text bigger', (await state()).fontSize === fontDefault + 1, await state())
    expect('without also zooming the page', r.prevented[0] === true && r.data.length === 0, r)
    await press('=', [mod, 'shift'])
    expect('so does the + chord', (await state()).fontSize === fontDefault + 2)
    await press('-', [mod])
    expect('and minus makes it smaller', (await state()).fontSize === fontDefault + 1)
    await press('0', [mod])
    expect('0 puts it back', (await state()).fontSize === fontDefault)

    // --- clear ---------------------------------------------------------------------
    if (mac) {
      await js(`window.__keys.write(Array.from({ length: 200 }, (_, i) => 'line ' + i).join('\\r\\n'))`)
      const before = (await state()).baseY
      await press('K', ['meta'])
      const after = (await state()).baseY
      expect('Cmd+K clears the scrollback', before > 0 && after === 0, { before, after })
    }

    // --- splits ----------------------------------------------------------------
    const splitRight: [string, Mod[]] = mac ? ['D', ['meta']] : ['O', ['control', 'shift']]
    const splitDown: [string, Mod[]] = mac ? ['D', ['meta', 'shift']] : ['E', ['control', 'shift']]
    await press(splitRight[0], splitRight[1], undefined, 900)
    await press(splitDown[0], splitDown[1], undefined, 900)
    let st = await state()
    expect('two splits make three panes', st.leaves.length === 3, st)
    // R(a, C(b, c)), with c active.
    const [a, b, c] = st.leaves
    if (mac) {
      await press(']', ['meta'])
      expect('Cmd+] wraps to the first pane', (await state()).activeLeaf === a)
      await press('[', ['meta'])
      expect('Cmd+[ goes back', (await state()).activeLeaf === c)
      await press('Up', ['meta', 'alt'])
      expect('Cmd+Option+Up goes to the pane above', (await state()).activeLeaf === b)
      await press('Left', ['meta', 'alt'])
      expect('Cmd+Option+Left goes to the pane on the left', (await state()).activeLeaf === a)
      await press('Right', ['meta', 'control'])
      st = await state()
      expect('Cmd+Ctrl+Right moves the divider right', !!st.sizes && st.sizes[0]! > 0.5, st.sizes)
      await press('=', ['meta', 'control'])
      st = await state()
      expect('Cmd+Ctrl+= evens it out', !!st.sizes && Math.abs(st.sizes[0]! - 0.5) < 1e-6, st.sizes)
      r = await press('Enter', ['meta', 'shift'], '\r')
      st = await state()
      expect('Cmd+Shift+Enter zooms the pane', st.panesOnScreen === 1, st)
      expect('and sends no Enter to it', r.data.length === 0, r)
      await press('Enter', ['meta', 'shift'], '\r')
      expect('and again unzooms', (await state()).panesOnScreen === 3)
      await press('W', ['meta', 'isautorepeat'])
      expect('a held Cmd+W closes nothing', (await state()).leaves.length === 3)
      await press('W', ['meta'], undefined, 600)
      st = await state()
      expect('Cmd+W closes the pane, not the tab', st.leaves.length === 2 && st.tabs >= 1, st)
    }

    // --- tabs ------------------------------------------------------------------
    const tabsBefore = (await state()).tabs
    await press('T', mac ? ['meta'] : ['control', 'shift'], undefined, 900)
    st = await state()
    expect('new tab', st.tabs === tabsBefore + 1, st)
    if (mac) {
      const newest = st.activeTab
      await press('1', ['meta'], undefined, 600)
      st = await state()
      expect('Cmd+1 goes to the first tab', st.activeTab !== newest, st)
      await press('9', ['meta'], undefined, 600)
      expect('Cmd+9 goes to the last', (await state()).activeTab === newest)
      await press('Tab', ['control'], undefined, 600)
      const first = (await state()).activeTab
      expect('Ctrl+Tab wraps round to the first', first !== newest)
      await press('[', ['meta', 'shift'], undefined, 600)
      expect('Cmd+Shift+[ wraps back to the last', (await state()).activeTab === newest)
      await press(']', ['meta', 'shift'], undefined, 600)
      expect('Cmd+Shift+] wraps forward to the first', (await state()).activeTab === first)
    }

    // --- search ------------------------------------------------------------------
    await press('F', mac ? ['meta'] : ['control', 'shift'], undefined, 300)
    st = await state()
    expect('find opens a search bar that has the keyboard', st.searchOpen && st.focus === 'INPUT', st)
    r = await press('Escape', [], undefined, 300)
    st = await state()
    expect('Escape closes it and gives the keyboard back', !st.searchOpen && st.focus.includes('xterm-helper-textarea'), st)
    expect('without the terminal seeing the Escape', r.data.length === 0, r)
    r = await press('Escape')
    expect('with no search open, Escape reaches the program', JSON.stringify(r.data) === JSON.stringify(['\x1b']), r)

    // --- what the review found -----------------------------------------------------
    r = await press('Escape')
    const heldEsc = await press('Escape', ['isautorepeat'])
    expect('holding Escape with no search open keeps sending ESC', JSON.stringify(heldEsc.data) === JSON.stringify(['\x1b']), heldEsc)

    if (mac) {
      // The find bar belongs to its pane: Cmd+W there closes the pane, never the whole tab.
      await press('D', ['meta'], undefined, 900)
      const beforeFind = await state()
      await press('F', ['meta'], undefined, 300)
      r = await press('Left', ['meta'])
      expect('Cmd+Left in the find box edits the box, it types nothing into the pane', r.data.length === 0, r)
      await press('W', ['meta'], undefined, 600)
      st = await state()
      expect('Cmd+W in the find bar closes one pane, not the tab',
        st.leaves.length === beforeFind.leaves.length - 1 && st.tabs === beforeFind.tabs, { before: beforeFind, after: st })
      await press('Escape', [], undefined, 300)

      // The context menu must leave the keyboard in the terminal.
      await js(`window.__keys.reset()`)
      await click('.term__pane--active .term__surface', 'right')
      const menuOpen = await js<boolean>(`!!document.querySelector('.menu')`)
      await click('.menu .menu__item:nth-of-type(3)')
      st = await state()
      expect('after the pane menu, the terminal still has the keyboard',
        menuOpen && st.focus.includes('xterm-helper-textarea'), { menuOpen, focus: st.focus })

      // The dialog: Cmd+W closes it — not the window — and the keyboard goes back to the terminal.
      await press(',', ['meta'], undefined, 100)
      await waitFor(dialogReady)
      r = await press('W', ['meta'], undefined, 300)
      st = await state()
      expect('Cmd+W closes the settings dialog', !st.settingsOpen && r.prevented[0] === true, { st, r })
      expect('and the terminal has the keyboard again', st.focus.includes('xterm-helper-textarea'), st.focus)

      // unconsumed: runs the action once, however many listeners the key passes.
      await js(`(() => { const s = window.__rigee.store.getState(); window.__keys.saved = s.keybindings;
        s.setKeybindings({ ...s.keybindings, binds: ['unconsumed:super+b=toggle_left_panel'] }) })()`)
      const leftBefore = (await state()).leftCollapsed
      await press('B', ['meta'])
      expect('an unconsumed: binding runs once, not twice', (await state()).leftCollapsed === !leftBefore)
      await press('B', ['meta'])
      await js(`window.__rigee.store.getState().setKeybindings(window.__keys.saved)`)
    }

    // --- the workbench -------------------------------------------------------------
    if (mac) {
      const right = (await state()).rightCollapsed
      await press('G', ['meta', 'shift'])
      expect('Cmd+Shift+G is left for search now', (await state()).rightCollapsed === right)
      await press('B', ['meta', 'alt'])
      expect('Cmd+Option+B toggles the right panel', (await state()).rightCollapsed === !right)
      await press('B', ['meta', 'alt'])
      const left = (await state()).leftCollapsed
      await press('B', ['meta'])
      expect('Cmd+B toggles the left panel', (await state()).leftCollapsed === !left)
      await press('B', ['meta'])
      await press(',', ['meta'], undefined, 100)
      expect('Cmd+, opens the settings', await waitFor(dialogReady))
      await press('Escape', [], undefined, 300)
      expect('and Escape closes them', !(await state()).settingsOpen)
    }

    console.log('[smoke:keys]\n  ' + trail.join('\n  '))
    console.log(`[smoke:keys] ${trail.length - failed.length}/${trail.length} passed`)
    if ((await clipboard.readText()) === '' || (await clipboard.readText()) === marker) await clipboard.writeText(saved)
    app.exit(failed.length === 0 ? 0 : 1)
  } catch (err) {
    console.error('[smoke:keys] threw:', err)
    console.log('[smoke:keys]\n  ' + trail.join('\n  '))
    await clipboard.writeText(saved)
    app.exit(1)
  }
}

type KeyModifier = 'shift' | 'control' | 'alt' | 'meta' | 'isautorepeat'

/** One keystroke through Chromium's real input pipeline: keyDown, the char it types, keyUp. */
function keystroke(wc: WebContents, keyCode: string, modifiers: KeyModifier[] = [], char?: string): void {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  if (char !== undefined) wc.sendInputEvent({ type: 'char', keyCode: char, modifiers })
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}

/** Type text as keystrokes, one character at a time — what an IME-free keyboard would send. */
async function typeText(wc: WebContents, text: string): Promise<void> {
  for (const ch of text) {
    keystroke(wc, ch, [], ch)
    await new Promise((r) => setTimeout(r, 15))
  }
}

/** A real click — mouseDown, mouseUp — at the centre of the first visible match for `selector`. */
async function clickAt(wc: WebContents, selector: string, button: 'left' | 'right' = 'left'): Promise<boolean> {
  const at = (await wc.executeJavaScript(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.offsetParent !== null)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`, true)) as { x: number; y: number } | null
  if (!at) return false
  wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button, clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button, clickCount: 1 })
  return true
}

/**
 * End-to-end check of editing: finding text across the workspace, opening a result, saving, the
 * unsaved-changes prompts, a file changed on disk underneath the editor, and in-file find.
 *
 * Hidden, like the keys mode, and for the same reason. The native prompts are answered by
 * RIGEE_SMOKE_UNSAVED_ANSWER instead of by a person, and `window.confirm` — the overwrite question —
 * is stubbed in the page; neither can appear on anybody's screen.
 */
async function runEditingSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  const mac = process.platform === 'darwin'
  const mod: KeyModifier = mac ? 'meta' : 'control'
  const trail: string[] = []
  const failed: string[] = []
  const expect = (label: string, ok: boolean, detail?: unknown): void => {
    trail.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
    if (!ok) failed.push(label)
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const js = async <T>(code: string): Promise<T> => (await wc.executeJavaScript(code, true)) as T
  const until = async (code: string, ms = 8000): Promise<boolean> => {
    for (let waited = 0; waited < ms; waited += 150) {
      if (await js<boolean>(code)) return true
      await sleep(150)
    }
    return false
  }
  const answer = (choice: 'save' | 'discard' | 'cancel'): void => { process.env.RIGEE_SMOKE_UNSAVED_ANSWER = choice }
  /** The keyboard into the editor of one column, the way a click would put it there. */
  const focusEditor = (groupId: string): Promise<boolean> => js<boolean>(`(() => {
    const el = document.querySelector('[data-group-id="${groupId}"] .monaco-editor .native-edit-context, [data-group-id="${groupId}"] .monaco-editor textarea')
    el?.focus()
    return !!el && document.activeElement === el
  })()`)
  const docStart = (): void => keystroke(wc, mac ? 'Up' : 'Home', [mod])
  const docEnd = (): void => keystroke(wc, mac ? 'Down' : 'End', [mod])

  const root = join(app.getPath('userData'), 'editing-fixture')
  const fileA = join(root, 'a.ts')
  mkdirSync(root, { recursive: true })
  writeFileSync(fileA, 'const needle = 1\nconst other = 2\n')
  writeFileSync(join(root, 'notes.md'), '这是一个needle测试\n')
  const fileB = join(root, 'b.ts')
  const fileBom = join(root, 'bom.csv')
  writeFileSync(fileB, 'const bee = 1\n')
  writeFileSync(fileBom, '\uFEFFname,值\n')
  const fileMixed = join(root, 'mixed.txt')
  writeFileSync(fileMixed, 'a\nb\nc\r\nd\n')
  // One long identifier: `(\w+\s*)+=` against it backtracks exponentially in V8.
  writeFileSync(join(root, 'evil.txt'), `const ${'someVeryLongIdentifierNameHere'.repeat(2)}.b = 1\n`)
  const editorTab = (id: string, path: string): string =>
    JSON.stringify({ id, kind: 'editor', title: path.split('/').pop(), pinned: false, filePath: path, repoId: null, readOnly: false, viewType: 'text-editor.monaco' })

  try {
    const ready = await js<boolean>(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const { store } = window.__rigee
      for (let i = 0; i < 80; i++) { if (store.getState().ready) break; await sleep(250) }
      store.getState().addWorkspace({
        id: 'ws-edit', name: 'edit', createdAt: Date.now(), lastOpenedAt: Date.now(),
        folders: [{ path: ${JSON.stringify(root)}, name: 'editing-fixture', isGitRepo: false, repoRoot: null }]
      })
      await sleep(800)
      return store.getState().activeWorkspaceId === 'ws-edit'
    })()`)
    expect('a workspace with two files', ready)

    // --- workspace search -------------------------------------------------------
    keystroke(wc, 'F', [mod, 'shift', ...(mac ? [] : (['alt'] as KeyModifier[]))])
    expect('the search shortcut opens the search panel',
      await until(`!!document.querySelector('.search__input') && document.activeElement === document.querySelector('.search__input')`))
    await typeText(wc, 'needle')
    expect('typing finds the matches in both files',
      await until(`document.querySelectorAll('.search__match').length === 2 && document.querySelectorAll('.search__file').length === 2`),
      await js(`document.querySelector('.search__summary')?.textContent`))
    const zhPreview = await js<string>(`[...document.querySelectorAll('.search__match mark')].map(m => m.textContent).join('|')`)
    expect('each match is highlighted where it is, Chinese text included', zhPreview === 'needle|needle', zhPreview)

    // --- open a result, edit, save -------------------------------------------------
    await clickAt(wc, '.search__file:has([title$="a.ts"]) .search__match')
    expect('a result opens its file in an editor with the keyboard',
      await until(`!!document.activeElement && !!document.activeElement.closest('.monaco-editor')`))
    // The match is selected, so typing replaces exactly it: that is what proves the cursor landed.
    await typeText(wc, 'pin')
    expect('an edit marks the tab unsaved', await until(`!!document.querySelector('.tab__close--dirty')`))
    keystroke(wc, 'S', [mod])
    expect('Cmd/Ctrl+S saves and clears the mark', await until(`!document.querySelector('.tab__close--dirty')`))
    const saved = readFileSync(fileA, 'utf8')
    expect('what was saved is the match replaced, nothing else', saved === 'const pin = 1\nconst other = 2\n', saved)

    // --- in-file find and replace ----------------------------------------------------
    keystroke(wc, 'F', [mod])
    expect('find inside the file opens the editor\'s own find widget',
      await until(`!!document.querySelector('.monaco-editor .find-widget.visible')`))
    keystroke(wc, 'Escape')
    await sleep(200)
    keystroke(wc, mac ? 'F' : 'H', mac ? ['meta', 'alt'] : ['control'])
    expect('and replace opens its replace field',
      await until(`!!document.querySelector('.monaco-editor .find-widget.visible.replaceToggled')`))
    keystroke(wc, 'Escape')
    await sleep(200)
    await js(`document.querySelector('.monaco-editor textarea, .monaco-editor .native-edit-context')?.focus()`)

    // --- unsaved changes, and closing over them ------------------------------------------
    keystroke(wc, 'End', [])
    await typeText(wc, ' // edited')
    expect('a second edit is unsaved again', await until(`!!document.querySelector('.tab__close--dirty')`))
    answer('cancel')
    keystroke(wc, 'W', [mod])
    await sleep(600)
    expect('closing with unsaved changes, and choosing Cancel, keeps the tab',
      await js<boolean>(`!!document.querySelector('.tab__close--dirty')`))
    answer('discard')
    keystroke(wc, 'W', [mod])
    expect("Don't Save closes it", await until(`!document.querySelector('.tab__close--dirty') && ![...document.querySelectorAll('.tab__label')].some(l => l.textContent === 'a.ts')`))
    expect('and leaves the file on disk as it was saved', readFileSync(fileA, 'utf8') === 'const pin = 1\nconst other = 2\n', readFileSync(fileA, 'utf8'))

    // --- the file changes on disk underneath the editor -------------------------------------
    await clickAt(wc, '.search__match')
    await until(`!!document.activeElement && !!document.activeElement.closest('.monaco-editor')`)
    writeFileSync(fileA, 'const agent = 1\nconst other = 2\n')
    wc.focus()
    await js(`window.dispatchEvent(new Event('focus'))`)
    expect('coming back to a file with nothing unsaved takes the disk\'s version',
      await until(`(document.querySelector('.monaco-editor .view-lines')?.textContent || '').includes('agent')`))
    await typeText(wc, 'x')
    writeFileSync(fileA, 'const someone = 1\nconst other = 2\n')
    await js(`void (window.confirm = () => false)`)
    keystroke(wc, 'S', [mod])
    expect('saving over a change made on disk asks, and No keeps the disk\'s version',
      await until(`(document.body.textContent || '').includes('Not saved')`) && readFileSync(fileA, 'utf8').includes('someone'),
      readFileSync(fileA, 'utf8'))
    await js(`void (window.confirm = () => true)`)
    keystroke(wc, 'S', [mod])
    expect('and Yes overwrites it', await until(`!document.querySelector('.tab__close--dirty')`) && !readFileSync(fileA, 'utf8').includes('someone'))

    // --- two editors side by side: Cmd+S saves the one with the keyboard -------------------------
    const groups = await js<string[]>(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const s = () => window.__rigee.store.getState()
      s().splitTab('ws-edit')
      await sleep(400)
      s().openTab('ws-edit', ${editorTab('tab-b', fileB)})
      await sleep(1200)
      return s().rowsByWorkspace['ws-edit'].groups.map(g => g.id)
    })()`)
    const leftFocused = await focusEditor(groups[0]!)
    await sleep(200)
    docStart()
    await typeText(wc, '// left ')
    keystroke(wc, 'S', [mod])
    await sleep(800)
    expect('with two files in two columns, Cmd+S saves the one being typed in',
      leftFocused && readFileSync(fileA, 'utf8').startsWith('// left') && readFileSync(fileB, 'utf8') === 'const bee = 1\n',
      { leftFocused, a: readFileSync(fileA, 'utf8').slice(0, 20), b: readFileSync(fileB, 'utf8') })

    // --- a byte order mark survives a save -------------------------------------------------------
    await js(`window.__rigee.store.getState().openTab('ws-edit', ${editorTab('tab-bom', fileBom)})`)
    await until(`[...document.querySelectorAll('.tab--active .tab__label')].some(l => l.textContent === 'bom.csv')`)
    await sleep(600)
    await focusEditor(groups[1]!)
    docEnd()
    await typeText(wc, 'x,1')
    keystroke(wc, 'S', [mod])
    await sleep(800)
    const bomBytes = readFileSync(fileBom)
    expect('saving keeps the UTF-8 byte order mark', bomBytes[0] === 0xef && bomBytes[1] === 0xbb && bomBytes[2] === 0xbf && bomBytes.toString('utf8').includes('x,1'),
      bomBytes.subarray(0, 8).toString('hex'))

    // --- a result in a file that changed on disk lands on the right text --------------------------
    await focusEditor(groups[0]!)
    await sleep(300)
    writeFileSync(fileA, 'import { x } from "y"\n// left\nconst agent = 1\nconst other = 2\n')
    keystroke(wc, 'F', [mod, 'shift', ...(mac ? [] : (['alt'] as KeyModifier[]))])
    await until(`document.activeElement === document.querySelector('.search__input')`)
    keystroke(wc, 'A', [mod])
    await typeText(wc, 'other')
    await until(`[...document.querySelectorAll('.search__match')].some(m => m.title.endsWith('a.ts:4:7'))`)
    await clickAt(wc, '.search__match[title$="a.ts:4:7"]')
    await sleep(900)
    await typeText(wc, 'OTHER')
    keystroke(wc, 'S', [mod])
    await sleep(800)
    expect('opening a result after the file changed on disk selects the match, not the text that used to be there',
      readFileSync(fileA, 'utf8') === 'import { x } from "y"\n// left\nconst agent = 1\nconst OTHER = 2\n', readFileSync(fileA, 'utf8'))

    // --- a file that stops being UTF-8 goes read-only ---------------------------------------------
    writeFileSync(fileA, Buffer.from([0x2f, 0x2f, 0x20, 0xc4, 0xe3, 0xba, 0xc3, 0x0a]))  // "// 你好" in GBK
    await js(`window.dispatchEvent(new Event('focus'))`)
    expect('a file rewritten in another encoding is not loaded, and goes read-only with a warning',
      await until(`(document.body.textContent || '').includes('not UTF-8')`) &&
      readFileSync(fileA).equals(Buffer.from([0x2f, 0x2f, 0x20, 0xc4, 0xe3, 0xba, 0xc3, 0x0a])))
    writeFileSync(fileA, 'const back = 1\n')
    await js(`window.dispatchEvent(new Event('focus'))`)
    expect('and editable again once it is UTF-8', await until(`!(document.body.textContent || '').includes('not UTF-8')`))

    // --- a deleted file is not silently recreated -------------------------------------------------
    await js(`window.__rigee.store.getState().setActiveTab('ws-edit', 'tab-b')`)
    await sleep(700)
    await focusEditor(groups[1]!)
    await typeText(wc, 'q')
    rmSync(fileB)
    await js(`void (window.confirm = () => false)`)
    keystroke(wc, 'S', [mod])
    await sleep(800)
    expect('saving a file deleted on disk asks, and No leaves it deleted', !existsSync(fileB))

    // --- removing a workspace with unsaved files asks first ----------------------------------------
    answer('cancel')
    await js(`[...document.querySelectorAll('[title="Remove workspace"]')].pop()?.click()`)
    await sleep(600)
    expect('removing a workspace with an unsaved file, and choosing Cancel, keeps it',
      await js<boolean>(`window.__rigee.store.getState().workspaces.some(w => w.id === 'ws-edit')`))

    // --- a reload from disk keeps the cursor on its line and is an undo step of its own ------------
    const thirty = Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join('\n') + '\n'
    writeFileSync(fileA, thirty)
    await js(`window.__rigee.store.getState().setActiveTab('ws-edit', ${JSON.stringify(await js<string>(`window.__rigee.store.getState().rowsByWorkspace['ws-edit'].groups[0].activeTabId`))})`)
    await focusEditor(groups[0]!)
    await js(`window.dispatchEvent(new Event('focus'))`)
    await until(`(document.querySelector('[data-group-id="${groups[0]}"] .view-lines')?.textContent || '').includes('L30')`)
    docStart()
    for (let i = 0; i < 19; i++) keystroke(wc, 'Down')
    await sleep(200)
    writeFileSync(fileA, 'A1\nA2\nA3\n' + thirty)
    await js(`window.dispatchEvent(new Event('focus'))`)
    await until(`(document.querySelector('[data-group-id="${groups[0]}"] .view-lines')?.textContent || '').includes('A1')`)
    await sleep(200)
    await typeText(wc, 'Z')
    keystroke(wc, 'S', [mod])
    await sleep(700)
    const afterReload = readFileSync(fileA, 'utf8').split('\n')
    expect('after an agent adds lines above it, the cursor is still on the same line of text',
      afterReload[22] === 'ZL20', afterReload.slice(18, 25))
    keystroke(wc, 'Z', [mod])
    await sleep(200)
    keystroke(wc, 'S', [mod])
    await sleep(700)
    const afterUndo = readFileSync(fileA, 'utf8')
    expect('and one Cmd+Z takes back only the keystroke, not the agent\'s lines',
      afterUndo === 'A1\nA2\nA3\n' + thirty, afterUndo.slice(0, 40))

    // --- Cmd+S with nothing to save writes nothing ------------------------------------------------
    const mtime = statSync(fileA).mtimeMs
    await sleep(50)
    keystroke(wc, 'S', [mod])
    await sleep(600)
    expect('Cmd+S on a file with nothing unsaved leaves it untouched', statSync(fileA).mtimeMs === mtime)

    // --- a reload keeps a mostly-LF file LF, and follows the disk's byte order mark -----------------
    await js(`window.__rigee.store.getState().openTab('ws-edit', ${editorTab('tab-mixed', fileMixed)}, ${JSON.stringify(groups[0])})`)
    await until(`[...document.querySelectorAll('.tab--active .tab__label')].some(l => l.textContent === 'mixed.txt')`)
    await sleep(600)
    await focusEditor(groups[0]!)
    writeFileSync(fileMixed, 'a\nb\nc\r\nd\ne\n')
    await js(`window.dispatchEvent(new Event('focus'))`)
    await until(`(document.querySelector('[data-group-id="${groups[0]}"] .view-lines')?.textContent || '').includes('e')`)
    docEnd()
    await typeText(wc, 'x')
    keystroke(wc, 'S', [mod])
    await sleep(700)
    const mixed = readFileSync(fileMixed, 'utf8')
    expect('a reload does not turn a mostly-LF file into CRLF', !mixed.includes('\r\n') && mixed.includes('x'), JSON.stringify(mixed))

    await js(`window.__rigee.store.getState().setActiveTab('ws-edit', 'tab-bom')`)
    await sleep(600)
    await focusEditor(groups[1]!)
    writeFileSync(fileBom, 'name,值\nnew,1\n')
    await js(`window.dispatchEvent(new Event('focus'))`)
    await until(`(document.querySelector('[data-group-id="${groups[1]}"] .view-lines')?.textContent || '').includes('new')`)
    docEnd()
    await typeText(wc, 'y')
    keystroke(wc, 'S', [mod])
    await sleep(700)
    const unmarked = readFileSync(fileBom)
    expect('when a tool removes the byte order mark on disk, saving does not put it back', unmarked[0] !== 0xef, unmarked.subarray(0, 6).toString('hex'))

    // --- a regex that backtracks forever does not freeze the app ------------------------------------
    keystroke(wc, 'F', [mod, 'shift', ...(mac ? [] : (['alt'] as KeyModifier[]))])
    await until(`document.activeElement === document.querySelector('.search__input')`)
    await clickAt(wc, '.search__toggle[title="Use regular expression"]')
    keystroke(wc, 'A', [mod])
    await typeText(wc, '(\\w+\\s*)+=')
    await sleep(1500)
    const t0 = Date.now()
    await js('1')
    await sleep(50)
    const lag = Date.now() - t0
    expect('the main process stays responsive while that search runs', lag < 500, `${lag} ms`)
    await clickAt(wc, '.search__toggle[title="Use regular expression"]')
    keystroke(wc, 'A', [mod])
    await typeText(wc, 'bee')
    expect('and the next search replaces it and answers', await until(`(document.querySelector('.search__summary')?.textContent || '').includes('result')`, 6000),
      await js(`document.querySelector('.search__summary')?.textContent`))

    // --- quitting with unsaved changes -------------------------------------------------------
    await typeText(wc, 'y')
    await until(`!!document.querySelector('.tab__close--dirty')`)
    await sleep(300)
    answer('cancel')
    app.quit()
    await sleep(800)
    expect('quitting with unsaved changes, and choosing Cancel, keeps the app and its window',
      !!window && !window.isDestroyed() && !quitting)

    console.log('[smoke:editing]\n  ' + trail.join('\n  '))
    console.log(`[smoke:editing] ${trail.length - failed.length}/${trail.length} passed`)
    app.exit(failed.length === 0 ? 0 : 1)
  } catch (err) {
    console.error('[smoke:editing] threw:', err)
    console.log('[smoke:editing]\n  ' + trail.join('\n  '))
    app.exit(1)
  }
}

/**
 * Regression check for the crash on the way out.
 *
 * Close the window on macOS and the app keeps running, but every WebContentsView it owned is
 * already gone while the browser plugin still holds entries for them. Quitting then walked that
 * map and threw *"Object has been destroyed"* out of `before-quit` — a crash dialog on an app that
 * was leaving anyway, and one that only appears if you close the window before quitting rather
 * than quitting straight from it.
 *
 * Reproduced here by doing precisely that. Teardown is called directly because `app.exit()` never
 * runs `before-quit`, and it now goes through the plugin host: disposing a plugin's fiber is what
 * runs the cleanup that used to be a line in this file, so this also checks that the fiber
 * teardown path survives a destroyed window.
 */
async function runQuitSmoke(): Promise<void> {
  const win = window
  if (!win) { console.error('[smoke:quit] no window'); app.exit(1); return }

  const host = await plugins()
  const bounds = { x: 0, y: 0, width: 400, height: 300 }
  try {
    await host.invoke('browser:create', { url: 'about:blank', bounds })
    await host.invoke('browser:create', { url: 'about:blank', bounds })
  } catch (err) {
    console.error('[smoke:quit] could not open browser views:', err)
    app.exit(1)
    return
  }

  win.destroy()
  await new Promise((r) => setTimeout(r, 300))

  try {
    await host.dispose()
    ptys?.disposeAll()
  } catch (err) {
    console.error('[smoke:quit] teardown threw after the window was destroyed:', err)
    app.exit(1)
    return
  }
  console.log('[smoke:quit]', JSON.stringify({ ok: true, plugins: host.active() }))
  app.exit(0)
}

/**
 * The other crash on the way out — the one `smoke:quit` structurally cannot catch.
 *
 * `smoke:quit` leaves through `app.exit()`, which never runs `before-quit`. That is deliberate
 * there (it is testing teardown with a destroyed window) but it means the whole quit HANDLER was
 * untested, and a real Cmd+Q on the packaged app aborted:
 *
 *     watcher.node … PromiseRunner::onWorkComplete → napi_fatal_error → abort()
 *
 * Source control's filesystem watchers are native. Releasing one schedules work on
 * @parcel/watcher's thread that finishes through a napi callback, and `before-quit` used to start
 * disposal without waiting — so the callback arrived mid `Environment::RunCleanup`, where napi has
 * nowhere to put it and aborts. Nothing in-process notices; you get a crash report for an app that
 * looked like it quit.
 *
 * So this one watches a real repository and then leaves through `app.quit()` — the actual path a
 * user takes.
 *
 * WHAT IT ASSERTS, AND WHAT IT DOES NOT. It does not reproduce the abort. That needs the napi
 * callback to land inside a window a few milliseconds wide, and quitting with one repo watched
 * exits 0 either way — measured, by patching the built main back to the old handler. An
 * exit-code assertion would pass for both versions, which is worse than no test at all.
 *
 * So it asserts the property that makes the window unreachable: WHEN THE APP ACTUALLY QUITS,
 * PLUGIN TEARDOWN HAS FINISHED — not merely started. Two deliberate choices make that a real
 * check rather than a coincidence:
 *
 *   - it reads `host.torndown` from `will-quit`, the last point before the environment goes;
 *   - it makes teardown take 800 ms. Without that the old code also passed, because Electron
 *     spends longer closing windows than a one-repo dispose takes, so the bug hid behind a race
 *     it happened to win. The delay stands in for the slow native unsubscribe of a large watched
 *     tree, which is the condition the crash report was produced under (four workspaces, an app
 *     up for nearly two hours) — it does not create the bug, it stops the test from depending on
 *     which side of a race this particular machine lands.
 */
async function runShutdownSmoke(): Promise<void> {
  const host = await plugins()
  const repo = app.getAppPath()
  try {
    await host.invoke('scm:watch', { repoRoots: [repo] })
  } catch (err) {
    console.error('[smoke:shutdown] could not watch', repo, err)
    app.exit(1)
    return
  }

  // Let the FSEvents stream actually come up. Unsubscribing a subscription that never finished
  // subscribing is a different (and much tamer) path than the one we are here to exercise.
  await new Promise((r) => setTimeout(r, 500))
  const watching = host.active()

  // See the note above: teardown is slowed on this instance only, so that "did the quit wait?"
  // stops being a question about timing. `before-quit` holds the same object, and `torndown` is
  // still set by the real dispose underneath.
  const realDispose = host.dispose.bind(host)
  host.dispose = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 800))
    await realDispose()
  }

  app.on('will-quit', () => {
    const ok = host.torndown
    console.log('[smoke:shutdown]', JSON.stringify({ watching, torndownAtWillQuit: ok }))
    if (!ok) {
      console.error(
        '[smoke:shutdown] FAILED: the app is quitting while plugin teardown is still running.\n' +
          '  A native watcher unsubscribe completing after this point aborts the process\n' +
          '  (watcher.node → PromiseRunner::onWorkComplete → napi_fatal_error).\n' +
          '  before-quit must hold the quit open until dispose() resolves.'
      )
      app.exit(1)
    }
  })

  console.log('[smoke:shutdown]', JSON.stringify({ watching, quitting: repo }))
  app.quit()
}

/**
 * End-to-end check on the tab strip: its context menu, and the split button beside it.
 *
 * The close and row arithmetic is covered by `pnpm panes:selftest`. What only a real window can
 * show is the wiring: that a right-click on ANY tab — terminal, page or file — offers the same
 * menu, that what is picked reaches the store, that a sweep asks before stopping a program still
 * running in a terminal — and that the split button makes a SECOND strip whose contents are
 * governed by what the tab is. Driven through DOM events rather than the store so the components
 * are genuinely in the loop; the menu itself is native, so it is answered through its probe.
 */
async function runTabsSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  // The "still running" question must never appear on a screen during a test. Cancel is the
  // answer that proves it was asked: the terminal survives a sweep it would otherwise have died in.
  process.env.RIGEE_SMOKE_RUNNING_ANSWER = 'cancel'
  try {
    const result = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store, newTerminalTab, getTerminal, paneKey } = window.__rigee
        const trail = []

        let scratch = null
        for (let i = 0; i < 60; i++) {
          scratch = store.getState().workspaces.find(w => w.id === '__scratch__')
          if (scratch && store.getState().ready) break
          await sleep(250)
        }
        if (!scratch) return JSON.stringify({ ok: false, stage: 'no-scratch' })
        const ws = scratch.id
        store.getState().setActiveWorkspace(ws)

        const editor = (id) => ({ id, kind: 'editor', title: id, pinned: false,
          filePath: '/' + id + '.ts', repoId: null, readOnly: false })
        // about:blank, so the check does not quietly depend on the network.
        const browser = (id) => ({ id, kind: 'custom', viewType: 'browser.page', title: id,
          pinned: false, state: { url: 'about:blank' } })

        const row = () => store.getState().rowsByWorkspace[ws]
        const order = () => row().groups.flatMap(g => g.tabs).map(t => t.id).join(',')
        const strips = () => [...document.querySelectorAll('.tabstrip')]
        const tabEls = (i) => {
          const strip = strips()[i]
          return strip ? [...strip.querySelectorAll('.tab')] : []
        }
        const rightClick = (el) => el.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 90, clientY: 20 }))
        const fail = (stage, extra) => {
          window.__rigee.menus.answer = null
          return JSON.stringify(Object.assign({ ok: false, stage, trail }, extra || {}))
        }

        // The tab menu is native, so it is answered here instead of clicked: what it offered is
        // kept, and the row named is what the user "picked". null dismisses it.
        let offered = null
        const pickFrom = async (el, id) => {
          offered = null
          window.__rigee.menus.answer = (items) => { offered = items; window.__rigee.menus.answer = null; return id }
          rightClick(el)
          await sleep(250)
          return offered
        }
        const labels = () => (offered || []).filter(i => i.kind === 'item')
          .map(i => i.label + (i.enabled === false ? '[off]' : ''))
        const paneIdsOf = (tab) => {
          const ids = (n) => n.kind === 'leaf' ? [n.paneId].filter(Boolean) : n.children.flatMap(ids)
          return ids(tab.root)
        }
        const runningIn = (tab) => window.rigee.invoke('terminal:running', { paneIds: paneIdsOf(tab) })
        const liveTab = (id) => row().groups.flatMap(g => g.tabs).find(t => t.id === id)
        /**
         * Settled at a prompt. A shell still reading its rc files has things in the foreground too,
         * and a sweep would rightly ask about them. One that never started — its tab was never on
         * screen — has nothing running at all.
         */
        const idle = async (tab) => {
          for (let i = 0; i < 60; i++) {
            const live = liveTab(tab.id)
            if (!live || paneIdsOf(live).length === 0 || (await runningIn(live)).length === 0) return true
            await sleep(250)
          }
          return false
        }

        /*
         * One empty group, whatever the previous phase left behind.
         *
         * Two things make this necessary rather than tidy. Arriving at Scratch opens a terminal on
         * its own, so the fixtures below would be counting someone else's tab; and a leftover
         * second group would put those fixtures across two strips, where every count taken from
         * one of them is quietly short.
         */
        const reset = async () => {
          for (let i = 0; i < 12; i++) {
            const ids = row().groups.flatMap(g => g.tabs).map(t => t.id)
            if (ids.length) store.getState().closeTabs(ws, ids)
            const first = row().groups[0]
            store.getState().setRow(ws, {
              groups: [{ id: first.id, tabs: [], activeTabId: null }],
              sizes: [1],
              activeGroupId: first.id
            })
            await sleep(300)
            const now = row()
            if (now.groups.length === 1 && now.groups[0].tabs.length === 0) return true
          }
          return false
        }
        if (!(await reset())) return fail('could-not-clear-the-row')

        const term = newTerminalTab()
        for (const t of [term, editor('e1'), browser('b1'), editor('e2'), editor('e3')]) {
          store.getState().openTab(ws, t)
        }
        await sleep(600)

        trail.push('opened: ' + order())
        if (strips().length !== 1) return fail('fixture-spread-over-groups', { n: strips().length })
        if (tabEls(0).length !== 5) return fail('wrong-tab-count', { n: tabEls(0).length })

        // Every kind of tab offers the same menu, the same four commands.
        const want = 'Close|Close Others|Close to the Right|Close All'
        for (const [i, kind] of [[0, 'terminal'], [2, 'browser'], [1, 'file']]) {
          if (!(await pickFrom(tabEls(0)[i], null))) return fail('no-menu-on-' + kind)
          trail.push(kind + ' menu: ' + labels().join(' | '))
          if (labels().map(l => l.replace('[off]', '')).join('|') !== want) return fail('wrong-menu-on-' + kind, { labels: labels() })
        }
        if (document.querySelector('.menu')) return fail('an-html-menu-appeared-as-well')
        // Greyed, not missing, where there is nothing for a command to do.
        await pickFrom(tabEls(0)[4], null)
        if (!labels().includes('Close to the Right[off]')) return fail('right-not-greyed-on-the-last-tab', { labels: labels() })
        if (order() !== [term.id, 'e1', 'b1', 'e2', 'e3'].join(',')) return fail('a-dismissed-menu-closed-something')

        // To the right of a file: the page and the files after it go, whatever they are.
        await pickFrom(tabEls(0)[1], 'right')
        await sleep(250)
        trail.push('after close-right: ' + order())
        if (order() !== [term.id, 'e1'].join(',')) return fail('close-right-wrong')

        // Close Others from a file sweeps up the terminal too — an idle one without asking.
        store.getState().openTab(ws, browser('b2'))
        store.getState().openTab(ws, editor('e4'))
        await sleep(300)
        if (!(await idle(term))) return fail('terminal-never-settled-at-a-prompt')
        await pickFrom(tabEls(0)[1], 'others')
        await sleep(400)
        trail.push('after close-others: ' + order())
        if (order() !== 'e1') return fail('close-others-wrong')

        // Selection must never be left pointing at a tab that is gone. Still singular with several
        // groups on screen: it is the active group's active tab, and what Cmd+W acts on.
        const activeGroup = () => row().groups.find(g => g.id === row().activeGroupId) || row().groups[0]
        const active = activeGroup().activeTabId
        if (!order().split(',').includes(active)) return fail('active-tab-dangling', { active })

        // A terminal running something is asked about before a sweep stops it — and the answer
        // here is Cancel, so it, and everything else, must still be there afterwards. It stays on
        // screen until its program is running: only the active tab is mounted, and a terminal
        // hidden before its shell started would never start one.
        const busy = newTerminalTab()
        store.getState().openTab(ws, busy)
        let shell = null
        for (let i = 0; i < 80 && !(shell && shell.paneId); i++) {
          await sleep(250)
          shell = getTerminal(paneKey(busy.id, busy.activeLeafId))
        }
        if (!shell || !shell.paneId || !(await idle(busy))) return fail('busy-terminal-never-started')
        shell.term.input(' sleep 30' + String.fromCharCode(13), true)
        let busyWith = []
        for (let i = 0; i < 40 && busyWith.length === 0; i++) {
          await sleep(250)
          busyWith = await runningIn(liveTab(busy.id))
        }
        trail.push('running in the terminal: ' + JSON.stringify(busyWith.map(r => r.process)))
        if (busyWith.length === 0) return fail('sleep-never-showed-as-running')
        store.getState().openTab(ws, editor('e5'))
        await sleep(300)
        const before = order()
        await pickFrom(tabEls(0)[2], 'others')
        await sleep(600)
        trail.push('after close-others, cancelled: ' + order())
        if (order() !== before) return fail('a-cancelled-sweep-closed-something', { before, after: order() })

        // Aimed at the busy terminal itself, the sweep has nothing else running to ask about.
        await pickFrom(tabEls(0)[1], 'all')
        await sleep(600)
        trail.push('after close-all on the busy terminal: "' + order() + '"')
        if (order() !== '') return fail('close-all-from-the-busy-terminal-left-tabs')

        // --- the split button -------------------------------------------------
        // Found by title rather than by position: the strip's actions grow, and an index would
        // start pressing "new terminal" the day one is added before it. Two titles, because the
        // button tells the truth about what it is about to do — "Split right" for a file,
        // "Move to a new group" for a terminal.
        const isSplit = (b) => {
          const title = (b.title || '').toLowerCase()
          return title.includes('split') || title.includes('new group')
        }
        const splitButton = (i) => {
          const strip = strips()[i]
          return strip ? ([...strip.querySelectorAll('button')].find(isSplit) || null) : null
        }
        const buttonTitles = (i) => {
          const strip = strips()[i]
          return strip ? [...strip.querySelectorAll('button')].map(b => b.title).join(' | ') : ''
        }

        // A file can exist in two columns at once — that is the whole feature — so splitting one
        // COPIES it, and the copy needs an id of its own: the pty handles, the browser plugin's
        // native views and the PDF reader's scroll positions are all keyed by tab id.
        if (!(await reset())) return fail('could-not-clear-the-row')
        store.getState().openTab(ws, editor('s1'))
        await sleep(400)
        if (!splitButton(0)) return fail('no-split-button', { titles: buttonTitles(0) })
        splitButton(0).click()
        await sleep(600)

        trail.push('after splitting a file: ' + row().groups.map(g => g.tabs.length).join('+'))
        if (row().groups.length !== 2) return fail('split-made-no-second-group')
        if (strips().length !== 2) return fail('second-group-has-no-strip', { n: strips().length })
        // The class the positional '.pane' lookups in smoke:scroll and smoke:multirepo depend on.
        if (document.querySelectorAll('.group').length !== 2) {
          return fail('groups-are-not-.group-elements', { n: document.querySelectorAll('.group').length })
        }
        const left = row().groups[0]
        const right = row().groups[1]
        if (left.tabs.length !== 1 || right.tabs.length !== 1) {
          return fail('split-moved-the-file-instead-of-copying-it', { shape: order() })
        }
        if (left.tabs[0].filePath !== right.tabs[0].filePath) return fail('copy-is-a-different-file')
        if (left.tabs[0].id === right.tabs[0].id) {
          return fail('copy-reuses-the-source-tab-id', { id: left.tabs[0].id })
        }
        const sum = row().sizes.reduce((a, b) => a + b, 0)
        trail.push('sizes after split: ' + row().sizes.join(','))
        if (row().sizes.length !== 2 || Math.abs(sum - 1) > 0.001) {
          return fail('sizes-do-not-fill-the-row', { sizes: row().sizes })
        }

        // A terminal cannot be copied — its ptys are keyed by <tabId>:<leafId>, so two tabs
        // sharing them would put two xterms on one shell — so splitting one MOVES it instead.
        if (!(await reset())) return fail('could-not-clear-the-row')
        store.getState().openTab(ws, editor('m1'))
        const moving = newTerminalTab()
        store.getState().openTab(ws, moving)
        let handle = null
        for (let i = 0; i < 80; i++) {
          await sleep(250)
          handle = getTerminal(paneKey(moving.id, moving.activeLeafId))
          if (handle && handle.paneId) break
        }
        if (!handle || !handle.paneId) return fail('terminal-never-got-a-pty')
        const ptyBefore = handle.paneId
        trail.push('terminal pty before the split: ' + ptyBefore)

        if (!splitButton(0)) return fail('no-split-button-with-a-terminal-active', { titles: buttonTitles(0) })
        splitButton(0).click()
        await sleep(800)
        trail.push('after splitting a terminal: ' + row().groups.map(g => g.tabs.map(t => t.id).join('/')).join(' + '))
        if (row().groups.length !== 2) return fail('terminal-split-made-no-second-group')
        if (row().groups[0].tabs.some(t => t.id === moving.id)) {
          return fail('terminal-was-duplicated-not-moved', { shape: order() })
        }
        if (!row().groups[1].tabs.some(t => t.id === moving.id)) {
          return fail('terminal-did-not-arrive-in-the-new-group', { shape: order() })
        }
        const after = getTerminal(paneKey(moving.id, moving.activeLeafId))
        trail.push('terminal pty after the split: ' + (after ? after.paneId : 'no handle'))
        if (!after || after.paneId !== ptyBefore) {
          return fail('the-move-respawned-the-shell', { before: ptyBefore, after: after ? after.paneId : null })
        }

        // And emptying a group takes the group with it: the width goes back to the survivor, or
        // the row is left not filling the window.
        const closer = tabEls(1)[0].querySelector('.tab__close')
        if (!closer) return fail('no-close-button-in-the-second-strip')
        closer.click()
        await sleep(600)
        trail.push('after closing the last tab of group 1: ' + row().groups.length + ' group(s), sizes ' + row().sizes.join(','))
        if (row().groups.length !== 1) return fail('emptied-group-survived')
        if (strips().length !== 1) return fail('emptied-group-still-has-a-strip')
        if (Math.abs(row().sizes[0] - 1) > 0.001) {
          return fail('survivor-did-not-take-the-width-back', { sizes: row().sizes })
        }

        window.__rigee.menus.answer = null
        return JSON.stringify({ ok: true, trail, active })
      })()`,
      true
    )) as string
    console.log('[smoke:tabs]', result)
    app.exit(JSON.parse(result).ok ? 0 : 1)
  } catch (err) {
    console.error('[smoke:tabs] threw:', err)
    app.exit(1)
  }
}

/**
 * End-to-end check of filing workspaces under the folder Settings names for them.
 *
 * Through the real UI where there is one: the General page sets the folder, and "Save Workspace
 * As…" then asks only for a name and writes `<folder>/<name>/<name>.code-workspace` listing the
 * workspace's folders. Then main's side of it directly, where the UI would not let a test get: a
 * second save of the same workspace asks nothing, saving over ANOTHER workspace's file asks first
 * (answered Cancel, so that file must come through untouched), and a name that would climb out of
 * the folder is refused whatever the sidebar thought of it.
 *
 * Then what a saved workspace changes about terminals, asking each pane's process where it is. A
 * terminal in the saved workspace starts in the folder its file is in, without a word. One opened
 * in a workspace never saved asks first, and nothing has started while it asks: Not Now starts it
 * in the workspace's folder; the next terminal asks again, and saving from the question starts it
 * in the folder the file went to; Don't remind me again starts it and is kept in Settings, and the
 * next terminal does not ask. A workspace whose file has gone starts its terminals at home rather
 * than flashing a tab that dies.
 *
 * And the menu a workspace opens on right-click: Add Folder on a saved workspace that is not the
 * active one adds it there — without switching to it — and to the file, whose hand-written
 * comment and setting survive; Save Workspace As… opens the name form for the workspace clicked;
 * Scratch has nothing to add or remove. The folder picker is answered by RIGEE_SMOKE_PICK_FOLDER.
 * And a folder's own menu in the explorer: Open in Terminal Tab starts in that folder, not where the
 * workspace's terminals would, and does not stop to ask about saving; Open in Terminal Split adds a
 * pane to the terminal on screen that starts in the folder rather than where its neighbour is.
 * The tree keeps up with the disk: a file written or deleted from outside appears or goes by
 * itself, and the Refresh button reads folders again where the watcher does not look (.git).
 * And a saved workspace's tree is headed by its own folder, the one its file is in: marked as the
 * workspace's and divided from the repos, it lists the file and keeps up with the disk like any
 * other, opens on first sight with them, and is shown once when the file lists it too.
 *
 * With RIGEE_SHOT_DIR set it also photographs the General page, the name form, the head of the
 * explorer and the question a new terminal asks, which are reviewed by looking at them.
 */
async function runWorkspaceFilesSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  const root = join(app.getPath('userData'), 'workspace-files')
  const filed = join(root, 'Workspaces')
  const repos = [join(root, 'repo-a'), join(root, 'repo-b')]
  for (const dir of repos) mkdirSync(dir, { recursive: true })
  // Made before the tree first reads repo-a: the explorer's watcher ignores .git, the folder itself
  // included, and the refresh stage needs one already listed.
  mkdirSync(join(repos[0]!, '.git'), { recursive: true })
  const target = join(filed, 'myworkspace', 'myworkspace.code-workspace')
  process.env.RIGEE_SMOKE_REPLACE_ANSWER = 'cancel'
  const trail: string[] = []
  const js = async <T>(code: string): Promise<T> => (await wc.executeJavaScript(code, true)) as T
  const shoot = async (name: string): Promise<void> => {
    const dir = process.env.RIGEE_SHOT_DIR
    if (!dir) return
    const image = await wc.capturePage()
    writeFileSync(join(dir, `${name}.png`), image.toPNG())
    trail.push(`photographed ${name}`)
  }
  const finish = (ok: boolean, stage: string, extra?: unknown): void => {
    console.log('[smoke:workspacefiles]', JSON.stringify({ ok, stage, trail, ...(extra ? { extra } : {}) }))
    app.exit(ok ? 0 : 1)
  }
  // A React text box takes a value through its prototype's setter and an input event, as typing would.
  const helpers = `
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const { store, getTerminal, paneKey, menus } = window.__rigee
    const type = (el, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const until = async (test, ms = 8000) => {
      for (let waited = 0; waited < ms; waited += 100) { const v = test(); if (v) return v; await sleep(100) }
      return null
    }
    const activeTab = () => {
      const s = store.getState()
      const row = s.rowsByWorkspace[s.activeWorkspaceId]
      const group = row && row.groups.find(g => g.id === row.activeGroupId)
      return group && group.tabs.find(t => t.id === group.activeTabId)
    }
    // The tab strip's button, which is how a person opens one.
    const newTerminal = async () => {
      const before = activeTab()?.id
      document.querySelector('.tabstrip__actions button[title="New terminal"]').click()
      return until(() => { const t = activeTab(); return t && t.kind === 'terminal' && t.id !== before ? t : null })
    }
    const startedPane = (tab) => until(() => getTerminal(paneKey(tab.id, tab.activeLeafId))?.paneId, 15000)
    const button = (root, text) => [...root.querySelectorAll('button')].find(b => b.textContent.includes(text))
    const row = (label) => [...document.querySelectorAll('.row')].find(r => r.querySelector('.row__label')?.textContent === label)`
  /** Where a pane's process is, as the operating system says: the question a split asks too. */
  const whereIs = async (paneId: string | undefined): Promise<string | null> => {
    const at = paneId ? await ptys?.cwdOf(paneId) : null
    return at ? realpathSync(at) : null
  }
  const readDoc = (): { settings?: { remindToSaveWorkspace?: boolean } } => {
    try { return JSON.parse(readFileSync(join(app.getPath('userData'), 'workspaces.json'), 'utf8')) } catch { return {} }
  }

  try {
    // --- Settings: the General page ------------------------------------------------
    const page = await js<{ ok: boolean; stage?: string; note?: string }>(`(async () => {
      ${helpers}
      if (!(await until(() => store.getState().ready, 15000))) return { ok: false, stage: 'never-ready' }
      store.getState().setSettingsOpen(true)
      const general = await until(() => [...document.querySelectorAll('.settings__tab')].find(b => b.textContent === 'General'))
      if (!general) return { ok: false, stage: 'no-general-page' }
      general.click()
      const box = await until(() => document.querySelector('.settings__path'))
      if (!box) return { ok: false, stage: 'no-folder-box' }
      if (document.activeElement !== box) return { ok: false, stage: 'folder-box-does-not-have-the-keyboard' }
      type(box, 'relative/path')
      await sleep(150)
      const refused = document.querySelector('.settings__note--error')?.textContent || ''
      if (!refused) return { ok: false, stage: 'relative-folder-not-refused' }
      type(box, ${JSON.stringify(filed)})
      await sleep(150)
      return { ok: true, note: document.querySelector('.settings__note')?.textContent || '' }
    })()`)
    if (!page.ok) return finish(false, page.stage ?? 'settings')
    trail.push(`General page says: ${page.note}`)
    if (!page.note?.includes(target)) return finish(false, 'example-path-wrong', page.note)
    await shoot('settings-general')

    await js(`(async () => {
      ${helpers}
      document.querySelector('.modal__actions .btn--primary').click()
      await until(() => !store.getState().settingsOpen)
    })()`)
    // The dialog sends the save and closes without waiting for it, so the document gets a moment.
    let onDisk: { settings?: { workspaceFilesDir?: string } } = {}
    for (let i = 0; i < 20 && onDisk.settings?.workspaceFilesDir !== filed; i++) {
      await new Promise((r) => setTimeout(r, 100))
      try { onDisk = JSON.parse(readFileSync(join(app.getPath('userData'), 'workspaces.json'), 'utf8')) } catch { /* not yet */ }
    }
    trail.push(`settings on disk: ${JSON.stringify(onDisk.settings)}`)
    if (onDisk.settings?.workspaceFilesDir !== filed) return finish(false, 'folder-not-saved')

    // --- Save Workspace As…: only a name ------------------------------------------------
    const form = await js<{ ok: boolean; stage?: string; initial?: string; path?: string }>(`(async () => {
      ${helpers}
      store.getState().addWorkspace({
        id: 'ws-files', name: 'repo-a', createdAt: Date.now(), lastOpenedAt: Date.now(),
        folders: ${JSON.stringify(repos)}.map(path => ({ path, name: path.split('/').pop(), isGitRepo: false, repoRoot: null }))
      })
      await sleep(300)
      const plus = document.querySelector('.section-header button[title="Open…"]')
      if (!plus) return { ok: false, stage: 'no-open-button' }
      plus.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      const item = await until(() => [...document.querySelectorAll('.menu__item')].find(b => b.textContent.includes('Save Workspace As')))
      if (!item) return { ok: false, stage: 'no-save-as-item' }
      item.click()
      const input = await until(() => document.querySelector('.saveas input'))
      if (!input) return { ok: false, stage: 'name-form-never-appeared' }
      const initial = input.value
      type(input, 'my/work')
      await sleep(150)
      if (!document.querySelector('.saveas__error')) return { ok: false, stage: 'separator-in-name-not-refused' }
      type(input, 'myworkspace')
      await sleep(150)
      return { ok: true, initial, path: document.querySelector('.saveas__path')?.textContent || '' }
    })()`)
    if (!form.ok) return finish(false, form.stage ?? 'form')
    trail.push(`name form opened with "${form.initial}", would write ${form.path}`)
    if (form.initial !== 'repo-a') return finish(false, 'name-form-did-not-start-from-the-workspace-name')
    if (form.path !== target) return finish(false, 'name-form-path-wrong', form.path)
    await shoot('save-as-form')

    const saved = await js<{ ok: boolean; stage?: string; name?: string; filePath?: string }>(`(async () => {
      ${helpers}
      document.querySelector('.saveas input').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      const ws = await until(() => store.getState().workspaces.find(w => w.id === 'ws-files' && w.filePath))
      if (!ws) return { ok: false, stage: 'enter-did-not-save' }
      if (document.querySelector('.saveas')) return { ok: false, stage: 'name-form-stayed-open' }
      return { ok: true, name: ws.name, filePath: ws.filePath }
    })()`)
    if (!saved.ok) return finish(false, saved.stage ?? 'save')
    trail.push(`saved as "${saved.name}" at ${saved.filePath}`)
    if (saved.filePath !== target || saved.name !== 'myworkspace') return finish(false, 'saved-in-the-wrong-place', saved)
    const written = parseWorkspaceFile(readFileSync(target, 'utf8'), target)
    trail.push(`file lists ${written.folders.map((f) => f.path).join(', ')}`)
    if (written.name !== 'myworkspace' || written.folders.map((f) => f.path).join() !== repos.join()) {
      return finish(false, 'file-content-wrong', written)
    }

    // --- main's side ------------------------------------------------------------------
    const folders = repos.map((path) => ({ path, name: basename(path) }))
    const before = readFileSync(target, 'utf8')
    const outcomes = await js<{ again: unknown; other: unknown; climb: string }>(`(async () => {
      const save = (args) => window.rigee.invoke('workspace:saveWorkspaceFile', args)
      const folders = ${JSON.stringify(folders)}
      const again = await save({ name: 'myworkspace', folders, location: 'named', current: ${JSON.stringify(target)} })
      const other = await save({ name: 'myworkspace', folders: folders.slice(1), location: 'named', current: null })
      const climb = await save({ name: '../escape', folders, location: 'named' }).then(() => '', (e) => String(e && e.message || e))
      return { again, other, climb }
    })()`)
    trail.push(`saved again: ${JSON.stringify(outcomes.again)}; another workspace, same name: ${JSON.stringify(outcomes.other)}; ../escape: ${outcomes.climb}`)
    if (outcomes.again !== target) return finish(false, 'resaving-its-own-file-asked-or-failed')
    if (outcomes.other !== null || readFileSync(target, 'utf8') !== before) return finish(false, 'replaced-another-workspaces-file-without-asking')
    if (!outcomes.climb || existsSync(join(filed, '..', 'escape'))) return finish(false, 'a-climbing-name-was-not-refused')

    // --- terminals: a saved workspace's start in its folder -------------------------------
    const saved1 = await js<{ ok: boolean; stage?: string; paneId?: string }>(`(async () => {
      ${helpers}
      store.getState().setActiveWorkspace('ws-files')
      // A beat for the strip to render for it: its button opens into the workspace it was drawn for.
      await sleep(300)
      const tab = await newTerminal()
      if (!tab) return { ok: false, stage: 'no-terminal-tab' }
      const paneId = await startedPane(tab)
      if (document.querySelector('.saveprompt')) return { ok: false, stage: 'a-saved-workspace-asked-to-be-saved' }
      return paneId ? { ok: true, paneId } : { ok: false, stage: 'saved-workspace-terminal-never-started' }
    })()`)
    if (!saved1.ok) return finish(false, saved1.stage ?? 'saved-terminal')
    const savedAt = await whereIs(saved1.paneId)
    trail.push(`a terminal in the saved workspace started in ${savedAt}`)
    if (savedAt !== realpathSync(dirname(target))) return finish(false, 'saved-workspace-terminal-not-in-its-folder', savedAt)

    // --- the explorer: headed by the workspace's own folder -------------------------------------
    // The folder that terminal just started in is first in the tree, marked as the workspace's, with
    // the repos after a divider, and it is a folder like the rest: it opens, lists the workspace
    // file, and keeps up with the disk. It appeared when the workspace was saved, after the tree had
    // opened the repos on first sight, so it starts shut, as any folder added later does.
    const exploreRow = `const explorerRow = (name) => [...document.querySelectorAll('.explorer__body .row')]
      .find(r => r.querySelector('.row__label')?.textContent === name)`
    const seen = async (name: string, present: boolean, ms = 4000): Promise<boolean> =>
      js<boolean>(`(async () => { ${helpers}; ${exploreRow}
        return !!(await until(() => ${present ? '' : '!'}explorerRow(${JSON.stringify(name)}), ${ms})) })()`)
    const tree = `
      const tree = () => [...document.querySelectorAll('.explorer__body .row')]
      const label = (r) => r?.querySelector('.row__label')?.textContent ?? null
      const head = () => tree()[0]?.classList.contains('explorer__own') ? tree()[0] : null
      const afterDivider = () => label(document.querySelector('.explorer__divider')?.nextElementSibling)`
    const ownDir = dirname(target)
    const headed = await js<{ ok: boolean; stage?: string; name?: string | null; tag?: string; title?: string; after?: string | null }>(`(async () => {
      ${helpers}; ${tree}; ${exploreRow}
      const own = await until(head)
      if (!own) return { ok: false, stage: 'tree-not-headed-by-the-workspace-folder', name: label(tree()[0]) }
      if (document.querySelectorAll('.explorer__own').length !== 1) return { ok: false, stage: 'more-than-one-own-folder' }
      if (explorerRow('myworkspace.code-workspace')) return { ok: false, stage: 'own-folder-opened-over-a-remembered-tree' }
      own.click()
      if (!(await until(() => explorerRow('myworkspace.code-workspace')))) return { ok: false, stage: 'own-folder-does-not-list-the-workspace-file' }
      return { ok: true, name: label(own), tag: own.querySelector('.explorer__tag')?.textContent, title: own.title, after: afterDivider() }
    })()`)
    if (!headed.ok) return finish(false, headed.stage ?? 'own-folder', headed.name)
    trail.push(`the tree is headed by "${headed.name}", tagged ${headed.tag}, then "${headed.after}"; opened, it lists the workspace file`)
    if (headed.name !== 'myworkspace' || headed.tag !== 'Workspace' || headed.after !== 'repo-a') return finish(false, 'own-folder-drawn-wrong', headed)
    if (headed.title?.split('\n')[0] !== ownDir) return finish(false, 'own-folder-hover-names-the-wrong-path', headed.title)
    await shoot('explorer-own-folder')
    const noted = join(ownDir, 'written-by-an-agent.md')
    writeFileSync(noted, 'notes\n')
    if (!(await seen('written-by-an-agent.md', true))) return finish(false, 'a-file-in-the-own-folder-never-appeared')
    rmSync(noted)
    if (!(await seen('written-by-an-agent.md', false))) return finish(false, 'a-file-deleted-from-the-own-folder-stayed')
    trail.push('a file written into it from outside appeared by itself, and went when deleted')

    // Opened afresh, the workspace's folder opens with its repos. And a file that lists the folder it
    // is in — `"path": "."` — shows that folder once, at the head, rather than again among the rest.
    const reopened = await js<{ ok: boolean; stage?: string; open?: string[] }>(`(async () => {
      ${helpers}; ${tree}; ${exploreRow}
      store.getState().addWorkspace({
        id: 'ws-reopened', name: 'reopened', filePath: ${JSON.stringify(target)}, createdAt: Date.now(), lastOpenedAt: Date.now(),
        folders: [{ path: ${JSON.stringify(repos[1])}, name: 'repo-b', isGitRepo: false, repoRoot: null }]
      })
      const open = await until(() => store.getState().pluginStateByWorkspace['ws-reopened']?.['${EXPLORER_PLUGIN_ID}']?.expandedDirs)
      if (!open) return { ok: false, stage: 'first-sight-opened-nothing' }
      if (!(await until(() => explorerRow('myworkspace.code-workspace')))) return { ok: false, stage: 'first-sight-did-not-show-the-own-folder-open' }
      return { ok: true, open: open.slice().sort() }
    })()`)
    if (!reopened.ok) return finish(false, reopened.stage ?? 'own-folder-first-sight')
    trail.push(`opened afresh, the tree opened ${reopened.open?.join(', ')}`)
    if (reopened.open?.join() !== [ownDir, repos[1]!].sort().join()) return finish(false, 'first-sight-opened-the-wrong-folders', reopened.open)
    const inside = await js<{ ok: boolean; stage?: string; name?: string | null; times?: number; after?: string | null }>(`(async () => {
      ${helpers}; ${tree}
      store.getState().addWorkspace({
        id: 'ws-inside', name: 'inside', filePath: ${JSON.stringify(join(repos[1]!, 'inside.code-workspace'))},
        createdAt: Date.now(), lastOpenedAt: Date.now(),
        folders: ${JSON.stringify(repos)}.map(path => ({ path, name: path.split('/').pop(), isGitRepo: false, repoRoot: null }))
      })
      const own = await until(() => label(head()) === 'repo-b' && head())
      if (!own) return { ok: false, stage: 'listed-own-folder-not-at-the-head', name: label(tree()[0]) }
      return { ok: true, name: label(own), times: tree().filter(r => label(r) === 'repo-b').length, after: afterDivider() }
    })()`)
    if (!inside.ok) return finish(false, inside.stage ?? 'own-folder-listed', inside.name)
    trail.push(`a file inside one of its folders: headed by "${inside.name}", shown ${inside.times} time(s), then "${inside.after}"`)
    if (inside.times !== 1 || inside.after !== 'repo-a') return finish(false, 'listed-own-folder-shown-twice', inside)

    // --- an unsaved workspace asks first; Not Now ----------------------------------------
    const skipped = await js<{ ok: boolean; stage?: string; initial?: string; path?: string; paneId?: string }>(`(async () => {
      ${helpers}
      store.getState().addWorkspace({
        id: 'ws-unsaved', name: 'repo-b', createdAt: Date.now(), lastOpenedAt: Date.now(),
        folders: [{ path: ${JSON.stringify(repos[1])}, name: 'repo-b', isGitRepo: false, repoRoot: null }]
      })
      await sleep(300)
      const tab = await newTerminal()
      if (!tab) return { ok: false, stage: 'no-terminal-tab' }
      const prompt = await until(() => document.querySelector('.saveprompt'))
      if (!prompt) return { ok: false, stage: 'unsaved-workspace-did-not-ask' }
      const input = prompt.querySelector('input')
      if (!input) return { ok: false, stage: 'question-has-no-name-field' }
      if (document.activeElement !== input) return { ok: false, stage: 'question-does-not-have-the-keyboard' }
      await sleep(500)
      // The question comes BEFORE the shell, which is the only way the shell can start in the
      // folder the answer creates.
      if (getTerminal(paneKey(tab.id, tab.activeLeafId)) || document.querySelector('.term__pane')) {
        return { ok: false, stage: 'shell-started-before-the-answer' }
      }
      const initial = input.value
      const path = prompt.querySelector('.saveas__path')?.textContent || ''
      const notNow = button(prompt, 'Not Now')
      if (!notNow) return { ok: false, stage: 'no-not-now' }
      notNow.click()
      const paneId = await startedPane(tab)
      if (!paneId) return { ok: false, stage: 'not-now-did-not-start-the-shell' }
      return { ok: true, initial, path, paneId }
    })()`)
    if (!skipped.ok) return finish(false, skipped.stage ?? 'not-now')
    const skippedAt = await whereIs(skipped.paneId)
    trail.push(`asked with "${skipped.initial}" toward ${skipped.path}; Not Now started it in ${skippedAt}`)
    if (skipped.initial !== 'repo-b' || skipped.path !== join(filed, 'repo-b', 'repo-b.code-workspace')) {
      return finish(false, 'question-offered-the-wrong-name', skipped)
    }
    if (skippedAt !== realpathSync(repos[1]!)) return finish(false, 'not-now-started-somewhere-else', skippedAt)

    // --- the next terminal asks again; saving from the question -----------------------------
    const answered = await js<{ ok: boolean; stage?: string; name?: string; filePath?: string; paneId?: string }>(`(async () => {
      ${helpers}
      const tab = await newTerminal()
      if (!tab) return { ok: false, stage: 'no-terminal-tab' }
      const prompt = await until(() => document.querySelector('.saveprompt'))
      if (!prompt) return { ok: false, stage: 'did-not-ask-again' }
      const input = prompt.querySelector('input')
      type(input, 'second')
      await sleep(150)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      const ws = await until(() => store.getState().workspaces.find(w => w.id === 'ws-unsaved' && w.filePath))
      if (!ws) return { ok: false, stage: 'enter-did-not-save' }
      const paneId = await startedPane(tab)
      if (!paneId) return { ok: false, stage: 'saving-did-not-start-the-shell' }
      if (document.querySelector('.saveprompt')) return { ok: false, stage: 'question-stayed-after-saving' }
      return { ok: true, name: ws.name, filePath: ws.filePath, paneId }
    })()`)
    if (!answered.ok) return finish(false, answered.stage ?? 'save-from-question')
    const secondFile = join(filed, 'second', 'second.code-workspace')
    const answeredAt = await whereIs(answered.paneId)
    trail.push(`asked again; saved as "${answered.name}" at ${answered.filePath}, and started in ${answeredAt}`)
    if (answered.filePath !== secondFile || answered.name !== 'second') return finish(false, 'question-saved-in-the-wrong-place', answered)
    if (parseWorkspaceFile(readFileSync(secondFile, 'utf8'), secondFile).folders.map((f) => f.path).join() !== repos[1]) {
      return finish(false, 'question-wrote-the-wrong-folders')
    }
    if (answeredAt !== realpathSync(dirname(secondFile))) return finish(false, 'saved-terminal-not-in-the-new-folder', answeredAt)
    if ((await whereIs(skipped.paneId)) !== realpathSync(repos[1]!)) return finish(false, 'saving-moved-a-running-terminal')

    // --- Open in Terminal, from a folder in the explorer --------------------------------------
    // A workspace whose terminals would start in repo-b, unsaved so a plain terminal would ask;
    // the folder picked must win, and must not be asked about.
    const opened = await js<{ ok: boolean; stage?: string; offered?: string[]; paneId?: string }>(`(async () => {
      ${helpers}
      store.getState().addWorkspace({
        id: 'ws-explore', name: 'explore', createdAt: Date.now(), lastOpenedAt: Date.now(),
        folders: ${JSON.stringify(repos.slice().reverse())}.map(path => ({ path, name: path.split('/').pop(), isGitRepo: false, repoRoot: null }))
      })
      await sleep(400)
      const folder = await until(() => [...document.querySelectorAll('.explorer__body .row')]
        .find(r => r.querySelector('.row__label')?.textContent === 'repo-a'))
      if (!folder) return { ok: false, stage: 'no-explorer-row-for-repo-a' }
      const before = activeTab()?.id
      let offered = null
      menus.answer = (items) => { offered = items; return 'terminal-tab' }
      folder.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      const tab = await until(() => { const t = activeTab(); return t && t.kind === 'terminal' && t.id !== before ? t : null })
      menus.answer = null
      if (!offered) return { ok: false, stage: 'folder-right-click-opened-no-menu' }
      const labels = offered.map(i => i.label)
      if (!tab) return { ok: false, stage: 'open-in-terminal-opened-no-tab', offered: labels }
      const paneId = await startedPane(tab)
      if (document.querySelector('.saveprompt')) return { ok: false, stage: 'open-in-terminal-asked-to-save', offered: labels }
      return paneId ? { ok: true, offered: labels, paneId } : { ok: false, stage: 'open-in-terminal-never-started' }
    })()`)
    if (!opened.ok) return finish(false, opened.stage ?? 'open-in-terminal', opened.offered)
    const openedAt = await whereIs(opened.paneId)
    trail.push(`a folder's menu offered ${opened.offered?.join(', ')}; it started in ${openedAt}`)
    if (openedAt !== realpathSync(repos[0]!)) return finish(false, 'open-in-terminal-started-somewhere-else', openedAt)

    // The same folder as a split of the terminal just opened: one more pane in that tab, starting in
    // repo-b — not where the pane it was split from is, which is repo-a.
    const split = await js<{ ok: boolean; stage?: string; paneId?: string }>(`(async () => {
      ${helpers}
      const tab = activeTab()
      const folder = [...document.querySelectorAll('.explorer__body .row')]
        .find(r => r.querySelector('.row__label')?.textContent === 'repo-b')
      if (!tab || !folder) return { ok: false, stage: 'nothing-to-split-or-no-repo-b-row' }
      const count = (t) => JSON.stringify(t.root).split('"kind":"leaf"').length - 1
      menus.answer = () => 'terminal-split'
      folder.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      const after = await until(() => { const t = activeTab(); return t && t.id === tab.id && count(t) === 2 ? t : null })
      menus.answer = null
      if (!after) return { ok: false, stage: 'split-from-the-explorer-did-not-split-the-terminal' }
      const paneId = await startedPane(after)
      return paneId ? { ok: true, paneId } : { ok: false, stage: 'split-pane-never-started' }
    })()`)
    if (!split.ok) return finish(false, split.stage ?? 'open-in-split')
    const splitAt = await whereIs(split.paneId)
    trail.push(`Open in Terminal Split put a second pane in that tab, started in ${splitAt}`)
    if (splitAt !== realpathSync(repos[1]!)) return finish(false, 'open-in-split-started-somewhere-else', splitAt)

    // --- the explorer keeps up with the disk -------------------------------------------------
    // Still on ws-explore, whose roots the tree opened on first sight. A file written from outside
    // must appear by itself, and go when it is deleted. Inside .git, which the watcher ignores on
    // purpose, a new file stays out of the tree until Refresh is pressed — which is what proves the
    // button reads again rather than the watcher having done it.
    if (!(await seen('repo-a', true))) return finish(false, 'explorer-shows-no-repo-a')
    if (!(await seen('.git', true))) return finish(false, 'explorer-does-not-list-.git')
    const fresh = join(repos[0]!, 'appeared-from-outside.txt')
    writeFileSync(fresh, 'hello\n')
    if (!(await seen('appeared-from-outside.txt', true))) return finish(false, 'a-new-file-never-appeared-in-the-explorer')
    rmSync(fresh)
    if (!(await seen('appeared-from-outside.txt', false))) return finish(false, 'a-deleted-file-stayed-in-the-explorer')
    trail.push('a file written from outside appeared in the explorer by itself, and went when deleted')
    await js(`(async () => { ${helpers}; ${exploreRow}; explorerRow('.git').click(); await sleep(400) })()`)
    writeFileSync(join(repos[0]!, '.git', 'only-after-refresh'), '')
    if (await seen('only-after-refresh', true, 1500)) return finish(false, 'an-ignored-folder-refreshed-without-the-button')
    await js(`(async () => { document.querySelector('.section-header button[title="Refresh"]').click() })()`)
    if (!(await seen('only-after-refresh', true))) return finish(false, 'refresh-did-not-read-the-folder-again')
    trail.push('inside .git, ignored by the watcher, a new file showed only once Refresh was pressed')

    // --- Don't remind me again ------------------------------------------------------------------
    const quiet = await js<{ ok: boolean; stage?: string; paneId?: string }>(`(async () => {
      ${helpers}
      store.getState().addWorkspace({
        id: 'ws-quiet', name: 'repo-a', createdAt: Date.now(), lastOpenedAt: Date.now(),
        folders: [{ path: ${JSON.stringify(repos[0])}, name: 'repo-a', isGitRepo: false, repoRoot: null }]
      })
      await sleep(300)
      const tab = await newTerminal()
      if (!tab) return { ok: false, stage: 'no-terminal-tab' }
      const prompt = await until(() => document.querySelector('.saveprompt'))
      if (!prompt) return { ok: false, stage: 'did-not-ask' }
      const never = button(prompt, 'remind me again')
      if (!never) return { ok: false, stage: 'no-dont-remind' }
      never.click()
      const paneId = await startedPane(tab)
      if (!paneId) return { ok: false, stage: 'dont-remind-did-not-start-the-shell' }
      if (store.getState().settings.remindToSaveWorkspace !== false) return { ok: false, stage: 'reminder-still-on' }
      const next = await newTerminal()
      if (!next) return { ok: false, stage: 'no-second-terminal-tab' }
      const nextPane = await startedPane(next)
      if (document.querySelector('.saveprompt')) return { ok: false, stage: 'asked-after-being-told-not-to' }
      return nextPane ? { ok: true, paneId } : { ok: false, stage: 'unasked-terminal-never-started' }
    })()`)
    if (!quiet.ok) return finish(false, quiet.stage ?? 'dont-remind')
    const quietAt = await whereIs(quiet.paneId)
    let quietDoc = readDoc()
    for (let i = 0; i < 20 && quietDoc.settings?.remindToSaveWorkspace !== false; i++) {
      await new Promise((r) => setTimeout(r, 100))
      quietDoc = readDoc()
    }
    trail.push(`Don't remind me again started it in ${quietAt}; settings on disk: ${JSON.stringify(quietDoc.settings)}`)
    if (quietAt !== realpathSync(repos[0]!)) return finish(false, 'dont-remind-started-somewhere-else', quietAt)
    if (quietDoc.settings?.remindToSaveWorkspace !== false) return finish(false, 'dont-remind-not-saved')

    // --- a workspace whose file has gone --------------------------------------------------------
    const gone = await js<{ ok: boolean; stage?: string; paneId?: string }>(`(async () => {
      ${helpers}
      store.getState().addWorkspace({
        id: 'ws-gone', name: 'gone', filePath: '/nonexistent-rigee-smoke/gone/gone.code-workspace',
        createdAt: Date.now(), lastOpenedAt: Date.now(),
        folders: [{ path: ${JSON.stringify(repos[0])}, name: 'repo-a', isGitRepo: false, repoRoot: null }]
      })
      await sleep(300)
      const tab = await newTerminal()
      if (!tab) return { ok: false, stage: 'no-terminal-tab' }
      const paneId = await startedPane(tab)
      return paneId ? { ok: true, paneId } : { ok: false, stage: 'terminal-never-started' }
    })()`)
    if (!gone.ok) return finish(false, gone.stage ?? 'gone')
    await new Promise((r) => setTimeout(r, 500))
    const goneAt = await whereIs(gone.paneId)
    trail.push(`with its file gone, a terminal started in ${goneAt}`)
    if (goneAt !== realpathSync(homedir())) return finish(false, 'a-gone-folder-did-not-start-at-home', goneAt)
    // Its tree still heads with the folder, and says in one line under it that the folder has gone.
    const goneTree = await js<{ name: string | null; says: boolean }>(`(async () => {
      ${helpers}; ${tree}; ${exploreRow}
      const says = !!(await until(() => label(head()) === 'gone' && explorerRow('This folder is no longer there.')))
      return { name: label(head()), says }
    })()`)
    trail.push(`its tree is headed by "${goneTree.name}", which says ${goneTree.says ? 'it is no longer there' : 'nothing'}`)
    if (goneTree.name !== 'gone' || !goneTree.says) return finish(false, 'a-gone-own-folder-not-said-so', goneTree)

    // --- right-click: Add Folder, on a saved workspace that is not the active one ---------------
    // Hand-edited first, the way people keep these files: a note, and a setting.
    writeFileSync(
      target,
      readFileSync(target, 'utf8')
        .replace('{\n', '{\n  // kept by hand\n')
        .replace('"settings": {}', '"settings": { "files.exclude": { "**/.git": true } }')
    )
    const repoC = join(root, 'repo-c')
    mkdirSync(repoC, { recursive: true })
    process.env.RIGEE_SMOKE_PICK_FOLDER = repoC
    const added = await js<{ ok: boolean; stage?: string; labels?: string[] }>(`(async () => {
      ${helpers}
      const active = store.getState().activeWorkspaceId
      let offered = null
      menus.answer = (items) => { offered = items; return 'add-folder' }
      const target = row('myworkspace')
      if (!target) return { ok: false, stage: 'no-row-for-the-saved-workspace' }
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      const ws = await until(() => store.getState().workspaces.find(w => w.id === 'ws-files' && w.folders.length === 3))
      menus.answer = null
      if (!offered) return { ok: false, stage: 'right-click-opened-no-menu' }
      const labels = offered.filter(i => i.kind === 'item').map(i => i.label + (i.enabled === false ? ' (greyed)' : ''))
      if (!ws) return { ok: false, stage: 'folder-not-added', labels }
      if (store.getState().activeWorkspaceId !== active) return { ok: false, stage: 'right-click-switched-workspace', labels }
      return { ok: true, labels }
    })()`)
    if (!added.ok) return finish(false, added.stage ?? 'menu-add-folder', added.labels)
    trail.push(`a saved workspace's menu offered ${added.labels?.join(', ')}`)
    if (!added.labels?.includes('Add Folder to Workspace…') || !added.labels.includes('Save Workspace As…')) {
      return finish(false, 'menu-lacks-add-folder-or-save-as', added.labels)
    }
    let grown = ''
    for (let i = 0; i < 30 && !grown.includes('repo-c'); i++) {
      await new Promise((r) => setTimeout(r, 100))
      grown = readFileSync(target, 'utf8')
    }
    const grownFolders = parseWorkspaceFile(grown, target).folders.map((f) => f.path)
    trail.push(`its file now lists ${grownFolders.join(', ')}`)
    if (grownFolders.join() !== [...repos, repoC].join()) return finish(false, 'folder-not-added-to-the-file', grown)
    if (!grown.includes('// kept by hand') || !grown.includes('"files.exclude": { "**/.git": true }')) {
      return finish(false, 'adding-a-folder-lost-what-was-in-the-file', grown)
    }

    // --- right-click: Save Workspace As…, and Scratch's menu ------------------------------------
    const named = await js<{ ok: boolean; stage?: string; initial?: string; scratch?: string[] }>(`(async () => {
      ${helpers}
      menus.answer = () => 'save-as'
      row('repo-a').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      const input = await until(() => document.querySelector('.menu--inline.saveas input'))
      menus.answer = null
      if (!input) return { ok: false, stage: 'save-as-from-the-menu-showed-no-form' }
      const initial = input.value
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      if (!(await until(() => !document.querySelector('.menu--inline.saveas')))) return { ok: false, stage: 'escape-left-the-form' }
      let scratch = null
      menus.answer = (items) => { scratch = items; return null }
      row('Scratch').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      await until(() => scratch)
      menus.answer = null
      if (!scratch) return { ok: false, stage: 'scratch-opened-no-menu' }
      return { ok: true, initial, scratch: scratch.filter(i => i.kind === 'item' && i.enabled === false).map(i => i.label) }
    })()`)
    if (!named.ok) return finish(false, named.stage ?? 'menu-save-as')
    trail.push(`Save Workspace As… from the menu offered "${named.initial}"; on Scratch greyed: ${named.scratch?.join(', ')}`)
    if (named.initial !== 'repo-a') return finish(false, 'menu-save-as-named-the-wrong-workspace', named.initial)
    if (!named.scratch?.includes('Add Folder to Workspace…') || !named.scratch.includes('Remove Workspace')) {
      return finish(false, 'scratch-offers-what-it-cannot-do', named.scratch)
    }

    // Last, because it turns the reminder back on to have something to photograph.
    if (process.env.RIGEE_SHOT_DIR) {
      await js(`(async () => {
        ${helpers}
        store.getState().setSettings({ ...store.getState().settings, remindToSaveWorkspace: undefined })
        store.getState().setActiveWorkspace('ws-quiet')
        await sleep(300)
        await newTerminal()
        await until(() => document.querySelector('.saveprompt'))
        await sleep(300)
      })()`)
      await shoot('terminal-asks-to-save')
    }

    finish(true, 'filed')
  } catch (err) {
    console.error('[smoke:workspacefiles] threw:', err)
    finish(false, 'threw')
  }
}

/**
 * The video player, end to end, against a film it makes itself.
 *
 * The fixture is recorded in the renderer — a canvas animated for a moment, through MediaRecorder —
 * so the check needs no ffmpeg and no file in the repo, and the packaged app can run it. What it
 * asserts: the containers that are claimed resolve to the player and AVI does not; the main half
 * loads only when a video opens; the film plays from its rigee-media:// URL at the size it was
 * recorded; that URL answers a Range request with 206 and exactly those bytes, a range past the end
 * with 416, and nothing at all once the tab is closed, when main is serving nothing; and a missing
 * file and a file that is not a video each say so in words.
 *
 * With RIGEE_SMOKE_VIDEO_DIR naming a folder of videos — ffmpeg makes a good one — it also opens
 * every file there and reports which play, which is how the extension list was decided. That part
 * reports and does not fail: what Chromium plays is Chromium's business. RIGEE_SHOT leaves a PNG of
 * the player.
 */
async function runVideoSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  const dir = app.getPath('userData')
  const trail: string[] = []
  const js = async <T>(code: string): Promise<T> => (await wc.executeJavaScript(code, true)) as T
  const finish = (ok: boolean, stage: string, extra?: unknown): void => {
    console.log('[smoke:video]', JSON.stringify({ ok, stage, trail, ...(extra === undefined ? {} : { extra }) }))
    app.exit(ok ? 0 : 1)
  }
  const helpers = `
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const { store, plugins } = window.__rigee
    const until = async (test, ms = 10000) => {
      for (let waited = 0; waited < ms; waited += 100) { const v = test(); if (v) return v; await sleep(100) }
      return null
    }
    const open = (id, path) => store.getState().openTab('__scratch__', {
      id, kind: 'editor', title: path.split('/').pop(), pinned: false,
      filePath: path, repoId: null, readOnly: true, viewType: plugins.resolveViewType(path)
    })
    const noticeText = () => [...document.querySelectorAll('div')].find(d => d.style.placeItems === 'center' && d.textContent)?.textContent || ''`
  try {
    // --- a film of its own ------------------------------------------------------------------
    const recorded = await js<{ ok: boolean; stage?: string; base64?: string; mime?: string }>(`(async () => {
      ${helpers}
      if (!(await until(() => store.getState().ready, 15000))) return { ok: false, stage: 'never-ready' }
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t))
      if (!mime) return { ok: false, stage: 'no-webm-recorder' }
      const canvas = document.createElement('canvas')
      canvas.width = 160
      canvas.height = 90
      const g = canvas.getContext('2d')
      let frame = 0
      const draw = () => {
        g.fillStyle = 'hsl(' + (frame * 37 % 360) + ', 70%, 50%)'
        g.fillRect(0, 0, 160, 90)
        g.fillStyle = '#fff'
        g.fillRect((frame * 7) % 160, 30, 24, 24)
        frame++
      }
      draw()
      const recorder = new MediaRecorder(canvas.captureStream(25), { mimeType: mime })
      const chunks = []
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      const stopped = new Promise(r => { recorder.onstop = r })
      recorder.start(200)
      const tick = setInterval(draw, 40)
      await sleep(2000)
      clearInterval(tick)
      recorder.stop()
      await stopped
      const bytes = new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return { ok: true, base64: btoa(binary), mime }
    })()`)
    if (!recorded.ok) return finish(false, recorded.stage ?? 'record')
    const film = join(dir, 'smoke.webm')
    writeFileSync(film, Buffer.from(recorded.base64!, 'base64'))
    const filmSize = statSync(film).size
    trail.push(`recorded ${filmSize} B of ${recorded.mime}`)
    if (filmSize < 200) return finish(false, 'recording-is-empty', filmSize)

    // --- which files are claimed --------------------------------------------------------------
    const claims = await js<Record<string, string | null>>(`(() => {
      ${helpers}
      return Object.fromEntries(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi', 'wmv']
        .map(ext => [ext, plugins.resolveViewType('/films/a.' + ext)]))
    })()`)
    trail.push(`claims: ${Object.entries(claims).map(([ext, v]) => `${ext}→${v}`).join(' ')}`)
    const claimed = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv']
    if (!claimed.every((ext) => claims[ext] === 'video.player')) return finish(false, 'a-container-is-not-claimed', claims)
    if (claims.avi === 'video.player' || claims.wmv === 'video.player') return finish(false, 'claims-what-chromium-cannot-play', claims)

    // --- it plays, from a streaming URL ----------------------------------------------------------
    const activeBefore = pluginHost?.active().includes('video') ?? false
    const played = await js<{ ok: boolean; stage?: string; url?: string; size?: string; info?: string; t?: number }>(`(async () => {
      ${helpers}
      open('video-smoke', ${JSON.stringify(film)})
      const v = await until(() => { const el = document.querySelector('.video__element'); return el && el.readyState >= 1 ? el : null })
      if (!v) return { ok: false, stage: 'never-loaded', notice: noticeText() }
      const size = v.videoWidth + ' × ' + v.videoHeight
      if (v.videoWidth !== 160 || v.videoHeight !== 90) return { ok: false, stage: 'wrong-size', size }
      const info = await until(() => document.querySelector('.video__info')?.textContent)
      v.muted = true
      await v.play().catch(() => {})
      const moved = await until(() => v.currentTime > 0.2, 8000)
      v.pause()
      return { ok: !!moved, stage: moved ? 'played' : 'never-played', url: v.src, size, info, t: v.currentTime }
    })()`)
    if (!played.ok) return finish(false, played.stage ?? 'play', played)
    trail.push(`played ${played.size} from ${played.url?.split('/').slice(0, 3).join('/')}/…, to ${played.t?.toFixed(2)} s; the bar says "${played.info}"`)
    if (!played.url?.startsWith('rigee-media://')) return finish(false, 'not-streamed-from-the-media-scheme', played.url)
    if (activeBefore || !pluginHost?.active().includes('video')) return finish(false, 'main-half-not-loaded-on-demand', { activeBefore })
    if (!played.info?.startsWith('160 × 90 · ') || !played.info.includes('WEBM')) return finish(false, 'info-wrong', played.info)
    // As smoke:pdf does: a picture of the player it just asserted on, for looking at.
    if (process.env.RIGEE_SHOT) writeFileSync(process.env.RIGEE_SHOT, (await wc.capturePage()).toPNG())

    // --- the URL, as a server ---------------------------------------------------------------------
    const ranged = await net.fetch(played.url, { headers: { Range: 'bytes=0-3' } })
    const head = Buffer.from(await ranged.arrayBuffer())
    trail.push(`bytes=0-3 → ${ranged.status} ${ranged.headers.get('content-range')} ${head.toString('hex')}`)
    if (ranged.status !== 206 || ranged.headers.get('content-range') !== `bytes 0-3/${filmSize}` || head.toString('hex') !== '1a45dfa3') {
      return finish(false, 'range-request-wrong')
    }
    const tail = await net.fetch(played.url, { headers: { Range: 'bytes=-10' } })
    const tailBytes = Buffer.from(await tail.arrayBuffer())
    const past = await net.fetch(played.url, { headers: { Range: `bytes=${filmSize}-` } })
    const whole = await net.fetch(played.url)
    const wholeBytes = Buffer.from(await whole.arrayBuffer())
    trail.push(`bytes=-10 → ${tail.status} ${tailBytes.length} B; past the end → ${past.status}; no range → ${whole.status} ${wholeBytes.length} B`)
    if (tail.status !== 206 || !tailBytes.equals(readFileSync(film).subarray(filmSize - 10))) return finish(false, 'suffix-range-wrong')
    if (past.status !== 416) return finish(false, 'range-past-the-end-not-416', past.status)
    if (whole.status !== 200 || wholeBytes.length !== filmSize) return finish(false, 'whole-file-wrong')

    // --- picking up where it was -----------------------------------------------------------------------
    // Switching to another tab unmounts the player, and coming back must not start the film again;
    // a split copy starts where the tab it was split from had got to.
    const resumed = await js<{ ok: boolean; stage?: string; left?: number; back?: number; copy?: number }>(`(async () => {
      ${helpers}
      const v = document.querySelector('.video__element')
      const left = v.currentTime
      open('video-elsewhere', ${JSON.stringify(join(dir, 'no-such-film.mp4'))})
      if (!(await until(() => !document.querySelector('.video__element')))) return { ok: false, stage: 'player-never-unmounted' }
      store.getState().setActiveTab('__scratch__', 'video-smoke')
      store.getState().closeTab('__scratch__', 'video-elsewhere')
      const again = await until(() => { const el = document.querySelector('.video__element'); return el && el.readyState >= 1 ? el : null })
      if (!again) return { ok: false, stage: 'player-never-came-back', left }
      await sleep(400)
      const back = again.currentTime
      if (Math.abs(back - left) > 0.15) return { ok: false, stage: 'came-back-at-the-wrong-place', left, back }
      store.getState().splitTab('__scratch__')
      const copy = await until(() => {
        const all = [...document.querySelectorAll('.video__element')]
        return all.length === 2 && all[1].readyState >= 1 ? all[1] : null
      })
      if (!copy) return { ok: false, stage: 'split-made-no-second-player', left, back }
      await sleep(400)
      const at = copy.currentTime
      const row = store.getState().rowsByWorkspace['__scratch__']
      const copyTab = row.groups[1]?.activeTabId
      if (copyTab) store.getState().closeTab('__scratch__', copyTab)
      return { ok: Math.abs(at - left) <= 0.15, stage: 'copy', left, back, copy: at }
    })()`)
    trail.push(`left at ${resumed.left?.toFixed(2)} s, back at ${resumed.back?.toFixed(2)} s, split copy at ${resumed.copy?.toFixed(2)} s`)
    if (!resumed.ok) return finish(false, resumed.stage === 'copy' ? 'split-copy-started-elsewhere' : (resumed.stage ?? 'resume'), resumed)

    // --- closing lets the file go -------------------------------------------------------------------
    const servingOpen = servedCount()
    await js(`(async () => { ${helpers}; store.getState().closeTab('__scratch__', 'video-smoke'); await sleep(600) })()`)
    const afterClose = await net.fetch(played.url)
    trail.push(`serving ${servingOpen} while open, ${servedCount()} after closing; the old URL → ${afterClose.status}`)
    if (servingOpen < 1 || servedCount() !== 0 || afterClose.status !== 404) return finish(false, 'closing-did-not-release-the-file')

    // --- failures, in words -----------------------------------------------------------------------------
    const notVideo = join(dir, 'not-a-video.mp4')
    writeFileSync(notVideo, 'this is plain text, not a film\n')
    const failures = await js<{ missing: string; garbage: string }>(`(async () => {
      ${helpers}
      open('video-missing', ${JSON.stringify(join(dir, 'no-such-film.mp4'))})
      const missing = await until(() => noticeText().includes('no-such-film') ? noticeText() : null)
      store.getState().closeTab('__scratch__', 'video-missing')
      open('video-garbage', ${JSON.stringify(notVideo)})
      const garbage = await until(() => noticeText().includes('not-a-video') ? noticeText() : null)
      store.getState().closeTab('__scratch__', 'video-garbage')
      return { missing: missing || '', garbage: garbage || '' }
    })()`)
    trail.push(`missing: "${failures.missing}"; not a video: "${failures.garbage}"`)
    if (failures.missing !== 'no-such-film.mp4 does not exist') return finish(false, 'missing-file-not-said', failures.missing)
    if (!failures.garbage.includes('format Chromium cannot play')) return finish(false, 'unplayable-file-not-said', failures.garbage)

    // --- a survey, when there is a folder of films ----------------------------------------------------
    const surveyDir = process.env.RIGEE_SMOKE_VIDEO_DIR
    if (surveyDir) {
      const files = readdirSync(surveyDir).filter((f) => !f.startsWith('.')).sort()
      const survey = await js<Record<string, string>>(`(async () => {
        ${helpers}
        const out = {}
        for (const name of ${JSON.stringify(files)}) {
          const path = ${JSON.stringify(surveyDir)} + '/' + name
          // As the player whether or not it is claimed: the point is to see what would happen.
          store.getState().openTab('__scratch__', {
            id: 'survey-' + name, kind: 'editor', title: name, pinned: false,
            filePath: path, repoId: null, readOnly: true, viewType: 'video.player'
          })
          const result = await until(() => {
            const v = document.querySelector('.video__element')
            if (v && v.readyState >= 1 && v.videoWidth > 0) return 'plays ' + v.videoWidth + '×' + v.videoHeight + ', ' + v.duration.toFixed(1) + ' s'
            const n = noticeText()
            return n ? 'refused: ' + n.slice(0, 60) : null
          }, 8000)
          out[name] = result || 'timed out'
          store.getState().closeTab('__scratch__', 'survey-' + name)
          await sleep(200)
        }
        return out
      })()`)
      for (const [name, result] of Object.entries(survey)) trail.push(`survey ${name}: ${result}`)
    }

    finish(true, 'played')
  } catch (err) {
    console.error('[smoke:video] threw:', err)
    finish(false, 'threw')
  }
}

/**
 * A document from before heat: two workspaces with no activity record, one of them with a record
 * nobody could compute with. Planted during module evaluation, as the migrate mode's is, because
 * `loadState()` reads the document once and caches it for the life of the process.
 */
function plantHeatDocument(dir: string): void {
  const folder = join(dir, 'heat', 'before')
  mkdirSync(folder, { recursive: true })
  const workspace = (id: string, name: string): Workspace => ({
    id, name, createdAt: 1, lastOpenedAt: 1,
    folders: [{ path: folder, name: 'before', isGitRepo: false, repoRoot: null }]
  })
  writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({
    version: 4,
    workspaces: [workspace('ws-before', 'before'), workspace('ws-garbled', 'garbled')],
    activeWorkspaceId: '__scratch__',
    ui: { 'ws-garbled': { activity: { since: 7, days: 'lots' } } },
    keybindings: {}
  }, null, 2), 'utf8')
  console.log('[smoke:heat] planted a document from before heat in the throwaway userData directory')
}

/**
 * End-to-end check of workspace heat: the side bar ordered and coloured by how much each workspace
 * has been used, the order held still while the pointer is over it, use and terminal output each
 * counted — output in a workspace nobody is looking at, too — and the cold ones cleared out through
 * their checklist, with what it all comes to read back from disk.
 *
 * It starts from workspaces that predate heat, because that is where everybody upgrading starts,
 * and none of them may come up cold. `RIGEE_SHOT_DIR` leaves PNGs of the list and the checklist.
 */
async function runHeatSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  const dir = app.getPath('userData')
  const trail: string[] = []
  const js = async <T>(code: string): Promise<T> => (await wc.executeJavaScript(code, true)) as T
  const finish = (ok: boolean, stage: string, extra?: unknown): void => {
    console.log('[smoke:heat]', JSON.stringify({ ok, stage, trail, ...(extra === undefined ? {} : { extra }) }))
    app.exit(ok ? 0 : 1)
  }
  const shoot = async (name: string): Promise<void> => {
    const to = process.env.RIGEE_SHOT_DIR
    if (!to) return
    writeFileSync(join(to, `${name}.png`), (await wc.capturePage()).toPNG())
    trail.push(`photographed ${name}`)
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const folders = Object.fromEntries(
    ['hot', 'warm', 'agent', 'cool', 'new', 'cold', 'stale', 'chatty', 'quiet'].map((name) => {
      const path = join(dir, 'heat', name)
      mkdirSync(path, { recursive: true })
      return [name, path]
    })
  )
  const helpers = `
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const { store, getTerminal, paneKey, newTerminalTab } = window.__rigee
    const until = async (test, ms = 10000) => {
      for (let waited = 0; waited < ms; waited += 100) { const v = test(); if (v) return v; await sleep(100) }
      return null
    }
    const DAY = 86400000
    const pad = (n) => String(n).padStart(2, '0')
    const day = (n) => { const d = new Date(Date.now() - n * DAY); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }
    const folders = ${JSON.stringify(folders)}
    const workspace = (id, name) => ({
      id, name, createdAt: Date.now(), lastOpenedAt: Date.now(),
      folders: [{ path: folders[name], name, isGitRepo: false, repoRoot: null }]
    })
    const rows = () => [...document.querySelectorAll('.workspace-list .row')]
    const row = (label) => rows().find(r => r.querySelector('.row__label').textContent === label)
    const heat = (label) => (row(label)?.className.match(/heat--(\\w+)/) || [])[1]
    const meta = (label) => row(label)?.querySelector('.row__meta')?.textContent
    const divider = () => document.querySelector('.workspace-list .heat-divider')?.textContent || ''
    // The list as it reads down the side bar, the divider as a bar.
    const layout = () => [...(row('Scratch')?.parentElement?.children ?? [])]
      .map(e => e.classList.contains('heat-divider') ? '|' : e.querySelector('.row__label')?.textContent ?? '?')
    const activity = (id) => store.getState().activityByWorkspace[id]`
  /**
   * The middle of a workspace's row, in the window's coordinates, as a pointer would reach it —
   * scrolled into view first, as a person would: the list scrolls, and a point below its fold is
   * on whatever is drawn there instead.
   */
  const rowCentre = (label: string): Promise<{ x: number; y: number } | null> => js(`(() => {
    ${helpers}
    row(${JSON.stringify(label)})?.scrollIntoView({ block: 'nearest' })
    const r = row(${JSON.stringify(label)})?.getBoundingClientRect()
    return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null
  })()`)
  const pointTo = (at: { x: number; y: number }): void => wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
  // The middle of the centre pane: well away from the list.
  const away = { x: 760, y: 460 }
  const layout = (): Promise<string> => js(`(() => { ${helpers}; return layout().join(' ') })()`)
  const readDoc = (): { workspaces?: Workspace[]; ui?: Record<string, { activity?: WorkspaceActivity }> } => {
    try { return JSON.parse(readFileSync(join(dir, 'workspaces.json'), 'utf8')) } catch { return {} }
  }

  try {
    // --- the workspaces there were before heat -------------------------------------------------
    const booted = await js<{ ok: boolean; stage?: string; today?: string; before?: unknown; garbled?: unknown; heats?: string[]; divider?: string }>(`(async () => {
      ${helpers}
      if (!(await until(() => store.getState().ready && row('garbled'), 15000))) return { ok: false, stage: 'never-ready' }
      await sleep(300)
      return { ok: true, today: day(0), before: activity('ws-before'), garbled: activity('ws-garbled'),
        heats: [heat('before'), heat('garbled')], divider: divider() }
    })()`)
    if (!booted.ok) return finish(false, booted.stage ?? 'boot')
    const fresh = JSON.stringify({ since: booted.today, days: [] })
    trail.push(`before heat, read back as ${JSON.stringify(booted.before)}; the garbled one as ${JSON.stringify(booted.garbled)}`)
    if (JSON.stringify(booted.before) !== fresh) return finish(false, 'a-workspace-from-before-heat-did-not-start-today')
    if (JSON.stringify(booted.garbled) !== fresh) return finish(false, 'a-garbled-record-was-not-replaced')
    if (booted.heats?.join() !== 'cool,cool' || booted.divider) {
      return finish(false, 'a-workspace-from-before-heat-came-up-cold', booted)
    }
    trail.push('neither came up cold')

    // --- ordered and coloured --------------------------------------------------------------------
    const planted = await js<{ layout: string; heats: Record<string, string>; metas: Record<string, string>; divider: string; hint: string }>(`(async () => {
      ${helpers}
      const now = Date.now()
      const s = store.getState()
      s.setWorkspaces([...s.workspaces, workspace('ws-hot', 'hot'), workspace('ws-warm', 'warm'),
        workspace('ws-agent', 'agent'), workspace('ws-cool', 'cool'), workspace('ws-new', 'new'),
        workspace('ws-cold', 'cold'), workspace('ws-stale', 'stale')])
      // Eleven days of use behind today, all of them in ws-hot: that is the clock the others age by.
      const hotDays = [{ day: day(0), used: 90, output: 0 }]
      for (let i = 1; i <= 11; i++) hotDays.push({ day: day(i), used: 30, output: 0 })
      store.setState((st) => ({ activityByWorkspace: { ...st.activityByWorkspace,
        'ws-hot': { since: day(11), usedAt: now - 5.5 * 60000, days: hotDays },
        'ws-warm': { since: day(0), usedAt: now - 2.5 * 3600000, days: [{ day: day(0), used: 12, output: 0 }] },
        'ws-agent': { since: day(0), outputAt: now - 3.5 * 60000, days: [{ day: day(0), used: 0, output: 300 }] },
        'ws-cool': { since: day(3), usedAt: now - 3.5 * DAY, days: [{ day: day(3), used: 2, output: 0 }] },
        'ws-cold': { since: day(11), usedAt: now - 11.5 * DAY, days: [{ day: day(11), used: 60, output: 0 }] },
        'ws-stale': { since: day(13), usedAt: now - 13.5 * DAY, days: [{ day: day(13), used: 10, output: 0 }] }
      } }))
      await sleep(400)
      const labels = layout().filter(l => l !== '|')
      return { layout: layout().join(' '), divider: divider(), hint: document.querySelector('.heat-hint')?.textContent || '',
        heats: Object.fromEntries(labels.map(l => [l, heat(l)])), metas: Object.fromEntries(labels.map(l => [l, meta(l)])) }
    })()`)
    trail.push(`the list: ${planted.layout}`)
    if (planted.layout !== 'Scratch hot agent warm cool before garbled new | cold stale') return finish(false, 'not-ordered-by-heat', planted)
    const wanted: Record<string, string> = {
      Scratch: 'cool', hot: 'hot', agent: 'warm', warm: 'warm', cool: 'cool', before: 'cool', garbled: 'cool', new: 'cool', cold: 'cold', stale: 'cold'
    }
    const wrong = Object.entries(wanted).filter(([label, t]) => planted.heats[label] !== t)
    if (wrong.length > 0) return finish(false, 'wrong-temperatures', { wrong, heats: planted.heats })
    trail.push('an agent printing all day on its own is warm, not hot')
    const times = ['hot', 'agent', 'warm', 'cool', 'new', 'cold', 'stale'].map((l) => `${l} ${planted.metas[l] || '—'}`).join(', ')
    trail.push(`last active: ${times}`)
    if (times !== 'hot 5m, agent 3m, warm 2h, cool 3d, new —, cold 11d, stale 13d') return finish(false, 'wrong-times', planted.metas)
    if (!planted.divider.includes('Cold · 2')) return finish(false, 'no-cold-divider', planted.divider)
    if (planted.hint !== '2 cold') return finish(false, 'no-cold-hint-in-the-header', planted.hint)
    trail.push(`the header says ${planted.hint}, the list scrolling or not`)
    await shoot('heat-list')
    if (process.env.RIGEE_SHOT_DIR) {
      await js(`(async () => { ${helpers}; row('stale').scrollIntoView({ block: 'end' }); await sleep(150) })()`)
      await shoot('heat-cold')
      await js(`(async () => { ${helpers}; row('Scratch').scrollIntoView({ block: 'start' }); await sleep(150) })()`)
    }

    // --- held still under the pointer --------------------------------------------------------
    const coolAt = await rowCentre('cool')
    if (!coolAt) return finish(false, 'no-cool-row')
    pointTo(coolAt)
    await sleep(250)
    const underPointer = await js<{ layout: string; heat: string }>(`(async () => {
      ${helpers}
      const a = activity('ws-cool')
      store.getState().setActivity('ws-cool', { ...a, usedAt: Date.now(), days: [{ day: day(0), used: 500, output: 0 }, ...a.days] })
      await sleep(400)
      return { layout: layout().join(' '), heat: heat('cool') }
    })()`)
    trail.push(`with the pointer on it, cool turned ${underPointer.heat} and the list stayed: ${underPointer.layout}`)
    if (underPointer.heat !== 'hot') return finish(false, 'heat-did-not-change-under-the-pointer', underPointer)
    if (underPointer.layout !== planted.layout) return finish(false, 'the-list-moved-under-the-pointer', underPointer)
    pointTo(away)
    await sleep(400)
    const resorted = await layout()
    trail.push(`pointer gone, the list re-sorted: ${resorted}`)
    if (resorted !== 'Scratch cool hot agent warm before garbled new | cold stale') return finish(false, 'did-not-re-sort-once-the-pointer-left', resorted)

    // --- a cold workspace, clicked --------------------------------------------------------------
    const coldAt = await rowCentre('cold')
    if (!coldAt) return finish(false, 'no-cold-row')
    pointTo(coldAt)
    await sleep(250)
    wc.sendInputEvent({ type: 'mouseDown', x: coldAt.x, y: coldAt.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: coldAt.x, y: coldAt.y, button: 'left', clickCount: 1 })
    await sleep(400)
    const clicked = await js<{ active: string; today: unknown; usedAgo: number; scratchUsed: boolean; layout: string; heat: string; selected: boolean; divider: string }>(`(() => {
      ${helpers}
      const a = activity('ws-cold')
      return { active: store.getState().activeWorkspaceId, today: a.days[0], usedAgo: Date.now() - a.usedAt,
        scratchUsed: activity('__scratch__').days.some(d => d.used > 0),
        layout: layout().join(' '), heat: heat('cold'), selected: row('cold').classList.contains('row--selected'), divider: divider() }
    })()`)
    trail.push(`clicking cold switched to ${clicked.active} and counted ${JSON.stringify(clicked.today)}`)
    if (clicked.active !== 'ws-cold') return finish(false, 'the-click-did-not-switch', clicked)
    if (JSON.stringify(clicked.today) !== JSON.stringify({ day: booted.today, used: 1, output: 0 }) || clicked.usedAgo > 5000) {
      return finish(false, 'switching-was-not-counted-as-use', clicked)
    }
    if (clicked.scratchUsed) return finish(false, 'the-press-in-the-list-counted-for-the-workspace-left')
    if (clicked.heat !== 'cool' || !clicked.selected) return finish(false, 'a-clicked-cold-workspace-did-not-warm', clicked)
    if (clicked.layout !== resorted) return finish(false, 'the-clicked-row-moved-under-the-pointer', clicked)
    if (!clicked.divider.includes('Cold · 1')) return finish(false, 'divider-still-counts-the-clicked-one', clicked.divider)
    trail.push(`it warmed where it was, under the pointer: ${clicked.layout}`)
    pointTo(away)
    await sleep(400)
    const promoted = await layout()
    trail.push(`pointer gone: ${promoted}`)
    if (promoted !== 'Scratch cool hot agent warm cold before garbled new | stale') return finish(false, 'clicked-workspace-did-not-move-up', promoted)

    // --- a minute counts once -----------------------------------------------------------------
    const usedBefore = await js<number>(`window.__rigee.store.getState().activityByWorkspace['ws-cold'].days[0].used`)
    for (let i = 0; i < 5; i++) {
      keystroke(wc, 'Shift')
      await sleep(30)
    }
    await sleep(200)
    const usedAfter = await js<number>(`window.__rigee.store.getState().activityByWorkspace['ws-cold'].days[0].used`)
    trail.push(`five keystrokes took the minutes from ${usedBefore} to ${usedAfter}`)
    if (usedAfter - usedBefore > 1) return finish(false, 'keystrokes-counted-more-than-once-a-minute')

    // --- terminals printing, with nobody looking ---------------------------------------------
    const printing = await js<{ ok: boolean; stage?: string; left?: number; chatty?: WorkspaceActivity; quiet?: WorkspaceActivity | null; scratch?: WorkspaceActivity }>(`(async () => {
      ${helpers}
      const s = store.getState()
      s.setWorkspaces([...s.workspaces, workspace('ws-chatty', 'chatty'), workspace('ws-quiet', 'quiet')])
      await sleep(100)
      store.getState().setActiveWorkspace('ws-chatty')
      const chattyTab = newTerminalTab()
      store.getState().openTab('ws-chatty', chattyTab)
      if (!(await until(() => getTerminal(paneKey(chattyTab.id, chattyTab.activeLeafId))?.paneId, 15000))) return { ok: false, stage: 'chatty-terminal-never-started' }
      // Away before it prints: its shell waits three seconds first.
      store.getState().setActiveWorkspace('ws-quiet')
      const left = Date.now()
      const quietTab = newTerminalTab()
      store.getState().openTab('ws-quiet', quietTab)
      if (!(await until(() => getTerminal(paneKey(quietTab.id, quietTab.activeLeafId))?.paneId, 15000))) return { ok: false, stage: 'quiet-terminal-never-started' }
      if (!(await until(() => activity('ws-chatty')?.outputAt, 10000))) return { ok: false, stage: 'output-in-the-background-not-counted' }
      await sleep(1000)
      return { ok: true, left, chatty: activity('ws-chatty'), quiet: activity('ws-quiet') ?? null, scratch: activity('__scratch__') }
    })()`)
    if (!printing.ok) return finish(false, printing.stage ?? 'printing')
    trail.push(`chatty printed ${printing.chatty!.outputAt! - printing.left!} ms after it was left: ${JSON.stringify(printing.chatty!.days[0])}`)
    if (printing.chatty!.outputAt! <= printing.left!) return finish(false, 'output-was-counted-before-it-was-in-the-background')
    if (printing.chatty!.days[0]!.output !== 1) return finish(false, 'a-burst-counted-other-than-once', printing.chatty)
    if (printing.quiet?.outputAt) return finish(false, 'a-prompt-counted-as-output', printing.quiet)
    if (printing.scratch?.outputAt) return finish(false, 'scratch-prompt-counted-as-output', printing.scratch)
    trail.push('a prompt is not output: neither quiet nor Scratch has any')

    // --- clearing out the cold --------------------------------------------------------------
    // From the header, which is always in view: the divider's own button is at the bottom of a list
    // that scrolls.
    if (!(await js<boolean>(`!!document.querySelector('.heat-divider__review')`))) return finish(false, 'no-review-button-on-the-divider')
    if (!(await clickAt(wc, '.heat-hint'))) return finish(false, 'no-cold-hint')
    // Fetched on demand, and React holds a freshly suspended boundary back for a moment even when
    // the chunk is already there: waited for, not slept on.
    await js(`(async () => { ${helpers}; await until(() => document.querySelector('.heat-review'), 3000) })()`)
    const panel = (): Promise<{ names: string[]; checked: boolean[]; button: string; disabled: boolean } | null> => js(`(() => {
      const p = document.querySelector('.heat-review')
      if (!p) return null
      const b = p.querySelector('.btn--primary')
      return { names: [...p.querySelectorAll('.heat-review__name')].map(n => n.textContent),
        checked: [...p.querySelectorAll('input')].map(i => i.checked), button: b.textContent, disabled: b.disabled }
    })()`)
    const opened = await panel()
    trail.push(`the checklist: ${JSON.stringify(opened)}`)
    if (!opened) return finish(false, 'review-did-not-open')
    if (opened.names.join() !== 'stale' || opened.checked.join() !== 'true' || opened.button !== 'Remove 1 Workspace') {
      return finish(false, 'checklist-wrong', opened)
    }
    await clickAt(wc, '.heat-review__item input')
    await sleep(150)
    const unticked = await panel()
    if (unticked?.button !== 'Remove 0 Workspaces' || !unticked.disabled) return finish(false, 'unticking-did-not-take-it-out', unticked)
    await clickAt(wc, '.heat-review__item input')
    await sleep(150)
    await shoot('heat-review')
    await clickAt(wc, '.heat-review .btn--primary')
    const cleared = await js<{ ok: boolean; panel: boolean; divider: string; record: boolean; layout: string }>(`(async () => {
      ${helpers}
      const ok = !!(await until(() => !store.getState().workspaces.some(w => w.id === 'ws-stale'), 5000))
      await sleep(200)
      return { ok, panel: !!document.querySelector('.heat-review'), divider: divider(), record: !!activity('ws-stale'), layout: layout().join(' ') }
    })()`)
    trail.push(`after removing: ${cleared.layout}`)
    if (!cleared.ok) return finish(false, 'stale-not-removed', cleared)
    if (cleared.panel || cleared.divider || cleared.record) return finish(false, 'removal-left-something-behind', cleared)

    // --- what reached the disk ----------------------------------------------------------------
    let doc = readDoc()
    for (let i = 0; i < 30 && (doc.ui?.['ws-stale'] || !doc.ui?.['ws-chatty']?.activity?.outputAt); i++) {
      await sleep(100)
      doc = readDoc()
    }
    const hot = doc.ui?.['ws-hot']?.activity
    const before = doc.ui?.['ws-before']?.activity
    const garbled = doc.ui?.['ws-garbled']?.activity
    trail.push(`on disk: hot has ${hot?.days.length} days, before ${JSON.stringify(before)}, garbled ${JSON.stringify(garbled)}`)
    if (hot?.days.length !== 12) return finish(false, 'activity-not-persisted', hot)
    if (before?.since !== booted.today || before?.days.length !== 0) return finish(false, 'the-fresh-record-not-persisted', before)
    if (garbled?.since !== booted.today) return finish(false, 'the-garbled-record-persisted-as-it-was', garbled)
    if (!doc.ui?.['ws-chatty']?.activity?.outputAt) return finish(false, 'output-not-persisted')
    if (doc.ui?.['ws-stale'] || doc.workspaces?.some((w) => w.id === 'ws-stale')) return finish(false, 'removed-workspace-still-on-disk')
    trail.push('the removed workspace and its record are gone from disk')

    finish(true, 'heat')
  } catch (err) {
    console.error('[smoke:heat] threw:', err)
    finish(false, 'threw')
  }
}

/**
 * End-to-end check of terminals at work: an agent and a build running in a workspace nobody is
 * looking at, counted on its row with a light along it; both counted again as finished unseen once
 * they stop — the agent alive and silent, the build gone — and the count followed to the terminal,
 * which clears it; a tab's dot and a split pane's mark doing the same; and neither somebody typing
 * nor a quick command counted as work. Real programs under a real shell with job control, real
 * keystrokes, real clicks.
 *
 * `RIGEE_SHOT_DIR` leaves PNGs of the counts and of a finished split pane.
 */
async function runRunningSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  const dir = app.getPath('userData')
  const trail: string[] = []
  const js = async <T>(code: string): Promise<T> => (await wc.executeJavaScript(code, true)) as T
  const finish = (ok: boolean, stage: string, extra?: unknown): void => {
    console.log('[smoke:running]', JSON.stringify({ ok, stage, trail, ...(extra === undefined ? {} : { extra }) }))
    app.exit(ok ? 0 : 1)
  }
  const shoot = async (name: string): Promise<void> => {
    const to = process.env.RIGEE_SHOT_DIR
    if (!to) return
    writeFileSync(join(to, `${name}.png`), (await wc.capturePage()).toPNG())
    trail.push(`photographed ${name}`)
  }
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const folders = Object.fromEntries(['busy', 'quiet'].map((name) => {
    const path = join(dir, 'running', name)
    mkdirSync(path, { recursive: true })
    return [name, path]
  }))
  const helpers = `
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const { store, getTerminal, paneKey, newTerminalTab } = window.__rigee
    const until = async (test, ms = 10000) => {
      for (let waited = 0; waited < ms; waited += 100) { const v = test(); if (v) return v; await sleep(100) }
      return null
    }
    const folders = ${JSON.stringify(folders)}
    const run = (workspaceId, paneId, script) =>
      window.rigee.writeTerminal(workspaceId, paneId, 'sh ' + ${JSON.stringify(dir)} + '/' + script + '\\r')
    const row = (label) => [...document.querySelectorAll('.workspace-list .row')].find(r => r.querySelector('.row__label')?.textContent === label)
    const badge = (label, kind) => row(label)?.querySelector('.job-badge--' + kind)
    const counts = (label) => ({ working: badge(label, 'working')?.textContent ?? null, finished: badge(label, 'finished')?.textContent ?? null,
      light: !!row(label)?.classList.contains('row--working') })
    const s = () => store.getState()`
  /** The middle of the first element matching `selector` that is on screen, as a pointer reaches it. */
  const centre = (selector: string, index = 0): Promise<{ x: number; y: number } | null> => js(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.offsetParent !== null)[${index}]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  const click = async (selector: string, index = 0): Promise<boolean> => {
    const at = await centre(selector, index)
    if (!at) return false
    wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    return true
  }

  try {
    // --- two terminals in a workspace, then away from it -----------------------------------------
    const opened = await js<{ ok: boolean; stage?: string; t1?: string; t2?: string; p1?: string; p2?: string }>(`(async () => {
      ${helpers}
      if (!(await until(() => s().ready, 15000))) return { ok: false, stage: 'never-ready' }
      const workspace = (id, name) => ({ id, name, createdAt: Date.now(), lastOpenedAt: Date.now(),
        folders: [{ path: folders[name], name, isGitRepo: false, repoRoot: null }] })
      s().setWorkspaces([...s().workspaces, workspace('ws-busy', 'busy'), workspace('ws-quiet', 'quiet')])
      s().setActiveWorkspace('ws-busy')
      const open = async () => {
        const tab = newTerminalTab()
        s().openTab('ws-busy', tab)
        return { tab, paneId: await until(() => getTerminal(paneKey(tab.id, tab.activeLeafId))?.paneId, 15000) }
      }
      const one = await open()
      const two = await open()
      if (!one.paneId || !two.paneId) return { ok: false, stage: 'terminals-never-started' }
      s().setActiveWorkspace('ws-quiet')
      await sleep(500)
      return { ok: true, t1: one.tab.id, t2: two.tab.id, p1: one.paneId, p2: two.paneId }
    })()`)
    if (!opened.ok) return finish(false, opened.stage ?? 'open')
    const { t1, t2, p1, p2 } = opened as Required<typeof opened>
    trail.push(`busy has ${p1} in ${t1} and ${p2} in ${t2}; quiet is on screen`)

    // --- at work, with nobody looking ------------------------------------------------------------
    const working = await js<{ ok: boolean; counts: unknown; programs?: unknown }>(`(async () => {
      ${helpers}
      run('ws-busy', ${JSON.stringify(p1)}, 'agent.sh')
      run('ws-busy', ${JSON.stringify(p2)}, 'build.sh')
      const ok = !!(await until(() => ${JSON.stringify(p1)} in s().workingPanes && ${JSON.stringify(p2)} in s().workingPanes, 9000))
      await sleep(300)
      return { ok, counts: counts('busy'), programs: s().workingPanes }
    })()`)
    trail.push(`at work: ${JSON.stringify(working.counts)}, running ${JSON.stringify(working.programs)}`)
    if (!working.ok) return finish(false, 'work-in-the-background-not-noticed', working)
    if (JSON.stringify(working.counts) !== JSON.stringify({ working: '2', finished: null, light: true })) {
      return finish(false, 'busy-row-does-not-say-two-at-work', working.counts)
    }
    // The light along the row is mid-run in the photograph, wherever its animation happens to be —
    // in a hidden window, at its first frame, which is off the row's left end.
    await js(`document.head.insertAdjacentHTML('beforeend', '<style id="smoke-still">.row--working::after { animation-delay: -0.9s !important; animation-play-state: paused !important }</style>')`)
    await shoot('running-working')
    await js(`document.getElementById('smoke-still')?.remove()`)

    // --- finished, unseen: the agent waiting, the build gone ------------------------------------
    const done = await js<{ ok: boolean; counts: unknown; unseen?: Record<string, string>; title?: string }>(`(async () => {
      ${helpers}
      const ok = !!(await until(() => ${JSON.stringify(p1)} in s().unseenPanes && ${JSON.stringify(p2)} in s().unseenPanes, 16000))
      await sleep(300)
      return { ok, counts: counts('busy'), unseen: s().unseenPanes, title: badge('busy', 'finished')?.title }
    })()`)
    trail.push(`finished: ${JSON.stringify(done.counts)}, "${done.title}"`)
    if (!done.ok) return finish(false, 'finishing-unseen-not-noticed', done)
    if (JSON.stringify(done.counts) !== JSON.stringify({ working: null, finished: '2', light: false })) {
      return finish(false, 'busy-row-does-not-say-two-finished', done.counts)
    }
    if (!done.unseen?.[p1] || !done.title?.includes(done.unseen[p1]!)) return finish(false, 'finished-count-does-not-name-the-program', done)
    await shoot('running-finished')

    // --- the count followed, then the tab with the dot ----------------------------------------
    if (!(await click('.job-badge--finished'))) return finish(false, 'no-finished-badge')
    const followed = await js<{ active: string; tab: string | null; unseen: string[]; counts: unknown; dots: string[] }>(`(async () => {
      ${helpers}
      await until(() => !(${JSON.stringify(p1)} in s().unseenPanes), 5000)
      await sleep(300)
      const r = s().rowsByWorkspace['ws-busy']
      const g = r.groups.find(x => x.id === r.activeGroupId)
      return { active: s().activeWorkspaceId, tab: g?.activeTabId ?? null, unseen: Object.keys(s().unseenPanes), counts: counts('busy'),
        dots: [...document.querySelectorAll('.tab')].filter(t => t.querySelector('.tab__finished')).map(t => t.querySelector('.tab__label').textContent) }
    })()`)
    trail.push(`the count went to ${followed.active}, tab ${followed.tab}; still unseen ${JSON.stringify(followed.unseen)}, a dot on ${followed.dots.length} tab(s)`)
    if (followed.active !== 'ws-busy' || followed.tab !== t1) return finish(false, 'the-count-did-not-go-to-the-terminal', followed)
    if (followed.unseen.join() !== p2) return finish(false, 'going-there-did-not-clear-it', followed)
    if (JSON.stringify(followed.counts) !== JSON.stringify({ working: null, finished: '1', light: false })) return finish(false, 'count-not-down-to-one', followed)
    if (followed.dots.length !== 1) return finish(false, 'no-dot-on-the-other-tab', followed)
    if (!(await click('.tab', 1))) return finish(false, 'no-second-tab')
    const cleared = await js<{ unseen: string[]; counts: unknown; dots: number }>(`(async () => {
      ${helpers}
      await until(() => !(${JSON.stringify(p2)} in s().unseenPanes), 5000)
      await sleep(200)
      return { unseen: Object.keys(s().unseenPanes), counts: counts('busy'), dots: document.querySelectorAll('.tab__finished').length }
    })()`)
    trail.push(`its tab opened: unseen ${JSON.stringify(cleared.unseen)}, ${cleared.dots} dot(s)`)
    if (cleared.unseen.length || cleared.dots || JSON.stringify(cleared.counts) !== JSON.stringify({ working: null, finished: null, light: false })) {
      return finish(false, 'opening-the-tab-did-not-clear-it', cleared)
    }

    // --- somebody typing is not work --------------------------------------------------------------
    for (let i = 0; i < 30; i++) {
      keystroke(wc, 'x', [], 'x')
      await sleep(100)
    }
    const typed = await js<{ working: boolean; unseen: boolean }>(`(async () => {
      ${helpers}
      await sleep(1500)
      return { working: ${JSON.stringify(p2)} in s().workingPanes, unseen: ${JSON.stringify(p2)} in s().unseenPanes }
    })()`)
    keystroke(wc, 'u', ['control'])
    trail.push(`three seconds of typing: working ${typed.working}`)
    if (typed.working || typed.unseen) return finish(false, 'typing-counted-as-work', typed)

    // --- a split pane, finished beside the one being typed in ------------------------------------
    const split = await js<{ ok: boolean; stage?: string; p3?: string }>(`(async () => {
      ${helpers}
      const tab = s().rowsByWorkspace['ws-busy'].groups.flatMap(g => g.tabs).find(t => t.id === ${JSON.stringify(t2)})
      const leaf = { kind: 'leaf', id: 'leaf-split', paneId: null }
      s().updateTab('ws-busy', tab.id, { root: { kind: 'split', id: 'split-1', direction: 'row', children: [tab.root, leaf], sizes: [0.5, 0.5] }, activeLeafId: leaf.id })
      const p3 = await until(() => getTerminal(paneKey(tab.id, leaf.id))?.paneId, 15000)
      return p3 ? { ok: true, p3 } : { ok: false, stage: 'split-never-started' }
    })()`)
    if (!split.ok) return finish(false, split.stage ?? 'split')
    const p3 = split.p3!
    if (!(await click('.term__pane', 0))) return finish(false, 'no-left-pane')
    await sleep(300)
    const marked = await js<{ ok: boolean; marked: string; counts: unknown; dots: number }>(`(async () => {
      ${helpers}
      run('ws-busy', ${JSON.stringify(p3)}, 'build.sh')
      const ok = !!(await until(() => ${JSON.stringify(p3)} in s().unseenPanes, 16000))
      await sleep(300)
      const panes = [...document.querySelectorAll('.term__pane')].filter(e => e.offsetParent !== null)
      return { ok, marked: panes.map(p => p.classList.contains('term__pane--finished')).join(),
        counts: counts('busy'), dots: document.querySelectorAll('.tab__finished').length }
    })()`)
    trail.push(`the split pane beside the keyboard finished: outlined ${marked.marked}, ${JSON.stringify(marked.counts)}`)
    if (!marked.ok) return finish(false, 'split-pane-finishing-not-noticed', marked)
    if (marked.marked !== 'false,true' || marked.dots !== 1) return finish(false, 'finished-split-pane-not-marked', marked)
    if (JSON.stringify(marked.counts) !== JSON.stringify({ working: null, finished: '1', light: false })) return finish(false, 'split-pane-not-counted', marked)
    await shoot('running-pane')
    if (!(await click('.term__pane', 1))) return finish(false, 'no-right-pane')
    const seen = await js<{ unseen: boolean; marked: boolean; counts: unknown }>(`(async () => {
      ${helpers}
      await until(() => !(${JSON.stringify(p3)} in s().unseenPanes), 5000)
      await sleep(200)
      return { unseen: ${JSON.stringify(p3)} in s().unseenPanes, marked: !!document.querySelector('.term__pane--finished'), counts: counts('busy') }
    })()`)
    trail.push(`clicked into it: unseen ${seen.unseen}, marked ${seen.marked}`)
    if (seen.unseen || seen.marked || JSON.stringify(seen.counts) !== JSON.stringify({ working: null, finished: null, light: false })) {
      return finish(false, 'clicking-the-pane-did-not-clear-it', seen)
    }

    // --- a quick command is not work ----------------------------------------------------------------
    const quick = await js<{ working: boolean; unseen: boolean }>(`(async () => {
      ${helpers}
      window.rigee.writeTerminal('ws-busy', ${JSON.stringify(p2)}, 'echo hello\\r')
      let working = false
      for (let i = 0; i < 30; i++) { working ||= ${JSON.stringify(p2)} in s().workingPanes; await sleep(100) }
      return { working, unseen: ${JSON.stringify(p2)} in s().unseenPanes }
    })()`)
    trail.push(`echo hello: working ${quick.working}, finished ${quick.unseen}`)
    if (quick.working || quick.unseen) return finish(false, 'a-quick-command-counted-as-work', quick)

    // --- a terminal closed while at work takes its count with it -----------------------------------
    const closed = await js<{ ok: boolean; counts: unknown; working: boolean; unseen: boolean }>(`(async () => {
      ${helpers}
      window.rigee.writeTerminal('ws-busy', ${JSON.stringify(p1)}, '\\r')
      await sleep(300)
      run('ws-busy', ${JSON.stringify(p1)}, 'agent.sh')
      if (!(await until(() => ${JSON.stringify(p1)} in s().workingPanes, 9000))) return { ok: false }
      s().closeTab('ws-busy', ${JSON.stringify(t1)})
      const gone = !!(await until(() => !(${JSON.stringify(p1)} in s().workingPanes), 5000))
      await sleep(200)
      return { ok: gone, counts: counts('busy'), working: ${JSON.stringify(p1)} in s().workingPanes, unseen: ${JSON.stringify(p1)} in s().unseenPanes }
    })()`)
    trail.push(`closed while at work: ${JSON.stringify(closed.counts)}`)
    if (!closed.ok || closed.unseen) return finish(false, 'a-closed-terminal-left-its-count-behind', closed)
    if (JSON.stringify(closed.counts) !== JSON.stringify({ working: null, finished: null, light: false })) return finish(false, 'counts-left-after-closing', closed)

    finish(true, 'running')
  } catch (err) {
    console.error('[smoke:running] threw:', err)
    finish(false, 'threw')
  }
}

/**
 * End-to-end check that what is on screen survives a restart: build a terminal with splits, a
 * browser tab and a SECOND editor group, let the debounce fire, then read the document main
 * actually wrote to disk.
 *
 * The row is asserted as a whole rather than tab by tab. `groups` and `groupSizes` are parallel
 * arrays on disk, and a document whose sizes are the wrong length or whose `activeGroupId` names a
 * group that is not there loads without complaint and then renders a centre pane that does not
 * fill the window, or one with no focused column at all.
 */
async function runPersistSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  try {
    const built = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store, newTerminalTab } = window.__rigee

        let scratch = null
        for (let i = 0; i < 60; i++) {
          scratch = store.getState().workspaces.find(w => w.id === '__scratch__')
          if (scratch && store.getState().ready) break
          await sleep(250)
        }
        if (!scratch) return JSON.stringify({ ok: false, stage: 'no-scratch' })
        store.getState().setActiveWorkspace(scratch.id)

        const tab = newTerminalTab()
        store.getState().openTab(scratch.id, tab)
        await sleep(1200)

        const press = (init) => {
          const target = document.activeElement ?? window
          target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
        }
        press({ key: 'd', metaKey: true })
        await sleep(1500)
        press({ key: 'd', metaKey: true, shiftKey: true })
        await sleep(1500)

        store.getState().openTab(scratch.id, {
          id: 'persist-browser-tab', kind: 'custom', viewType: 'browser.page',
          title: 'probe', pinned: false, state: { url: 'https://example.com/persisted' }
        })

        // A second group, so the document written below has a real row in it rather than the one
        // full-width group every migrated document already has.
        const row = () => store.getState().rowsByWorkspace[scratch.id]
        store.getState().splitGroup(scratch.id, row().activeGroupId, {
          id: 'persist-second-group-tab', kind: 'editor', title: 'beside.ts', pinned: false,
          filePath: '/persist-beside.ts', repoId: null, readOnly: true
        })

        // Longer than the save debounce.
        await sleep(1500)
        const t = row().groups.flatMap(g => g.tabs).find(x => x.id === tab.id)
        const count = (n) => n.kind === 'leaf' ? 1 : n.children.reduce((a, c) => a + count(c), 0)
        return JSON.stringify({
          ok: true,
          terminalTabId: tab.id,
          leaves: t ? count(t.root) : 0,
          groupsInMemory: row().groups.length,
          activeGroupId: row().activeGroupId
        })
      })()`,
      true
    )) as string
    const info = JSON.parse(built) as {
      ok: boolean
      terminalTabId?: string
      leaves?: number
      groupsInMemory?: number
      activeGroupId?: string
    }
    if (!info.ok) { console.log('[smoke:persist]', built); app.exit(1); return }

    const file = join(app.getPath('userData'), 'workspaces.json')
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      version: number
      keybindings?: { prefix?: string }
      ui?: Record<
        string,
        {
          groups?: Array<{ id?: string; tabs?: Array<Record<string, unknown>>; activeTabId?: string | null }>
          groupSizes?: number[]
          activeGroupId?: string
        }
      >
    }
    const row = doc.ui?.['__scratch__']
    const groups = row?.groups ?? []
    const tabs = groups.flatMap((g) => g.tabs ?? [])
    const sizes = row?.groupSizes ?? []
    const term = tabs.find((t) => t.id === info.terminalTabId)
    // A plugin tab on disk: the shell persisted the envelope, the plugin's own state rode along
    // inside it. Reading the url back out of `state` is the check that both halves survived.
    const browser = tabs.find((t) => t.kind === 'custom' && t.viewType === 'browser.page')

    const countLeaves = (n: unknown): number => {
      const node = n as { kind?: string; children?: unknown[] }
      if (!node || node.kind === 'leaf') return 1
      return (node.children ?? []).reduce((a: number, c) => a + countLeaves(c), 0)
    }

    const report = {
      version: doc.version,
      keybindingsSaved: doc.keybindings?.prefix ?? null,
      tabsOnDisk: tabs.length,
      terminalRestored: !!term,
      leavesInMemory: info.leaves,
      leavesOnDisk: term ? countLeaves((term as { root?: unknown }).root) : 0,
      browserUrlOnDisk:
        (browser as { state?: { url?: string } } | undefined)?.state?.url ?? null,
      groupsOnDisk: groups.length,
      groupsInMemory: info.groupsInMemory,
      sizesOnDisk: sizes,
      activeGroupOnDisk: row?.activeGroupId ?? null
    }
    const ok =
      report.terminalRestored &&
      report.leavesOnDisk === info.leaves &&
      report.leavesOnDisk === 3 &&
      report.browserUrlOnDisk === 'https://example.com/persisted' &&
      report.keybindingsSaved === 'ctrl+a' &&
      // A version that is merely reported is a version nobody notices going backwards: the
      // migration in main only runs for documents whose number says they need it.
      doc.version === PERSISTED_STATE_VERSION &&
      report.groupsOnDisk === 2 &&
      report.groupsOnDisk === info.groupsInMemory &&
      sizes.length === groups.length &&
      Math.abs(sizes.reduce((a, b) => a + b, 0) - 1) < 0.001 &&
      groups.every((g) => (g.tabs ?? []).length > 0) &&
      groups.some((g) => g.id === row?.activeGroupId) &&
      row?.activeGroupId === info.activeGroupId
    console.log('[smoke:persist]', JSON.stringify({ ok, ...report }))
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[smoke:persist] threw:', err)
    app.exit(1)
  }
}

/** One workspace's UI as v2 wrote it: a single tab list, a single active tab. */
type V2UiRecord = {
  tabs: Array<Record<string, unknown> & { id: string }>
  activeTabId: string
  layout: Record<string, unknown>
  /** Deliberately optional — the workspace that leaves it out is the point of the fixture. */
  expandedDirs?: string[]
}

/**
 * A hand-built v2 document, as a user upgrading would have on disk.
 *
 * Neither workspace has folders, which is not laziness: the explorer seeds `expandedDirs` on first
 * sight of a workspace that HAS roots, and that would overwrite the very absence this fixture
 * exists to watch. Both are still real persisted workspaces, unlike Scratch, so both are restored
 * and both are written back.
 */
function v2Document(dir: string): {
  version: number
  activeWorkspaceId: string
  workspaces: Array<Record<string, unknown>>
  ui: Record<string, V2UiRecord>
  keybindings: Record<string, string>
} {
  const layout = { leftView: null, leftWidth: 260, rightWidth: 320, leftCollapsed: false, rightCollapsed: false }
  const workspace = (id: string, name: string): Record<string, unknown> => ({
    id, name, folders: [], createdAt: 1, lastOpenedAt: 2
  })
  const editor = (id: string, filePath: string): Record<string, unknown> & { id: string } => ({
    id, kind: 'editor', title: id, pinned: false, filePath, repoId: null, readOnly: false
  })

  return {
    version: 2,
    activeWorkspaceId: 'ws-migrate-a',
    workspaces: [workspace('ws-migrate-a', 'alpha'), workspace('ws-migrate-b', 'beta')],
    ui: {
      'ws-migrate-a': {
        // The MIDDLE tab is the active one, so "the active tab survived" cannot pass by accident
        // on a migration that simply keeps the first or the last.
        tabs: v2Files().slice(0, 3).map((name, i) => editor('mig-a' + (i + 1), join(dir, name))),
        activeTabId: 'mig-a2',
        layout,
        expandedDirs: ['/private/tmp']
      },
      'ws-migrate-b': {
        // A terminal, because its pane tree is the most structured thing a tab carries and so the
        // most likely to be flattened by a migration that rebuilds tabs instead of moving them.
        tabs: [
          {
            id: 'mig-b1',
            kind: 'terminal',
            title: 'terminal',
            pinned: false,
            root: { kind: 'leaf', id: 'leaf-mig-b1', paneId: 'pty-that-died-with-the-old-process' },
            activeLeafId: 'leaf-mig-b1'
          },
          editor('mig-b2', join(dir, v2Files()[3]!))
        ],
        activeTabId: 'mig-b2',
        layout
      }
    },
    keybindings: { prefix: 'ctrl+a', splitRight: '|', splitDown: '-', closePane: 'x' }
  }
}

/**
 * The files the fixture's editor tabs point at, real ones so the active tab opens rather than
 * showing the "cannot read this" notice and making the report harder to read.
 *
 * A function and not a `const`, because `plantV2Document` runs during module evaluation — before a
 * module-level binding declared this far down the file has been initialised, which is a
 * ReferenceError and not the graceful kind.
 */
function v2Files(): string[] {
  return ['one.ts', 'two.ts', 'three.ts', 'beta.ts']
}

function plantV2Document(dir: string): void {
  for (const name of v2Files()) {
    writeFileSync(join(dir, name), `export const openedBeforeTheUpgrade = '${name}'\n`, 'utf8')
  }
  writeFileSync(join(dir, 'workspaces.json'), JSON.stringify(v2Document(dir), null, 2), 'utf8')
  console.log('[smoke:migrate] planted a v2 document in the throwaway userData directory')
}

/**
 * Copy `examples/hello-plugin` into the throwaway userData directory, as an install would.
 *
 * The example is a plugin with no build step — hand-written ESM leaving react, react/jsx-runtime
 * and @rigee/plugin-api external — so what this copies is exactly what somebody would unpack from
 * a tarball. Planted during module evaluation because the plugin directory is scanned once, at app
 * ready; copied after that, it would not be in the snapshot and the mode would prove nothing.
 */
function plantExamplePlugin(dir: string): void {
  const from = join(__dirnameESM, '../../examples/hello-plugin')
  const to = join(dir, 'plugins', 'hello')
  // Absent when this runs from the PACKAGED app: electron-builder packs `out/**` and nothing else,
  // so examples/ is not there. That is the interesting case to be able to test — file:// origin,
  // real CSP, code inside an asar — so the plugin may be planted by hand instead, and this skips
  // rather than throwing at module scope and taking the whole launch with it.
  if (!existsSync(from)) {
    console.log(`[smoke:diskplugin] no ${from}; using whatever is already in ${to}`)
    return
  }
  mkdirSync(join(to, '..'), { recursive: true })
  cpSync(from, to, { recursive: true })
  console.log(`[smoke:diskplugin] installed ${from} -> ${to}`)
}

/**
 * The whole third-party path, end to end: discovered, refused, approved, loaded, tampered with.
 *
 * This is the only test that runs code the app did not ship. Every part of the mechanism it
 * touches fails silently if it is wrong — an untrusted plugin whose contributions still resolve
 * looks exactly like a working one until you notice the shell tried to load code nobody approved;
 * an import map that misses means the plugin gets its own React and hooks throw somewhere deep in
 * a render; a hash that is not really checked means an update installs itself.
 *
 * Six steps, in order, each of which has to fail if the one before it did not really happen:
 *
 *   1. discovered, and NOT trusted. Its view must not resolve and its panel must not exist.
 *   2. approving it makes the view resolve.
 *   3. the panel renders — which is the import map working, because the panel is a React
 *      component written against the shell's react and drawn with the shell's icon set.
 *   4. its main half answers a command, over the same single plugin channel everything else uses.
 *   5. changing one byte on disk revokes trust by hash.
 *   6. after revoking, the renderer half is gone again.
 */
async function runDiskPluginSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  const entry = join(app.getPath('userData'), 'plugins', 'hello', 'dist', 'renderer.js')

  try {
    const before = installedPlugins().find((p) => p.manifest.id === 'hello')
    const discovered = before?.trust.status === 'untrusted'

    const result = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store, plugins } = window.__rigee
        const trail = []
        const fail = (stage, extra) =>
          JSON.stringify(Object.assign({ ok: false, stage, trail }, extra || {}))
        const rails = () => [...document.querySelectorAll('.activitybar button')].map(b => b.title)

        for (let i = 0; i < 80; i++) { if (store.getState().ready) break; await sleep(250) }
        if (!store.getState().ready) return fail('never-ready')

        // 1. Present in the list, absent from everything that would run it.
        trail.push('activity bar before approval: ' + rails().join(','))
        if (rails().some(t => t.includes('Hello'))) return fail('untrusted-plugin-reached-the-rail')
        if ((await plugins.activated()).includes('hello')) return fail('untrusted-plugin-activated')

        // 2. Approve, through the same call the plugins view makes.
        const granted = await window.rigee.invoke('plugins:setTrust', { id: 'hello', trusted: true })
        if (!granted.ok) return fail('approval-refused', granted)
        // The plugins view is what re-reads the list into the registry; open it the way a user
        // would rather than reaching past the UI.
        const pluginsButton = [...document.querySelectorAll('.activitybar button')]
          .find(b => b.title === 'Plugins')
        if (!pluginsButton) return fail('no-plugins-button')
        pluginsButton.click()
        await sleep(600)
        trail.push('activity bar after approval: ' + rails().join(','))
        if (!rails().some(t => t.includes('Hello'))) return fail('approved-plugin-not-in-the-rail')

        // 3. Open it. Rendering at all is the import map working: the panel is React, built
        //    elsewhere, against specifiers only the import map can resolve.
        const helloButton = [...document.querySelectorAll('.activitybar button')]
          .find(b => b.title.includes('Hello'))
        helloButton.click()
        for (let i = 0; i < 40; i++) {
          if (document.querySelector('#hello-ping')) break
          await sleep(100)
        }
        if (!document.querySelector('#hello-ping')) return fail('panel-never-rendered')
        const ws = document.querySelector('#hello-workspace')?.textContent ?? ''
        trail.push('panel rendered, ' + ws)
        // useActiveWorkspace is a HOOK from the shell's React. If the plugin had got its own copy
        // this is where it would have thrown instead of rendering.
        if (!ws.startsWith('workspace:')) return fail('plugin-hook-did-not-run', { ws })
        // The icon came from the shell's set, through the api package's icons object.
        if (!document.querySelector('#hello-ping')?.parentElement?.querySelector('svg')) {
          trail.push('note: no svg in the panel header')
        }

        // 4. Its main half, over the one plugin channel.
        document.querySelector('#hello-ping').click()
        for (let i = 0; i < 40; i++) {
          if (document.querySelector('#hello-pong')) break
          await sleep(100)
        }
        const pong = document.querySelector('#hello-pong')?.textContent ?? ''
        trail.push('main half: ' + (pong || 'no reply'))
        if (!pong.startsWith('pong from node')) return fail('main-half-did-not-answer')

        return JSON.stringify({ ok: true, trail })
      })()`,
      true
    )) as string
    const info = JSON.parse(result) as { ok: boolean; trail?: string[]; stage?: string }

    const afterApproval = installedPlugins().find((p) => p.manifest.id === 'hello')
    const mainLoaded = (await plugins()).active().includes('hello')

    // 5. One byte. The grant is pinned to the hash of the whole directory, so appending a comment
    //    is the same event as an update: the code is not the code that was approved.
    appendFileSync(entry, '\n// tampered\n', 'utf8')
    scanDiskPlugins(join(app.getPath('userData'), 'plugins'))
    const tampered = installedPlugins().find((p) => p.manifest.id === 'hello')

    // 6. And the renderer half is refused again — asked of the same function the host calls.
    const servableAfterTamper = rendererEntryUrl('hello') !== null

    const ok =
      discovered &&
      info.ok &&
      afterApproval?.trust.status === 'trusted' &&
      mainLoaded &&
      tampered?.trust.status === 'changed' &&
      !servableAfterTamper

    console.log(
      '[smoke:diskplugin]',
      JSON.stringify({
        ...info,
        ok,
        discoveredUntrusted: discovered,
        trustAfterApproval: afterApproval?.trust.status,
        mainHalfLoaded: mainLoaded,
        trustAfterTamper: tampered?.trust.status,
        servableAfterTamper
      })
    )
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[smoke:diskplugin] threw:', err)
    app.exit(1)
  }
}

/**
 * The v2 -> v3 document change, end to end, and the only proof that existing users keep their tabs.
 *
 * `migrate()` has no unit test and cannot easily get one: it only means anything in the sequence
 * that surrounds it — main reads the file, the renderer restores from what it was handed, and the
 * save debounce writes the new shape back over the old. The fixture is therefore planted during
 * module evaluation (see the top of this file), because `loadState()` caches for the life of the
 * process and nothing planted after boot would ever be read.
 *
 * Three failures, all silent: a dropped tab list loses every file the user had open; a `g0` that
 * did not survive means the renderer's tolerant fallback ran and main's migration did not; and a
 * manufactured empty expansion record tells the explorer the project was deliberately collapsed,
 * so every upgraded workspace opens shut for ever.
 *
 * The fixture is a v2 document, so it exercises BOTH steps in one run: v2 -> v3 turns one tab list
 * into one group, v3 -> v4 moves `expandedDirs` under `pluginState.explorer`. The explorer is a
 * plugin, so the assertions below read it where a plugin's state lives, not where the shell used
 * to keep it.
 */
async function runMigrateSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  try {
    const want = v2Document(app.getPath('userData'))
    // Cloned before the renderer's first save replaces `ui` in the cache: this is what main's
    // migrate() produced, which is a thing no assertion on the file can see afterwards.
    const migrated = structuredClone(loadState())
    const shown = (v: unknown): string => (v === undefined ? 'absent' : JSON.stringify(v))

    const expected = Object.entries(want.ui).map(([workspace, v2]) => ({
      workspace,
      tabIds: v2.tabs.map((t) => t.id).join(','),
      activeTabId: v2.activeTabId,
      expandedDirs: shown(v2.expandedDirs)
    }))

    const inMain = expected.map((e) => {
      const record = migrated.ui[e.workspace]
      const group = record?.groups?.[0]
      return {
        workspace: e.workspace,
        groups: record?.groups?.length ?? 0,
        groupId: group?.id ?? null,
        tabIds: (group?.tabs ?? []).map((t) => t.id).join(','),
        activeTabId: group?.activeTabId ?? null,
        expandedDirs: shown(record?.pluginState?.[EXPLORER_PLUGIN_ID]?.expandedDirs)
      }
    })
    const mainOk =
      migrated.version === PERSISTED_STATE_VERSION &&
      inMain.every(
        (got, i) =>
          got.groups === 1 &&
          got.groupId === 'g0' &&
          got.tabIds === expected[i]!.tabIds &&
          got.activeTabId === expected[i]!.activeTabId &&
          got.expandedDirs === expected[i]!.expandedDirs
      )

    const result = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store } = window.__rigee
        const st = () => store.getState()
        const trail = []
        const fail = (stage, extra) =>
          JSON.stringify(Object.assign({ ok: false, stage, trail }, extra || {}))

        for (let i = 0; i < 80; i++) { if (st().ready) break; await sleep(250) }
        if (!st().ready) return fail('never-ready')

        for (const want of ${JSON.stringify(expected)}) {
          const row = st().rowsByWorkspace[want.workspace]
          if (!row) return fail('workspace-not-restored', { workspace: want.workspace })
          trail.push(want.workspace + ': ' + row.groups.length + ' group(s) [' +
            row.groups.map(g => g.id).join(' ') + '] sizes ' + row.sizes.join(','))

          if (row.groups.length !== 1) {
            return fail('not-one-group-per-workspace', { workspace: want.workspace })
          }
          const group = row.groups[0]
          // g0 is the id main's migration mints. Anything with a grp_ prefix means the renderer's
          // own tolerant v2 fallback ran, so main handed it a v2 record and migrate() did nothing.
          if (group.id !== 'g0') return fail('group-did-not-come-from-mains-migration', { id: group.id })
          if (group.tabs.map(t => t.id).join(',') !== want.tabIds) {
            return fail('tabs-lost-in-migration',
              { workspace: want.workspace, got: group.tabs.map(t => t.id).join(','), want: want.tabIds })
          }
          if (group.activeTabId !== want.activeTabId) {
            return fail('active-tab-not-preserved',
              { workspace: want.workspace, got: group.activeTabId, want: want.activeTabId })
          }
          if (row.activeGroupId !== group.id) return fail('active-group-names-nothing')
          if (row.sizes.length !== 1 || Math.abs(row.sizes[0] - 1) > 0.001) {
            return fail('migrated-row-does-not-fill-the-width', { sizes: row.sizes })
          }

          const dirs = st().pluginStateByWorkspace[want.workspace]?.['${EXPLORER_PLUGIN_ID}']?.expandedDirs
          const got = dirs === undefined ? 'absent' : JSON.stringify(dirs)
          trail.push(want.workspace + ' expandedDirs: ' + got)
          if (got !== want.expandedDirs) {
            return fail('expanded-dirs-changed-shape',
              { workspace: want.workspace, got, want: want.expandedDirs })
          }
        }

        // The terminal's pane tree came back as a tree, and without the pty id that died with the
        // previous process — a restored tab pointing at a dead pane never binds to a shell.
        const term = st().rowsByWorkspace['ws-migrate-b'].groups[0].tabs.find(t => t.id === 'mig-b1')
        if (!term || term.kind !== 'terminal') return fail('terminal-tab-did-not-survive')
        if (!term.root || term.root.kind !== 'leaf') return fail('terminal-pane-tree-flattened')
        if (term.root.paneId !== null) return fail('restored-terminal-kept-a-dead-pty-id')
        trail.push('terminal tab restored with a cleared pane id')

        // Longer than the save debounce, so the document below is the one this boot wrote.
        await sleep(2000)
        return JSON.stringify({ ok: true, trail })
      })()`,
      true
    )) as string
    const info = JSON.parse(result) as { ok: boolean; trail?: string[] }

    const file = join(app.getPath('userData'), 'workspaces.json')
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      version?: number
      ui?: Record<
        string,
        {
          groups?: Array<{ id?: string; tabs?: Array<{ id?: string }>; activeTabId?: string | null }>
          groupSizes?: number[]
          activeGroupId?: string
          pluginState?: Record<string, { expandedDirs?: string[] }>
        }
      >
    }
    const onDisk = expected.map((e) => {
      const record = doc.ui?.[e.workspace]
      const group = record?.groups?.[0]
      return {
        workspace: e.workspace,
        groups: record?.groups?.length ?? 0,
        tabIds: (group?.tabs ?? []).map((t) => t.id).join(','),
        activeTabId: group?.activeTabId ?? null,
        groupSizes: record?.groupSizes ?? [],
        activeGroupId: record?.activeGroupId ?? null,
        expandedDirs: shown(record?.pluginState?.[EXPLORER_PLUGIN_ID]?.expandedDirs)
      }
    })
    // loadState keeps the pre-migration document beside the new one. A migration that goes wrong
    // is only recoverable while that copy exists, which makes it part of the contract.
    let backupBytes = 0
    try { backupBytes = statSync(`${file}.v2`).size } catch { /* reported as 0 below */ }

    const diskRowOk =
      doc.version === PERSISTED_STATE_VERSION &&
      backupBytes > 0 &&
      onDisk.every(
        (got, i) =>
          got.groups === 1 &&
          got.tabIds === expected[i]!.tabIds &&
          got.activeTabId === expected[i]!.activeTabId &&
          got.groupSizes.length === 1 &&
          Math.abs((got.groupSizes[0] ?? 0) - 1) < 0.001 &&
          got.activeGroupId === 'g0'
      )
    // Reported apart from the row so the log names the culprit. Care taken by the migration is
    // undone one save later by anything that writes an empty record for a workspace the user has
    // not opened yet — and the workspace then opens collapsed for ever.
    const diskExpandedDirsOk = onDisk.every((got, i) => got.expandedDirs === expected[i]!.expandedDirs)

    const ok = mainOk && info.ok && diskRowOk && diskExpandedDirsOk
    console.log(
      '[smoke:migrate]',
      JSON.stringify({
        ...info,
        ok,
        mainOk,
        diskRowOk,
        diskExpandedDirsOk,
        versionAfterMigration: migrated.version,
        versionOnDisk: doc.version,
        v2BackupBytes: backupBytes,
        expected,
        inMain,
        onDisk
      })
    )
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[smoke:migrate] threw:', err)
    app.exit(1)
  }
}

/**
 * Render the shell to a PNG at RIGEE_SHOT (default /tmp/rigee-shot.png). For looking at the
 * interface while working on it — capturePage grabs exactly the shell's own surface, so it needs
 * no screen recording permission and cannot catch anything else on the desktop.
 */
async function captureShot(): Promise<void> {
  const wc = shellWc()
  if (!wc || !window) { app.exit(1); return }
  try {
    // Give the boot sequence and any tab it restores a moment to paint.
    await new Promise((r) => setTimeout(r, 4000))
    if (process.env.RIGEE_SHOT_VIEW) {
      await wc.executeJavaScript(
        `(async () => {
          const item = [...document.querySelectorAll('.activitybar__item')]
            .find(b => b.title === ${JSON.stringify(process.env.RIGEE_SHOT_VIEW)})
          if (item) item.click()
          await new Promise(r => setTimeout(r, 600))
        })()`,
        true
      )
    }
    if (process.env.RIGEE_SHOT_COLLAPSED) {
      await wc.executeJavaScript(
        `window.__rigee.store.getState().setLayout({ leftCollapsed: true, rightCollapsed: true })`,
        true
      )
      await new Promise((r) => setTimeout(r, 600))
    }
    // Editor groups are reviewed by looking at them — a row is either obviously two columns or it
    // is not — and every number this file asserts about them would be identical if the second
    // group were rendered one pixel wide behind the first.
    if (process.env.RIGEE_SHOT_SPLIT) {
      const shape = (await wc.executeJavaScript(
        `(async () => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms))
          const { store, newTerminalTab } = window.__rigee
          const ws = store.getState().activeWorkspaceId
          if (!ws) return 'no workspace'
          const row = () => store.getState().rowsByWorkspace[ws]
          // Something on the left first: splitting an empty group would photograph two copies of
          // the "Nothing open" state, which shows the row and none of the point of it.
          if (row().groups.every(g => g.tabs.length === 0)) {
            store.getState().openTab(ws, newTerminalTab())
            await sleep(1200)
          }
          store.getState().splitGroup(ws, row().activeGroupId, newTerminalTab())
          await sleep(1800)
          return row().groups.map(g => g.tabs.length).join('+') + ' @ ' + row().sizes.join(',')
        })()`,
        true
      )) as string
      console.log(`[shot] split row: ${shape}`)
    }
    const image = await wc.capturePage()
    const out = process.env.RIGEE_SHOT ?? '/tmp/rigee-shot.png'
    writeFileSync(out, image.toPNG())
    console.log(`[shot] ${out} ${image.getSize().width}x${image.getSize().height}`)
    app.exit(0)
  } catch (err) {
    console.error('[shot] failed:', err)
    app.exit(1)
  }
}

/**
 * Give keyboard focus to whichever surface should have it.
 *
 * The shell, unless a plugin claims it first. The browser plugin does, because its tabs are
 * native views composited over the page: a BrowserWindow hands focus to its own webContents, not
 * to a child view, and without this the window looks alive and accepts no typing at all. Claims
 * are only consulted if the plugin host exists — before any plugin has run there is nothing over
 * the shell to focus.
 */
function focusActiveView(): void {
  if (!pluginHost?.focusClaimed()) shellWc()?.focus()
}

/**
 * The plugin boundary, end to end.
 *
 * Three claims, and the second is the one worth a test: that laziness is real. Opening a text file
 * must load the text editor and NOTHING else — no pdf.js, no browser plugin — and that is a
 * negative the DOM cannot show, so it is asserted against the renderer host's own activation list
 * and again in main against the command registry. If a static import ever leaks a plugin into the
 * entry chunk, `pnpm perf:check` catches the bytes and this catches the behaviour.
 */
async function runPluginsSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  try {
    // Its own fixture in the throwaway data directory, so the check does not depend on the repo
    // being on disk — a packaged app has no src/ to open.
    const textFixture = join(app.getPath('userData'), 'smoke.ts')
    writeFileSync(textFixture, 'export const answer = 42\n', 'utf8')
    // Three by two, RGBA, half of it transparent: small enough to inline, odd enough that a viewer
    // reporting the wrong size cannot pass by accident.
    const imageFixture = join(app.getPath('userData'), 'smoke.png')
    writeFileSync(
      imageFixture,
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAFElEQVR4nGP4z8DwHwgbQBQDMgcAeyoI+eLGsqMAAAAASUVORK5CYII=', 'base64')
    )
    // And one bigger than any pane, which has to open shrunk to fit.
    const bigImageFixture = join(app.getPath('userData'), 'smoke-big.png')
    writeFileSync(bigImageFixture, solidPng(2000, 1500))

    const result = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store, plugins } = window.__rigee
        const trail = []
        const st = () => store.getState()
        const fail = (stage, extra) =>
          JSON.stringify(Object.assign({ ok: false, stage, trail }, extra || {}))

        for (let i = 0; i < 60; i++) { if (st().ready) break; await sleep(250) }
        if (!st().ready) return fail('never-ready')

        // Declarative resolution, from manifests alone.
        const pdfView = plugins.resolveViewType('/tmp/a.pdf')
        const textView = plugins.resolveViewType('/tmp/a.ts')
        trail.push('.pdf resolves to ' + pdfView + ', .ts resolves to ' + textView)
        if (pdfView !== 'pdf.preview') return fail('pdf-editor-not-declared')
        if (textView !== 'text-editor.monaco') return fail('text-editor-is-not-the-floor')
        const imageViews = ['/tmp/a.png', '/tmp/A.JPG', '/tmp/a.webp', '/tmp/a.gif'].map(p => plugins.resolveViewType(p))
        trail.push('images resolve to ' + [...new Set(imageViews)].join(','))
        if (imageViews.some(v => v !== 'image.preview')) return fail('image-viewer-not-declared', { imageViews })
        // SVG is source people edit, and there is no "open with" to get back to the text.
        if (plugins.resolveViewType('/tmp/a.svg') !== 'text-editor.monaco') return fail('svg-taken-from-the-text-editor')

        // The source control panel is in the right rail and visible by default, so its plugin
        // should come up on its own shortly after first paint.
        for (let i = 0; i < 40; i++) {
          if (document.querySelector('.scm__body')) break
          await sleep(250)
        }
        if (!document.querySelector('.scm__body')) return fail('scm-panel-never-rendered')
        trail.push('scm panel rendered')

        const scratch = st().workspaces.find(w => w.id === '__scratch__')
        if (!scratch) return fail('no-scratch')
        store.getState().setActiveWorkspace(scratch.id)

        // Open a text file. The text editor must load; the PDF plugin must not.
        store.getState().openTab(scratch.id, {
          id: 'plugins-smoke-text', kind: 'editor', title: 'smoke.ts', pinned: false,
          filePath: ${JSON.stringify(textFixture)}, repoId: null, readOnly: true,
          viewType: 'text-editor.monaco'
        })
        for (let i = 0; i < 60; i++) {
          if (document.querySelector('.monaco-editor')) break
          await sleep(250)
        }
        if (!document.querySelector('.monaco-editor')) return fail('monaco-never-mounted')
        trail.push('monaco mounted from the text-editor plugin')

        const loaded = await plugins.activated()
        trail.push('plugins loaded: ' + loaded.join(',') )
        if (!loaded.includes('text-editor')) return fail('text-editor-not-active')
        if (loaded.includes('pdf')) return fail('pdf-plugin-loaded-for-a-text-file')
        if (loaded.includes('image')) return fail('image-plugin-loaded-for-a-text-file')
        if (loaded.includes('browser')) return fail('browser-plugin-loaded-unprompted')

        // --- the activity bar -------------------------------------------------
        const rail = () => [...document.querySelectorAll('.activitybar__item')]
        const railTitles = () => rail().map(b => b.title)
        trail.push('activity bar: ' + railTitles().join(','))
        if (!railTitles().includes('Explorer')) return fail('no-explorer-in-the-rail')
        if (!railTitles().includes('Plugins')) return fail('no-plugins-in-the-rail')

        // The explorer is a plugin now, so the tree on screen proves it activated.
        if (!document.querySelector('.explorer__body')) return fail('explorer-view-not-rendered')

        rail().find(b => b.title === 'Plugins').click()
        await sleep(400)
        if (!document.querySelector('.plugins__body')) return fail('plugins-view-did-not-open')
        if (document.querySelector('.explorer__body')) return fail('both-left-views-visible')
        trail.push('plugins view opened, explorer replaced')

        const rows = () => [...document.querySelectorAll('.plugins__row')]
        trail.push('plugin rows: ' + rows().length)
        if (rows().length < 5) return fail('not-every-plugin-listed', { n: rows().length })

        // --- switching one off ------------------------------------------------
        // The PDF plugin, because the effect is checkable in one line: with it gone, a .pdf has
        // to fall through to the editor of last resort rather than resolve to a viewer that is
        // not running.
        if (plugins.resolveViewType('/tmp/a.pdf') !== 'pdf.preview') return fail('pdf-not-claimed')
        const pdfRow = rows().find(r => (r.textContent || '').includes('PDF Viewer'))
        if (!pdfRow) return fail('no-pdf-row')
        pdfRow.querySelector('.plugins__toggle').click()
        await sleep(600)

        const afterOff = plugins.resolveViewType('/tmp/a.pdf')
        trail.push('.pdf resolves to ' + afterOff + ' with the plugin off')
        if (afterOff !== 'text-editor.monaco') return fail('disabled-plugin-still-claims-pdf')

        // And the same switch brings it back.
        rows().find(r => (r.textContent || '').includes('PDF Viewer'))
          .querySelector('.plugins__toggle').click()
        await sleep(600)
        const afterOn = plugins.resolveViewType('/tmp/a.pdf')
        trail.push('.pdf resolves to ' + afterOn + ' with the plugin back on')
        if (afterOn !== 'pdf.preview') return fail('re-enabling-did-not-restore-the-editor')

        return JSON.stringify({ ok: true, trail, loaded })
      })()`,
      true
    )) as string
    const info = JSON.parse(result) as { ok: boolean; trail?: string[] }

    /*
     * Main's own half of the claim, in two steps.
     *
     * First: nothing is loaded here yet. The renderer has a source control panel on screen, but
     * Scratch has no folders, so the panel had nothing to ask — and the main-side host has
     * therefore never even been constructed. That is the laziness working at the process level,
     * and it is only visible from here.
     *
     * Then: one real command makes the half appear, on demand, with its commands registered. The
     * renderer→main→plugin round trip itself is covered by `pnpm smoke:pdf`, which reads bytes,
     * and by `pnpm smoke:multirepo`, which drives source control against real repositories.
     */
    /*
     * Main's half of the claim, in three steps.
     *
     * First: nothing is loaded here yet. The renderer has a source control panel on screen, but
     * Scratch has no folders, so the panel had nothing to ask — and the main-side host has
     * therefore never even been constructed. That is the laziness working at the process level,
     * and it is only visible from here.
     */
    const hostBefore = pluginHost === null
    const host = await plugins()

    // Then: one real command makes the half appear, on demand, with its commands registered.
    await host.invoke('scm:statusAll', { repoRoots: [] })
    const commands = host.commands()
    const active = host.active()

    /*
     * Finally: switch source control off from the plugins view and check that "disabled" means
     * stopped in THIS process too. Its main half is where the filesystem watchers and the
     * `git cat-file --batch` children live, so a renderer-only notion of disabled would leave all
     * of that running behind a panel that had vanished.
     */
    const off = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const rows = [...document.querySelectorAll('.plugins__row')]
        const row = rows.find(r => (r.textContent || '').includes('Source Control'))
        if (!row) return JSON.stringify({ ok: false, stage: 'no-scm-row' })
        row.querySelector('.plugins__toggle').click()
        await sleep(800)
        if (document.querySelector('.scm__body')) {
          return JSON.stringify({ ok: false, stage: 'disabled-scm-panel-still-on-screen' })
        }
        return JSON.stringify({ ok: true })
      })()`,
      true
    )) as string

    const refused = await host
      .invoke('scm:statusAll', { repoRoots: [] })
      .then(() => false)
      .catch(() => true)
    const disabled = JSON.parse(
      readFileSync(join(app.getPath('userData'), 'workspaces.json'), 'utf8')
    ).disabledPlugins as string[] | undefined

    /*
     * Last, because it is the one that builds the main-side host from the renderer: an image. The
     * viewer loads on demand, reads the bytes through its main half, and shows the picture at its
     * own size — it is smaller than the pane, and fitting never enlarges.
     */
    const imageActiveBefore = host.active().includes('image')
    const shown = JSON.parse(
      (await wc.executeJavaScript(
        `(async () => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms))
          const { store, plugins } = window.__rigee
          const fail = (stage, extra) => JSON.stringify(Object.assign({ ok: false, stage }, extra || {}))
          store.getState().openTab('__scratch__', {
            id: 'plugins-smoke-image', kind: 'editor', title: 'smoke.png', pinned: false,
            filePath: ${JSON.stringify(imageFixture)}, repoId: null, readOnly: true,
            viewType: plugins.resolveViewType(${JSON.stringify(imageFixture)})
          })
          let pic = null
          for (let i = 0; i < 60; i++) {
            pic = document.querySelector('.image__picture')
            if (pic && pic.complete && pic.naturalWidth > 0 && pic.style.width) break
            await sleep(250)
          }
          if (!pic || pic.naturalWidth !== 3 || pic.naturalHeight !== 2) {
            return fail('image-never-shown', { natural: pic ? [pic.naturalWidth, pic.naturalHeight] : null })
          }
          const info = document.querySelector('.image__info')?.textContent || ''
          const zoom = document.querySelector('.image__zoom')?.textContent || ''
          let shown = info + ' at ' + zoom + ', drawn ' + pic.style.width + ' × ' + pic.style.height
          if (!info.startsWith('3 × 2 · PNG')) return fail('image-info-wrong', { shown })
          if (zoom !== '100%' || pic.style.width !== '3px') return fail('a-small-image-was-enlarged-to-fit', { shown })
          if (!(await plugins.activated()).includes('image')) return fail('image-plugin-not-active')

          // A picture bigger than the pane opens fitted, and the keys move between that and its
          // real size.
          const big = ${JSON.stringify(bigImageFixture)}
          store.getState().openTab('__scratch__', {
            id: 'plugins-smoke-big', kind: 'editor', title: 'smoke-big.png', pinned: false,
            filePath: big, repoId: null, readOnly: true, viewType: plugins.resolveViewType(big)
          })
          let el = null
          for (let i = 0; i < 60; i++) {
            el = document.querySelector('.image__picture')
            if (el && el.naturalWidth === 2000 && el.style.width) break
            await sleep(250)
          }
          if (!el || el.naturalWidth !== 2000) return fail('big-image-never-shown')
          const zoomNow = () => document.querySelector('.image__zoom')?.textContent || ''
          const fitOn = () => [...document.querySelectorAll('.image__bar .btn')]
            .some(b => b.textContent === 'Fit' && b.classList.contains('btn--primary'))
          const fitted = zoomNow()
          if (!fitOn() || !(parseInt(fitted) < 100)) return fail('big-image-not-fitted', { fitted })
          const view = document.querySelector('.image__viewport')
          const key = async (k) => {
            view.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
            await sleep(200)
          }
          await key('1')
          if (zoomNow() !== '100%' || el.style.width !== '2000px' || fitOn()) return fail('1-is-not-actual-size', { zoom: zoomNow() })
          await key('-')
          const smaller = zoomNow()
          if (!(parseInt(smaller) < 100)) return fail('minus-did-not-zoom-out', { smaller })
          await key('0')
          if (zoomNow() !== fitted || !fitOn()) return fail('0-did-not-fit-again', { zoom: zoomNow(), fitted })
          shown += '; 2000 × 1500 opened at ' + fitted + ', 1 → 100%, − → ' + smaller + ', 0 → ' + zoomNow()
          return JSON.stringify({ ok: true, shown })
        })()`,
        true
      )) as string
    ) as { ok: boolean }

    const ok =
      info.ok &&
      (JSON.parse(off) as { ok: boolean }).ok &&
      hostBefore &&
      active.includes('scm') &&
      commands.some((c) => c.startsWith('scm:')) &&
      !active.includes('pdf') &&
      !active.includes('browser') &&
      refused &&
      (disabled ?? []).includes('scm') &&
      !host.active().includes('scm') &&
      shown.ok &&
      !imageActiveBefore &&
      host.active().includes('image')

    console.log(
      '[smoke:plugins]',
      JSON.stringify({
        ...info,
        ok,
        hostUnbuiltUntilAsked: hostBefore,
        mainActiveBeforeDisabling: active,
        disableInRenderer: JSON.parse(off),
        mainActiveAfterDisabling: host.active(),
        disabledPluginRefusedInMain: refused,
        disabledOnDisk: disabled,
        image: shown,
        imageMainHalfLoadedOnDemand: !imageActiveBefore && host.active().includes('image')
      })
    )
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[smoke:plugins] threw:', err)
    app.exit(1)
  }
}

/**
 * A one-page PDF with a known line of text, written by hand.
 *
 * `printToPDF` looked like the obvious fixture and is not: with the default `printBackground:
 * false` the shell prints as an empty content stream, so the check passed a blank page to the
 * viewer and then asserted the page was not blank. Thirty lines of PDF are worth more than that —
 * the bytes are deterministic, the marker is ours, and the text layer has something specific to
 * find, which turns "a canvas appeared" into "the document was parsed, rendered AND made
 * selectable".
 *
 * The xref offsets have to be right: pdf.js can reconstruct a broken table, and a fixture that
 * quietly exercises the recovery path instead of the normal one is not the test anyone wanted.
 */
/**
 * A PNG of any size, in one colour: for the image viewer's checks, which need a picture bigger
 * than the pane and cannot count on the repo's own images — a packaged app has no build/ folder.
 */
function solidPng(width: number, height: number): Buffer {
  const crc = (bytes: Buffer): number => {
    let c = ~0
    for (const b of bytes) {
      c ^= b
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc(body), 8 + data.length)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit truecolour, no interlace
  // Each row: filter byte 0, then RGB — the accent's indigo, so a screenshot shows it plainly.
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [0x81, 0x8c, 0xf8]).flat())])
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function minimalPdf(marker: string): Buffer {
  const content = `BT /F1 24 Tf 40 500 Td (${marker}) Tj ET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })

  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

/**
 * The PDF plugin, end to end: bytes over `plugin:invoke`, pdf.js in a real worker, ink on a canvas
 * and a text layer you could select.
 *
 * What it cannot cover is a CJK document with a predefined Adobe CMap — writing one by hand means
 * embedding a CID font. That path is guarded instead by `pnpm perf:check` asserting the cmaps were
 * emitted into the packaged build, which is the way it actually breaks.
 */
const PDF_SMOKE_MARKER = 'RIGEE-PDF-SMOKE'

async function runPdfSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  try {
    const pdf = join(app.getPath('userData'), 'smoke.pdf')
    writeFileSync(pdf, minimalPdf(PDF_SMOKE_MARKER))
    console.log(`[smoke:pdf] fixture ${pdf} ${statSync(pdf).size} bytes`)

    const result = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store, plugins, newTerminalTab, getTerminal, paneKey } = window.__rigee
        const trail = []
        const st = () => store.getState()
        const fail = (stage, extra) =>
          JSON.stringify(Object.assign({ ok: false, stage, trail }, extra || {}))

        for (let i = 0; i < 60; i++) { if (st().ready) break; await sleep(250) }
        const scratch = st().workspaces.find(w => w.id === '__scratch__')
        if (!scratch) return fail('no-scratch')
        store.getState().setActiveWorkspace(scratch.id)

        const path = ${JSON.stringify(pdf)}
        const viewType = plugins.resolveViewType(path)
        trail.push('resolved ' + viewType)
        if (viewType !== 'pdf.preview') return fail('pdf-not-claimed')

        store.getState().openTab(scratch.id, {
          id: 'pdf-smoke-tab', kind: 'editor', title: 'smoke.pdf', pinned: false,
          filePath: path, repoId: null, readOnly: true, viewType
        })

        // A rendered page is a canvas with a real backing store. pdf.js fetches its worker, the
        // bytes come over plugin:invoke, and the first page paints; 20 s is generous for all of it.
        // Scoped to the page column: xterm renders onto canvases too, and once the row is split
        // below there is a terminal on screen whose canvas would answer every question here.
        const pageCanvases = () => [...document.querySelectorAll('.pdf__pages canvas')]
        let canvas = null
        for (let i = 0; i < 80; i++) {
          await sleep(250)
          canvas = pageCanvases().find(c => c.width > 0 && c.height > 0)
          if (canvas) break
        }
        if (!canvas) {
          const notice = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200)
          return fail('no-page-rendered', { notice })
        }
        trail.push('page canvas ' + canvas.width + 'x' + canvas.height)

        // Non-blank: printToPDF of the shell always puts something on page 1. Sampled over the
        // WHOLE canvas, not a band at the top — printToPDF applies a default page margin, so the
        // first couple of hundred rows are legitimately empty and a band there proves nothing.
        const ctx = canvas.getContext('2d')
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        let ink = 0
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) ink++
        }
        trail.push('non-white pixels: ' + ink + ' of ' + (canvas.width * canvas.height))
        if (ink === 0) return fail('page-rendered-blank')

        // And the text layer, which is what makes the text selectable and searchable. Waited for
        // separately because it is built only after the page's canvas render resolves.
        let layerText = ''
        for (let i = 0; i < 40; i++) {
          const layer = document.querySelector('.textLayer')
          layerText = layer ? (layer.textContent || '') : ''
          if (layerText.includes(${JSON.stringify(PDF_SMOKE_MARKER)})) break
          await sleep(250)
        }
        trail.push('text layer: ' + JSON.stringify(layerText.slice(0, 60)))
        if (!layerText.includes(${JSON.stringify(PDF_SMOKE_MARKER)})) {
          return fail('text-layer-missing-the-marker')
        }

        const loaded = await plugins.activated()
        trail.push('plugins loaded: ' + loaded.join(','))
        if (!loaded.includes('pdf')) return fail('pdf-plugin-not-active')

        /*
         * And now the reason editor groups exist: a PDF and a terminal on screen AT THE SAME TIME.
         *
         * Every assertion above holds just as well for a viewer that is alone in the window, so
         * none of them would notice the re-layout killing it — a canvas that keeps its pixels but
         * is measured at zero width, a pdf.js worker torn down when the pane remounted in its new
         * column, a terminal whose pty never spawned because its group was never rendered. Each of
         * those looks like an empty half of the window and throws nothing.
         */
        const row = () => st().rowsByWorkspace[scratch.id]
        const strips = () => [...document.querySelectorAll('.tabstrip')]
        // Two titles: the button says "Split right" for anything that can exist twice and
        // "Move to a new group" for anything whose resources are keyed by tab id.
        const splitButton = () => {
          const strip = strips()[0]
          if (!strip) return null
          return [...strip.querySelectorAll('button')].find(b => {
            const title = (b.title || '').toLowerCase()
            return title.includes('split') || title.includes('new group')
          }) || null
        }
        if (!splitButton()) {
          const titles = strips()[0]
            ? [...strips()[0].querySelectorAll('button')].map(b => b.title).join(' | ')
            : '(no strip)'
          return fail('no-split-button', { titles })
        }
        splitButton().click()
        await sleep(800)
        trail.push('groups after the split: ' + row().groups.length)
        if (row().groups.length !== 2) return fail('split-made-no-second-group')
        if (document.querySelectorAll('.group').length !== 2) {
          return fail('groups-are-not-.group-elements')
        }

        // Into the OTHER column, by id rather than by whatever happens to be focused.
        const beside = row().groups[1].id
        const sideTerm = newTerminalTab()
        store.getState().openTab(scratch.id, sideTerm, beside)
        let handle = null
        for (let i = 0; i < 80; i++) {
          await sleep(250)
          handle = getTerminal(paneKey(sideTerm.id, sideTerm.activeLeafId))
          if (handle && handle.paneId) break
        }
        if (!handle || !handle.paneId) return fail('terminal-beside-the-pdf-never-got-a-pty')
        trail.push('terminal beside the pdf: pty ' + handle.paneId)

        /*
         * And it must actually RECEIVE. A pty id only proves main spawned a shell; the bytes come
         * back over a MessagePort established once per workspace, and two terminal tabs in two
         * groups both asking for one is precisely the case that used to close the live port and
         * drop whatever was in flight. Typing into the second group and waiting for the echo is
         * the only assertion that covers the transport end to end.
         */
        handle.term.input('echo SPLIT-PTY-$((7*6))' + String.fromCharCode(13), true)
        const read = () => {
          const b = handle.term.buffer.active
          let out = ''
          for (let i = 0; i < b.length; i++) out += (b.getLine(i)?.translateToString(true) ?? '')
          return out
        }
        let echoed = false
        for (let i = 0; i < 60; i++) {
          await sleep(250)
          if (read().includes('SPLIT-PTY-42')) { echoed = true; break }
        }
        trail.push('terminal in the second group echoed: ' + echoed)
        if (!echoed) return fail('terminal-in-the-second-group-never-echoed')

        // The viewer re-renders at its new width, so both the size and the ink are read again
        // rather than trusted from before the split.
        let sideBySide = null
        for (let i = 0; i < 80; i++) {
          await sleep(250)
          const c = pageCanvases().find(x => x.width > 0 && x.height > 0)
          if (!c) continue
          const rect = c.getBoundingClientRect()
          if (rect.width < 1 || rect.height < 1) continue
          const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
          let marks = 0
          for (let p = 0; p < px.length; p += 4) {
            if (px[p] < 250 || px[p + 1] < 250 || px[p + 2] < 250) marks++
          }
          if (marks > 0) { sideBySide = { w: c.width, h: c.height, css: Math.round(rect.width), ink: marks }; break }
        }
        if (!sideBySide) return fail('pdf-went-blank-when-the-row-was-split')
        trail.push('pdf after the split: ' + sideBySide.w + 'x' + sideBySide.h +
          ' (' + sideBySide.css + 'px wide on screen), ink ' + sideBySide.ink)

        // Both halves alive at once is the claim; the DOM is where it is either true or not.
        if (!document.querySelector('.term__pane')) return fail('no-terminal-pane-on-screen')
        if (!document.querySelector('.textLayer')) return fail('pdf-pane-left-the-screen')

        /*
         * And geometrically side by side, which none of the above would notice.
         *
         * The page canvas is sized from the zoom level, not from the group, so it measures 731px
         * whether its column is 700px or 2px wide — a row that collapsed one group to nothing
         * would satisfy every assertion up to here and show the user half a window.
         */
        const boxes = [...document.querySelectorAll('.group')].map(g => g.getBoundingClientRect())
        trail.push('group boxes: ' + boxes.map(b => Math.round(b.left) + '..' + Math.round(b.right)).join(' '))
        if (boxes.length !== 2) return fail('expected-two-group-boxes')
        if (boxes[0].width < 80 || boxes[1].width < 80) {
          return fail('a-group-was-squeezed-to-nothing', { widths: boxes.map(b => Math.round(b.width)) })
        }
        if (boxes[1].left < boxes[0].right - 2) return fail('groups-overlap-instead-of-sitting-side-by-side')

        return JSON.stringify({ ok: true, trail, sideBySide })
      })()`,
      true
    )) as string
    const info = JSON.parse(result) as { ok: boolean; trail?: string[] }

    // A viewer is a visual thing and the assertions above are all numeric. Setting RIGEE_SHOT
    // leaves a PNG of what was actually on screen, which is the difference between "a canvas had
    // ink in it" and "this looks like a PDF reader".
    if (process.env.RIGEE_SHOT) {
      writeFileSync(process.env.RIGEE_SHOT, (await wc.capturePage()).toPNG())
      console.log(`[smoke:pdf] shot ${process.env.RIGEE_SHOT}`)
    }

    const commands = pluginHost?.commands() ?? []
    const ok = info.ok && commands.includes('pdf:read')
    console.log('[smoke:pdf]', JSON.stringify({ ...info, ok, commands }))
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[smoke:pdf] threw:', err)
    app.exit(1)
  }
}

/**
 * Headless check that the renderer actually mounted, for `pnpm smoke` and CI. Reports what the
 * shell rendered and exits non-zero if React never produced any DOM.
 */
async function runSmokeTest(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  try {
    // Give React a beat to mount after did-finish-load.
    await new Promise((r) => setTimeout(r, 1500))
    const report = (await wc.executeJavaScript(
      `(async () => {
        const root = document.getElementById('root')
        const bridge = typeof window.rigee === 'object' && window.rigee !== null
        // Goes through the real preload bridge and the real IPC handler, so this also proves
        // PATH recovery worked: a packaged app launched from Finder starts with a PATH that
        // cannot see Homebrew.
        let platform = null
        try { platform = await window.rigee.invoke('app:getPlatformInfo') } catch (e) {
          platform = { error: String(e) }
        }
        return JSON.stringify({
          bridge,
          bridgeKeys: bridge ? Object.keys(window.rigee) : [],
          rootChildren: root ? root.children.length : -1,
          elements: document.querySelectorAll('*').length,
          platform,
          text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
        })
      })()`,
      true
    )) as string
    console.log('[smoke]', report, `shellFocused=${wc.isFocused()}`)
    const parsed = JSON.parse(report) as {
      bridge: boolean
      rootChildren: number
      platform: { shell?: string } | null
    }
    const ok = parsed.bridge && parsed.rootChildren > 0 && typeof parsed.platform?.shell === 'string'
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[smoke] failed:', err)
    app.exit(1)
  }
}

/**
 * End-to-end check of the terminal: open a tab, type into it through the real MessagePort path,
 * and assert the shell echoed the result back. Covers everything a human would exercise —
 * tmux attach, window creation, the byte transport in both directions, and xterm rendering.
 */
async function runTerminalSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  const log = (...a: unknown[]): void => console.log('[smoke:terminal]', ...a)
  try {
    const result = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store, getTerminal, paneKey, newTerminalTab } = window.__rigee
        const trail = []

        // The shell boots asynchronously (state load + platform probe) after did-finish-load.
        let scratch = null
        for (let i = 0; i < 60; i++) {
          scratch = store.getState().workspaces.find(w => w.id === '__scratch__')
          if (scratch && store.getState().ready) break
          await sleep(250)
        }
        if (!scratch) return JSON.stringify({ ok: false, stage: 'no-scratch-workspace', trail })
        store.getState().setActiveWorkspace(scratch.id)

        const tab = newTerminalTab()
        store.getState().openTab(scratch.id, tab)
        const leafId = tab.activeLeafId
        trail.push('tab opened')

        // Wait for the pty to be spawned and bound to the xterm instance.
        let handle = null
        for (let i = 0; i < 120; i++) {
          await sleep(250)
          handle = getTerminal(paneKey(tab.id, leafId))
          if (handle && handle.paneId) break
        }
        if (!handle) return JSON.stringify({ ok: false, stage: 'no-xterm-instance', trail })
        if (!handle.paneId) return JSON.stringify({ ok: false, stage: 'pty-never-bound', trail })
        trail.push('pty ' + handle.paneId)

        const read = () => {
          const b = handle.term.buffer.active
          let out = ''
          for (let i = 0; i < b.length; i++) out += (b.getLine(i)?.translateToString(true) ?? '') + String.fromCharCode(10)
          return out
        }

        await sleep(900)
        trail.push('output before typing: ' + read().trim().length + ' chars')

        const active = document.activeElement
        const focused = !!(active && handle.element.contains(active))
        trail.push('focus inside terminal: ' + focused + ' (' + (active ? active.tagName.toLowerCase() : 'none') + ')')

        let onDataFired = 0
        const probe = handle.term.onData(() => { onDataFired++ })
        handle.term.input('echo RIGEE-E2E-$((6*7))' + String.fromCharCode(13), true)
        probe.dispose()
        trail.push('onData fired ' + onDataFired + 'x')
        if (onDataFired !== 1) return JSON.stringify({ ok: false, stage: 'onData-not-1', trail })

        for (let i = 0; i < 40; i++) {
          await sleep(250)
          if (read().includes('RIGEE-E2E-42')) {
            return JSON.stringify({ ok: true, stage: 'echoed', trail })
          }
        }
        return JSON.stringify({
          ok: false, stage: 'no-echo', trail, tail: read().trim().slice(-300)
        })
      })()`,
      true
    )) as string
    log(result)
    app.exit(JSON.parse(result).ok ? 0 : 1)
  } catch (err) {
    log('threw:', err)
    app.exit(1)
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

/**
 * Carry the old app's data across, once, after the rename from onestop to rigee.
 *
 * Electron derives `userData` from the app's name, so renaming moved it from
 * `<appData>/onestop` to `<appData>/rigee` — and everything the user had went quiet at the same
 * moment: every workspace, the tabs and splits in each, the key bindings, which plugins they had
 * switched off, and every site they were signed into in a browser tab. Nothing was deleted, which
 * somehow makes it worse: the data is right there and the app cannot see it.
 *
 * Only two things are worth carrying. `workspaces.json` is the document; `Partitions/` holds the
 * browser plugin's cookies and storage, and its directory is named after the partition string, so
 * it has to be renamed in step with it or every tab is signed out anyway. Everything else in the
 * old directory is Chromium cache that is cheaper to rebuild than to copy.
 *
 * Runs once and never again: the guard is the presence of OUR document, so a user who deletes
 * their workspaces on purpose does not find them restored on the next launch. The old directory is
 * left alone — an app that deletes the previous version's data on upgrade has no way back if this
 * goes wrong.
 */
function adoptLegacyUserData(): void {
  // Smoke modes run against a throwaway directory and must not inherit anybody's real state.
  if (process.env.RIGEE_SMOKE) return

  try {
    const dir = app.getPath('userData')
    if (existsSync(join(dir, 'workspaces.json'))) return

    const legacy = join(dir, '..', 'onestop')
    if (!existsSync(join(legacy, 'workspaces.json'))) return

    mkdirSync(dir, { recursive: true })
    cpSync(join(legacy, 'workspaces.json'), join(dir, 'workspaces.json'))

    const partitions = join(legacy, 'Partitions')
    if (existsSync(partitions)) {
      cpSync(partitions, join(dir, 'Partitions'), { recursive: true })
      // The partition string went from `persist:onestop-browser` to `persist:rigee-browser`, and
      // Chromium looks the storage up by that name. Without the rename the cookies would be
      // copied and then ignored.
      const was = join(dir, 'Partitions', 'onestop-browser')
      const now = join(dir, 'Partitions', 'rigee-browser')
      if (existsSync(was) && !existsSync(now)) renameSync(was, now)
    }
    console.log(`[migrate] adopted the previous app's data from ${legacy}`)
  } catch (err) {
    // Never fatal. Starting with an empty workspace list is a bad morning; refusing to start is
    // worse, and the old directory is still there to copy by hand.
    console.error('[migrate] could not adopt the previous data directory:', err)
  }
}

/**
 * Before `app.whenReady`, because Electron requires it: a privileged scheme cannot be declared
 * once the protocol registry is up. And in ONE call, because Electron allows exactly one — the
 * plugin scheme and the media scheme are declared together or one of them is not declared at all.
 *
 * Costs nothing — it registers names, it does not read anything from disk.
 */
protocol.registerSchemesAsPrivileged([pluginScheme, mediaScheme])

app.whenReady().then(() => {
  mark('app ready')
  adoptLegacyUserData()
  // Trust before the scan, and both before the window: the renderer asks for the plugin registry
  // as part of `state:load`, and a manifest arriving after the activity bar has rendered would
  // make a third-party panel's icon appear a moment late, which reads as a glitch. One readdir
  // and a hash per installed plugin; with no plugins directory — the normal case — one failed
  // stat.
  initTrustStore(join(app.getPath('userData'), 'plugin-trust.json'))
  const scan = scanDiskPlugins(join(app.getPath('userData'), 'plugins'))
  if (scan.found > 0) mark(`disk plugins scanned (${scan.found})`)
  registerPluginProtocol()
  registerMediaProtocol()
  // Kick off PATH recovery immediately but do not block first paint on it; the handlers that
  // actually need a resolved PATH await the same promise.
  void ensureShellPath().then(() => mark('shell PATH resolved'))
  registerHandlers()
  registerUnsavedHandlers()
  installMenu()
  forwardShortcuts(shellWc, (action) => emit(shellWc(), 'shortcuts:run', { action }))
  createWindow()
  app.on('activate', () => { if (!window) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

/**
 * Teardown, once, with the quit held open until it finishes.
 *
 * `before-quit` is synchronous and plugin teardown is not, so this used to start disposal and let
 * the process leave without it — which is not merely untidy. The source control plugin's
 * filesystem watchers are native: releasing one schedules work on @parcel/watcher's own thread
 * that completes through a napi callback, and if the environment is already being torn down when
 * that callback lands, napi aborts the process. A plain Cmd+Q on the packaged app produced
 *
 *     watcher.node … PromiseRunner::onWorkComplete → napi_fatal_error → abort()
 *
 * i.e. a SIGABRT crash report for an app that had quit cleanly from the user's point of view. So
 * the quit is cancelled once, teardown is awaited, and then it is re-issued for real.
 *
 * The timeout is the safety valve: a wedged unsubscribe must never turn "quit" into "hang". Two
 * seconds is ~100x what disposal measures at, so reaching it means something is genuinely stuck
 * and leaving is the better failure.
 */
const QUIT_TEARDOWN_TIMEOUT_MS = 2000
let quitting: Promise<void> | null = null

app.on('before-quit', (event) => {
  // The second pass, after teardown re-issues the quit. Let it through.
  if (quitting) return
  event.preventDefault()

  // Unsaved edits are asked about BEFORE anything is torn down: a Cancel has to find every shell
  // and plugin still running, and the page's own objection would arrive after they were gone.
  if (hasUnsavedChanges()) {
    void confirmUnsaved(window, shellWc(), true).then((go) => { if (go) app.quit() })
    return
  }

  quitting = (async () => {
    // Synchronous, and first: killing the ptys stops anything still writing to a pipe we are
    // about to close, and it cannot throw its way out of the teardown below.
    ptys?.disposeAll()
    const host = pluginHost
    if (!host) return
    await Promise.race([
      host.dispose().catch((err: unknown) => {
        console.error('[quit] plugin teardown failed:', err)
      }),
      new Promise<void>((resolve) => setTimeout(resolve, QUIT_TEARDOWN_TIMEOUT_MS).unref?.())
    ])
  })().finally(() => { app.quit() })
})

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerHandlers(): void {
  // --- app ---------------------------------------------------------------
  handle('app:getVersions', () => ({ ...process.versions }))

  handle('app:getPlatformInfo', async () => {
    await ensureShellPath()
    return {
      platform: process.platform,
      shell:
        process.platform === 'win32'
          ? (process.env.COMSPEC ?? 'powershell.exe')
          : (process.env.SHELL ?? '/bin/bash'),
      homeDir: homedir()
    }
  })

  handle('window:toggleFullScreen', () => {
    if (window && !window.isDestroyed()) window.setFullScreen(!window.isFullScreen())
  })

  // --- persistence -------------------------------------------------------
  handle('state:load', () => loadState())
  handle('state:saveWorkspaces', ({ workspaces, activeWorkspaceId }) => {
    saveWorkspaces(workspaces, activeWorkspaceId)
  })
  handle('state:saveAllUi', ({ ui }) => {
    if (process.env.RIGEE_SMOKE) {
      const shape = Object.values(ui)
        .map((u) => u.groups.map((g) => g.tabs.length).join('/'))
        .join(',')
      console.log(`[persist] saveAllUi keys=${Object.keys(ui).join(',')} groups=${shape}`)
    }
    saveAllUi(ui)
  })
  handle('state:saveKeybindings', ({ keybindings }) => { saveKeybindings(keybindings) })
  handle('state:saveSettings', ({ settings }) => { saveSettings(settings) })
  handle('plugins:list', () =>
    installedPlugins().map((p) => ({ ...p, rendererUrl: rendererEntryUrl(p.manifest.id) }))
  )

  handle('plugins:setTrust', async ({ id, trusted }) => {
    if (!trusted) {
      revokePlugin(id)
      // Stop it NOW rather than at the next launch. Its fiber owns whatever it installed — a
      // watcher, a listener, a child process — and "revoked" has to mean those are gone.
      await pluginHost?.deactivate(id)
      return { ok: true }
    }
    const result = approvePlugin(id)
    return result
  })

  handle('state:setDisabledPlugins', async ({ disabled }) => {
    saveDisabledPlugins(disabled)
    // Only if the host exists. Building it here to tell it that nothing is running would be an
    // odd way to honour a request to stop things.
    await pluginHost?.setDisabled(disabled)
  })

  // --- menus -------------------------------------------------------------
  handle('menu:popup', ({ items }) => (window ? popupContextMenu(window, items) : null))

  // --- workspaces --------------------------------------------------------
  handle('workspace:pickFolder', async (args) => {
    // `smoke:workspacefiles` answers for the user: a folder picker cannot be driven from a script.
    const scripted = process.env.RIGEE_SMOKE ? process.env.RIGEE_SMOKE_PICK_FOLDER : undefined
    if (scripted) return scripted
    if (!window) return null
    const res = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      message: args?.message ?? 'Add a folder to this workspace',
      ...(args?.defaultPath ? { defaultPath: resolveWorkspaceFilesDir(args.defaultPath, homedir()) ?? undefined } : {})
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]!
  })

  handle('workspace:probeFolder', async (path) => {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: path })
      return { isGitRepo: true, repoRoot: stdout.trim() }
    } catch {
      return { isGitRepo: false, repoRoot: null }
    }
  })

  handle('workspace:pickWorkspaceFile', async () => {
    if (!window) return null
    // Starting where saved workspaces are kept, when there is such a place.
    const filed = resolveWorkspaceFilesDir(appSettings().workspaceFilesDir, homedir())
    const res = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [{ name: 'Workspace', extensions: ['code-workspace'] }],
      message: 'Open a workspace file',
      ...(filed ? { defaultPath: filed } : {})
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]!
  })

  handle('workspace:readWorkspaceFile', async (path) => {
    const parsed = parseWorkspaceFile(readFileSync(path, 'utf8'), path)
    // Probing is per folder and each one is a git spawn, so do them together rather than in
    // series: a workspace file with a dozen repos is the case this exists for.
    const folders = await Promise.all(
      parsed.folders.map(async (f) => {
        let isGitRepo = false
        let repoRoot: string | null = null
        try {
          const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: f.path })
          isGitRepo = true
          repoRoot = stdout.trim()
        } catch { /* not a repo, or the folder is missing; it still shows in the explorer */ }
        return { path: f.path, name: f.name ?? basename(f.path), isGitRepo, repoRoot }
      })
    )
    return { name: parsed.name, folders }
  })

  handle('workspace:saveWorkspaceFile', async ({ name, folders, location, current }) => {
    if (!window) return null
    let target: string
    if (location === 'named') {
      // Checked here whatever the sidebar said: the name becomes two path segments, and one that
      // could climb out of the folder the user chose must never reach the filesystem.
      const problem = workspaceNameProblem(name)
      if (problem) throw new Error(problem)
      const dir = resolveWorkspaceFilesDir(appSettings().workspaceFilesDir, homedir())
      if (!dir) throw new Error('Choose a folder for workspace files in Settings first.')
      target = namedWorkspaceFile(dir, name, sep)
      // Another workspace's file of the same name is asked about, as a save dialog would ask. This
      // workspace's own file is simply the save the user asked for.
      const ours = !!current && resolve(current) === target
      if (existsSync(target) && !ours && !(await confirmReplace(window, target))) return null
      mkdirSync(dirname(target), { recursive: true })
    } else {
      const res = await dialog.showSaveDialog(window, {
        defaultPath: current ?? `${name}${WORKSPACE_FILE_EXTENSION}`,
        filters: [{ name: 'Workspace', extensions: ['code-workspace'] }],
        message: 'Save workspace as'
      })
      if (res.canceled || !res.filePath) return null
      target = res.filePath
    }
    writeFileSync(target, serializeWorkspaceFile(folders, target), 'utf8')
    return target
  })

  handle('workspace:addFoldersToFile', ({ file, folders }) => {
    // This edits a file in place, so only one that is a workspace file by name and by content.
    if (!file.toLowerCase().endsWith(WORKSPACE_FILE_EXTENSION)) throw new Error(`${basename(file)} is not a workspace file`)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      // The likely way for this to fail: the file was moved or deleted since the workspace was saved.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${basename(file)} is no longer in ${dirname(file)}`)
      throw err
    }
    const next = addFoldersToWorkspaceFile(text, file, folders)
    // In place rather than tmp-and-rename, as saving one is: a workspace file kept as a symlink stays one.
    if (next !== text) writeFileSync(file, next, 'utf8')
  })

  // --- clipboard ---------------------------------------------------------
  handle('clipboard:write', ({ text }) => clipboard.writeText(text))
  // `clipboard.selection` is Electron 44's PRIMARY selection, and exists on Linux only.
  handle('clipboard:read', async (args) =>
    args?.selection ? ((await clipboard.selection?.readText()) ?? '') : clipboard.readText()
  )

  // --- filesystem --------------------------------------------------------
  handle('fs:list', (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true })
    const out: FileStat[] = []
    for (const e of entries) {
      const path = join(dir, e.name)
      let isDir = e.isDirectory()
      if (e.isSymbolicLink()) {
        try { isDir = statSync(path).isDirectory() } catch { continue } // dangling symlink
      }
      out.push({ path, name: e.name, isDir, ignored: false })
    }
    // Directories first, then case-insensitive by name — the ordering every file tree uses.
    out.sort((a, b) =>
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    )
    return out
  })

  handle('fs:readFile', (path) => {
    const size = statSync(path).size
    if (size > MAX_EDITABLE_BYTES) {
      return { content: '', truncated: true, tooLarge: true }
    }
    const bytes = readFileSync(path)
    // Read as UTF-8 regardless, but say so when it is not: a GBK file decoded as UTF-8 is full of
    // replacement characters, and saving that back would destroy every one of them. The editor
    // opens such a file read-only.
    return { content: bytes.toString('utf8'), truncated: false, tooLarge: false, notUtf8: !isUtf8(bytes) }
  })

  handle('fs:writeFile', ({ path, content }) => { writeFileSync(path, content, 'utf8') })

  registerTerminalHandlers()
  registerPluginHandlers()
}

/** The question a save dialog asks before it overwrites a file, for a save that has no dialog. */
async function confirmReplace(win: BrowserWindow, file: string): Promise<boolean> {
  // `smoke:workspacefiles` answers for the user: the question must never appear during a test.
  const scripted = process.env.RIGEE_SMOKE ? process.env.RIGEE_SMOKE_REPLACE_ANSWER : undefined
  if (scripted === 'replace' || scripted === 'cancel') return scripted === 'replace'
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Replace', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: `“${basename(file)}” already exists. Do you want to replace it?`,
    detail: `A workspace file with the same name is already in ${dirname(file)}. Replacing it overwrites the folders it lists.`
  })
  return response === 0
}

function registerTerminalHandlers(): void {
  const mgr = (): PtyManager => {
    if (!ptys) throw new Error('window not ready')
    return ptys
  }

  handle('terminal:spawn', async ({ workspaceId, cwd, cwdFrom, cols, rows }) => {
    // A packaged app starts with a minimal PATH, so the shell must be findable before we spawn.
    await ensureShellPath()
    return mgr().spawn({ workspaceId, cwd, cwdFrom, cols, rows })
  })
  handle('terminal:resize', ({ paneId, cols, rows }) => { mgr().resize(paneId, cols, rows) })
  handle('terminal:kill', ({ paneId }) => { mgr().kill(paneId) })
  handle('terminal:running', ({ paneIds }) => mgr().running(paneIds))

  handle('dialog:closeRunning', async ({ processes, tabs }) => {
    // `smoke:tabs` answers for the user, the way `smoke:editing` answers the unsaved-changes dialog.
    const scripted = process.env.RIGEE_SMOKE ? process.env.RIGEE_SMOKE_RUNNING_ANSWER : undefined
    if (scripted === 'close' || scripted === 'cancel') return scripted === 'close'
    const one = processes.length === 1
    const options = {
      type: 'warning' as const,
      buttons: ['Close', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message: one ? `“${processes[0]}” is still running` : `${processes.length} programs are still running`,
      detail:
        `Closing ${tabs === 1 ? 'the tab' : `these ${tabs} tabs`} will stop ` +
        (one ? 'it.' : `them: ${[...new Set(processes)].join(', ')}.`)
    }
    const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
    return response === 0
  })
  handle('terminal:requestPort', ({ workspaceId }) => { mgr().establishPort(workspaceId) })
  handle('terminal:disconnect', ({ workspaceId }) => { mgr().disconnect(workspaceId) })
}

/**
 * One handler for every plugin, on one channel.
 *
 * Source control and the browser each had a block of their own here. They are plugins now: their
 * commands are registered by their own main halves, dispatched through the command registry, and
 * authorised there — an unregistered command is rejected rather than reaching anything.
 */
function registerPluginHandlers(): void {
  handle('plugin:invoke', async ({ command, payload }) => {
    const host = await plugins()
    try {
      return await host.invoke(command, payload)
    } catch (err) {
      // Name the command, not the channel. `handle` prefixes whatever escapes with the channel it
      // arrived on, which was useful when every feature had one of its own and says nothing now
      // that all twenty-two of them are `plugin:invoke` — a reader would see "plugin:invoke: ENOENT"
      // with no way to tell whether git, the browser or the PDF reader produced it.
      throw new Error(`${command}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}
