import { app, BrowserWindow, clipboard, dialog, shell, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ensureShellPath } from './env'
import { PtyManager } from './pty/manager'
import { parseWorkspaceFile, serializeWorkspaceFile } from './workspaceFile'
import { emit, handle } from './ipc'
import {
  disabledPlugins,
  EXPLORER_PLUGIN_ID,
  loadState,
  saveAllUi,
  saveDisabledPlugins,
  saveKeybindings,
  saveWorkspaces
} from './store'
import type { PluginHost } from './plugins/host'
import {
  approvePlugin,
  diskLoaders,
  installedPlugins,
  registerPluginProtocol,
  registerPluginScheme,
  rendererEntryUrl,
  revokePlugin,
  scanDiskPlugins
} from './plugins/installed'
import { initTrustStore } from './plugins/trust'
import { PLUGIN_MANIFESTS } from '@plugins/index'
import { PERSISTED_STATE_VERSION, type FileStat } from '@shared/types'

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
        send: (payload) => emit(shellWc(), 'plugin:event', payload)
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
    window?.show()
  })

  window.webContents.once('did-finish-load', () => {
    mark('shell did-finish-load')
    window?.show()
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
    else if (process.env.RIGEE_SMOKE === 'multirepo') void runMultiRepoSmoke()
    else if (process.env.RIGEE_SMOKE === 'shot') void captureShot()
    // These three must stay ABOVE the catch-all below, which matches any truthy value: a branch
    // added after it silently never runs and the generic check reports a cheerful green.
    else if (process.env.RIGEE_SMOKE === 'plugins') void runPluginsSmoke()
    else if (process.env.RIGEE_SMOKE === 'pdf') void runPdfSmoke()
    else if (process.env.RIGEE_SMOKE === 'migrate') void runMigrateSmoke()
    else if (process.env.RIGEE_SMOKE === 'diskplugin') void runDiskPluginSmoke()
    else if (process.env.RIGEE_SMOKE) void runSmokeTest()
  })

  window.on('focus', focusActiveView)
  window.on('closed', () => { window = null })

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
 * up with its own live pty and its own xterm instance.
 */
async function runSplitSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
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
        const read = (hh) => {
          const b = hh.term.buffer.active
          let out = ''
          for (let i = 0; i < b.length; i++) out += (b.getLine(i)?.translateToString(true) ?? '')
          return out
        }
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
    app.exit(JSON.parse(result).ok ? 0 : 1)
  } catch (err) {
    console.error('[smoke:split] threw:', err)
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
 * show is the wiring: that a right-click on a terminal or a browser tab produces no menu at all,
 * that one on a file tab does, that the buttons reach the store — and that the split button makes
 * a SECOND strip whose contents are governed by what the tab is. Driven through DOM events rather
 * than the store so the components are genuinely in the loop.
 */
async function runTabsSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
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
        const items = () => [...document.querySelectorAll('.menu .menu__item')]
        const rightClick = (el) => el.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 90, clientY: 20 }))
        const fail = (stage, extra) =>
          JSON.stringify(Object.assign({ ok: false, stage, trail }, extra || {}))

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

        // Neither a terminal nor a browser tab may offer the menu.
        rightClick(tabEls(0)[0])
        await sleep(150)
        if (document.querySelector('.menu')) return fail('menu-on-terminal')
        rightClick(tabEls(0)[2])
        await sleep(150)
        if (document.querySelector('.menu')) return fail('menu-on-browser')
        trail.push('no menu on terminal or browser')

        // A file tab must, with all four commands.
        rightClick(tabEls(0)[1])
        await sleep(150)
        const labels = items().map(b => b.textContent + (b.disabled ? '[off]' : ''))
        trail.push('menu: ' + labels.join(' | '))
        if (items().length !== 4) return fail('wrong-menu-size', { labels })

        items().find(b => b.textContent.includes('to the Right')).click()
        await sleep(250)
        trail.push('after close-right: ' + order())
        if (order() !== [term.id, 'e1', 'b1'].join(',')) return fail('close-right-wrong')
        if (document.querySelector('.menu')) return fail('menu-stayed-open')

        store.getState().openTab(ws, editor('e4'))
        store.getState().openTab(ws, editor('e5'))
        await sleep(300)
        const els = tabEls(0)
        rightClick(els[els.length - 2])
        await sleep(150)
        items().find(b => b.textContent.includes('Other Files')).click()
        await sleep(250)
        trail.push('after close-others: ' + order())
        if (order() !== [term.id, 'b1', 'e4'].join(',')) return fail('close-others-wrong')

        // Selection must never be left pointing at a tab that is gone. Still singular with several
        // groups on screen: it is the active group's active tab, and what Cmd+W acts on.
        const activeGroup = () => row().groups.find(g => g.id === row().activeGroupId) || row().groups[0]
        const active = activeGroup().activeTabId
        if (!order().split(',').includes(active)) return fail('active-tab-dangling', { active })

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
      doc.version === 3 &&
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
      !host.active().includes('scm')

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
        disabledOnDisk: disabled
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
 * once the protocol registry is up.
 *
 * Costs nothing — it registers a name, it does not read anything from disk.
 */
registerPluginScheme()

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
  // Kick off PATH recovery immediately but do not block first paint on it; the handlers that
  // actually need a resolved PATH await the same promise.
  void ensureShellPath().then(() => mark('shell PATH resolved'))
  registerHandlers()
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

  // --- workspaces --------------------------------------------------------
  handle('workspace:pickFolder', async () => {
    if (!window) return null
    const res = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      message: 'Add a folder to this workspace'
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
    const res = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      filters: [{ name: 'Workspace', extensions: ['code-workspace'] }],
      message: 'Open a workspace file'
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

  handle('workspace:saveWorkspaceFile', async ({ suggestedName, folders }) => {
    if (!window) return null
    const res = await dialog.showSaveDialog(window, {
      defaultPath: `${suggestedName}.code-workspace`,
      filters: [{ name: 'Workspace', extensions: ['code-workspace'] }],
      message: 'Save workspace as'
    })
    if (res.canceled || !res.filePath) return null
    writeFileSync(res.filePath, serializeWorkspaceFile(folders, res.filePath), 'utf8')
    return res.filePath
  })

  // --- clipboard ---------------------------------------------------------
  handle('clipboard:write', ({ text }) => clipboard.writeText(text))
  handle('clipboard:read', () => clipboard.readText())

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
    return { content: readFileSync(path, 'utf8'), truncated: false, tooLarge: false }
  })

  handle('fs:writeFile', ({ path, content }) => { writeFileSync(path, content, 'utf8') })

  registerTerminalHandlers()
  registerPluginHandlers()
}

function registerTerminalHandlers(): void {
  const mgr = (): PtyManager => {
    if (!ptys) throw new Error('window not ready')
    return ptys
  }

  handle('terminal:spawn', async ({ workspaceId, cwd, cols, rows }) => {
    // A packaged app starts with a minimal PATH, so the shell must be findable before we spawn.
    await ensureShellPath()
    return mgr().spawn({ workspaceId, cwd, cols, rows })
  })
  handle('terminal:resize', ({ paneId, cols, rows }) => { mgr().resize(paneId, cols, rows) })
  handle('terminal:kill', ({ paneId }) => { mgr().kill(paneId) })
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
