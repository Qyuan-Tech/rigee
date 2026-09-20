import { app, BrowserWindow, dialog, shell, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { BrowserTabs } from './browser'
import { ensureShellPath } from './env'
import { GitService } from './git/service'
import type { ParsedDiff } from './git/patch'
import { PtyManager } from './pty/manager'
import { emit, handle } from './ipc'
import { loadState, saveAllUi, saveKeybindings, saveUi, saveWorkspaces } from './store'
import type { DiffHunkView, FileStat, ViewBounds } from '@shared/types'

const execFileAsync = promisify(execFile)
const __dirnameESM = dirname(fileURLToPath(import.meta.url))

const T0 = Date.now()
const mark = (label: string): void => {
  console.log(`[perf] ${label} +${Date.now() - T0}ms (uptime ${Math.round(process.uptime() * 1000)}ms)`)
}
mark('main module evaluated')

/**
 * Every smoke mode runs against a throwaway data directory.
 *
 * Without this the tests read and write the developer's real workspaces.json — and the
 * persistence test in particular would overwrite their actual open tabs with its fixtures. Has to
 * happen before anything calls getPath('userData').
 */
if (process.env.ONESTOP_SMOKE) {
  const dir = process.env.ONESTOP_SMOKE_DATA ?? join(tmpdir(), `onestop-smoke-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  app.setPath('userData', dir)
  console.log(`[smoke] userData = ${dir}`)
}

/** Files above this are opened read-only with a warning rather than streamed into Monaco. */
const MAX_EDITABLE_BYTES = 8 * 1024 * 1024

let window: BrowserWindow | null = null
let browserTabs: BrowserTabs | null = null
let ptys: PtyManager | null = null
const gitService = new GitService()

const shellWc = (): WebContents | null =>
  window && !window.webContents.isDestroyed() ? window.webContents : null

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
    backgroundColor: '#1e1e1e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirnameESM, '../preload/index.cjs'), // .cjs, never .mjs — see vite config
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  })

  browserTabs = new BrowserTabs(window, shellWc)
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
    if (process.env.ONESTOP_SMOKE === 'terminal') void runTerminalSmoke()
    else if (process.env.ONESTOP_SMOKE === 'split') void runSplitSmoke()
    else if (process.env.ONESTOP_SMOKE === 'persist') void runPersistSmoke()
    else if (process.env.ONESTOP_SMOKE === 'shot') void captureShot()
    else if (process.env.ONESTOP_SMOKE) void runSmokeTest()
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
 * Give keyboard focus to whichever surface should have it: the visible browser tab if there is
 * one, otherwise the shell itself.
 */
/**
 * Attach gutter line numbers to a parsed diff. The counters advance per side: a '-' line exists
 * only in the old file, a '+' only in the new, context in both.
 */
function withLineNumbers(parsed: ParsedDiff): DiffHunkView[] {
  return parsed.hunks.map((h) => {
    let oldNo = h.oldStart
    let newNo = h.newStart
    return {
      section: h.section,
      oldStart: h.oldStart,
      newStart: h.newStart,
      lines: h.lines.map((l) => ({
        kind: l.kind,
        text: l.text,
        noEol: l.noEol,
        id: l.id,
        oldNo: l.kind === '+' ? null : oldNo++,
        newNo: l.kind === '-' ? null : newNo++
      }))
    }
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
        const { store, getTerminal, paneKey, newTerminalTab } = window.__onestop
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

        const current = () =>
          (store.getState().tabsByWorkspace[scratch.id] ?? []).find(t => t.id === tab.id)
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
 * End-to-end check that what is on screen survives a restart: build a terminal with splits and a
 * browser tab, let the debounce fire, then read the document main actually wrote to disk.
 */
async function runPersistSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  try {
    const built = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store, newTerminalTab } = window.__onestop

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
          id: 'persist-browser-tab', kind: 'browser', title: 'probe', pinned: false,
          url: 'https://example.com/persisted', viewId: '',
          canGoBack: false, canGoForward: false, loading: false, faviconDataUrl: null
        })

        // Longer than the save debounce.
        await sleep(1500)
        const t = (store.getState().tabsByWorkspace[scratch.id] ?? []).find(x => x.id === tab.id)
        const count = (n) => n.kind === 'leaf' ? 1 : n.children.reduce((a, c) => a + count(c), 0)
        return JSON.stringify({ ok: true, terminalTabId: tab.id, leaves: t ? count(t.root) : 0 })
      })()`,
      true
    )) as string
    const info = JSON.parse(built) as { ok: boolean; terminalTabId?: string; leaves?: number }
    if (!info.ok) { console.log('[smoke:persist]', built); app.exit(1); return }

    const file = join(app.getPath('userData'), 'workspaces.json')
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      version: number
      keybindings?: { prefix?: string }
      ui?: Record<string, { tabs?: Array<Record<string, unknown>>; activeTabId?: string | null }>
    }
    const tabs = doc.ui?.['__scratch__']?.tabs ?? []
    const term = tabs.find((t) => t.id === info.terminalTabId)
    const browser = tabs.find((t) => t.kind === 'browser')

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
      browserUrlOnDisk: (browser as { url?: string } | undefined)?.url ?? null
    }
    const ok =
      report.terminalRestored &&
      report.leavesOnDisk === info.leaves &&
      report.leavesOnDisk === 3 &&
      report.browserUrlOnDisk === 'https://example.com/persisted' &&
      report.keybindingsSaved === 'ctrl+a'
    console.log('[smoke:persist]', JSON.stringify({ ok, ...report }))
    app.exit(ok ? 0 : 1)
  } catch (err) {
    console.error('[smoke:persist] threw:', err)
    app.exit(1)
  }
}

/**
 * Render the shell to a PNG at ONESTOP_SHOT (default /tmp/onestop-shot.png). For looking at the
 * interface while working on it — capturePage grabs exactly the shell's own surface, so it needs
 * no screen recording permission and cannot catch anything else on the desktop.
 */
async function captureShot(): Promise<void> {
  const wc = shellWc()
  if (!wc || !window) { app.exit(1); return }
  try {
    // Give the boot sequence and any tab it restores a moment to paint.
    await new Promise((r) => setTimeout(r, 4000))
    if (process.env.ONESTOP_SHOT_COLLAPSED) {
      await wc.executeJavaScript(
        `window.__onestop.store.getState().setLayout({ leftCollapsed: true, rightCollapsed: true })`,
        true
      )
      await new Promise((r) => setTimeout(r, 600))
    }
    const image = await wc.capturePage()
    const out = process.env.ONESTOP_SHOT ?? '/tmp/onestop-shot.png'
    writeFileSync(out, image.toPNG())
    console.log(`[shot] ${out} ${image.getSize().width}x${image.getSize().height}`)
    app.exit(0)
  } catch (err) {
    console.error('[shot] failed:', err)
    app.exit(1)
  }
}

function focusActiveView(): void {
  const browser = browserTabs?.focusVisible()
  if (!browser) shellWc()?.focus()
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
        const bridge = typeof window.onestop === 'object' && window.onestop !== null
        // Goes through the real preload bridge and the real IPC handler, so this also proves
        // PATH recovery worked: a packaged app launched from Finder starts with a PATH that
        // cannot see Homebrew.
        let platform = null
        try { platform = await window.onestop.invoke('app:getPlatformInfo') } catch (e) {
          platform = { error: String(e) }
        }
        return JSON.stringify({
          bridge,
          bridgeKeys: bridge ? Object.keys(window.onestop) : [],
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
        const { store, getTerminal, paneKey, newTerminalTab } = window.__onestop
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
        handle.term.input('echo ONESTOP-E2E-$((6*7))' + String.fromCharCode(13), true)
        probe.dispose()
        trail.push('onData fired ' + onDataFired + 'x')
        if (onDataFired !== 1) return JSON.stringify({ ok: false, stage: 'onData-not-1', trail })

        for (let i = 0; i < 40; i++) {
          await sleep(250)
          if (read().includes('ONESTOP-E2E-42')) {
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

app.whenReady().then(() => {
  mark('app ready')
  // Kick off PATH recovery immediately but do not block first paint on it; the handlers that
  // actually need a resolved PATH await the same promise.
  void ensureShellPath().then(() => mark('shell PATH resolved'))
  registerHandlers()
  createWindow()
  app.on('activate', () => { if (!window) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => {
  browserTabs?.destroyAll()
  ptys?.disposeAll()
  gitService.dispose()
})

/**
 * HTTP 401/407. Registered once on `app`, not per WebContents: Session has no 'login' event, and
 * the app-level signature is the only one that tells us which WebContents asked, so we can
 * attribute the prompt to the right tab.
 *
 * Signature is 5 args here. (WebContents' own 'login' takes 4 — dropping
 * authenticationResponseDetails there is a silent footgun that binds `callback` to authInfo.)
 */
/**
 * Outstanding HTTP auth challenges, keyed by the id handed to the renderer. The callback must be
 * invoked exactly once: calling it with no arguments cancels the request, and never calling it
 * leaves the page loading forever.
 */
const pendingAuth = new Map<string, (username?: string, password?: string) => void>()
let authSeq = 0

/** A dialog nobody answers must not pin the request open indefinitely. */
const AUTH_TIMEOUT_MS = 2 * 60 * 1000

app.on('login', (event, webContents, details, authInfo, callback) => {
  const viewId = webContents ? browserTabs?.idFor(webContents) ?? null : null
  if (!viewId) return // not one of our browser tabs; let Electron's default (cancel) apply
  event.preventDefault()

  const requestId = `auth${++authSeq}`
  pendingAuth.set(requestId, callback)
  emit(shellWc(), 'browser:authRequested', {
    viewId,
    requestId,
    host: authInfo.host || authInfo.realm || 'the server',
    realm: authInfo.realm,
    isProxy: authInfo.isProxy,
    url: details.url
  })

  setTimeout(() => {
    const cb = pendingAuth.get(requestId)
    if (!cb) return
    pendingAuth.delete(requestId)
    cb()
  }, AUTH_TIMEOUT_MS).unref()
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
  handle('state:saveUi', ({ workspaceId, ui }) => { saveUi(workspaceId, ui) })
  handle('state:saveAllUi', ({ ui }) => {
    if (process.env.ONESTOP_SMOKE) {
      console.log(`[persist] saveAllUi keys=${Object.keys(ui).join(',')} tabs=${Object.values(ui).map((u) => u.tabs.length).join(',')}`)
    }
    saveAllUi(ui)
  })
  handle('state:saveKeybindings', ({ keybindings }) => { saveKeybindings(keybindings) })

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

  // --- browser tabs ------------------------------------------------------
  handle('browser:create', ({ url, bounds }) => {
    if (!browserTabs) throw new Error('window not ready')
    return { viewId: browserTabs.create(url, bounds) }
  })
  handle('browser:destroy', ({ viewId }) => { browserTabs?.destroy(viewId) })
  handle('browser:setVisible', ({ viewId, visible }) => {
    if (visible) {
      browserTabs?.showOnly(viewId)
    } else {
      browserTabs?.setVisible(viewId, false)
      shellWc()?.focus()
    }
  })
  handle('browser:setBounds', ({ viewId, bounds }: { viewId: string; bounds: ViewBounds }) => {
    browserTabs?.setBounds(viewId, bounds)
  })
  handle('browser:navigate', ({ viewId, url }) => { browserTabs?.navigate(viewId, url) })
  handle('browser:goBack', ({ viewId }) => { browserTabs?.goBack(viewId) })
  handle('browser:goForward', ({ viewId }) => { browserTabs?.goForward(viewId) })
  handle('browser:reload', ({ viewId }) => { browserTabs?.reload(viewId) })
  handle('browser:stop', ({ viewId }) => { browserTabs?.stop(viewId) })
  handle('browser:openDevTools', ({ viewId }) => { browserTabs?.openDevTools(viewId) })
  handle('browser:authResponse', ({ requestId, username, password }) => {
    const cb = pendingAuth.get(requestId)
    if (!cb) return // already timed out, or answered twice
    pendingAuth.delete(requestId)
    if (username === null) cb()
    else cb(username, password)
  })

  registerTerminalHandlers()
  registerScmHandlers()
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

function registerScmHandlers(): void {
  handle('scm:status', ({ repoRoot }) => gitService.status(repoRoot))
  handle('scm:statusAll', ({ repoRoots }) => gitService.statusAll(repoRoots))
  handle('scm:diff', ({ repoRoot, path, against }) => gitService.diff(repoRoot, path, against))
  handle('scm:stage', ({ repoRoot, paths }) => gitService.stage(repoRoot, paths))
  handle('scm:unstage', ({ repoRoot, paths }) => gitService.unstage(repoRoot, paths))
  handle('scm:discard', ({ repoRoot, paths }) => gitService.discard(repoRoot, paths))
  handle('scm:commit', ({ repoRoot, message, amend }) => gitService.commit(repoRoot, message, amend))
  handle('scm:hunks', async ({ repoRoot, path, action }) => {
    const parsed = await gitService.hunks(repoRoot, path, action)
    return { hunks: withLineNumbers(parsed), binary: parsed.binary }
  })
  handle('scm:applySelection', ({ repoRoot, path, lineIds, action }) =>
    gitService.applySelection(repoRoot, path, lineIds, action)
  )
  handle('scm:watch', ({ repoRoots }) =>
    gitService.watch(repoRoots, (status) => emit(shellWc(), 'scm:status', { status }))
  )
}
