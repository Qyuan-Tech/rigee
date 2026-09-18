import { app, BrowserWindow, dialog, shell, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { BrowserTabs } from './browser'
import { ensureShellPath } from './env'
import { GitService } from './git/service'
import type { TmuxClient } from './tmux/client'
import { TmuxManager } from './tmux/manager'
import { emit, handle } from './ipc'
import { loadState, saveUi, saveWorkspaces } from './store'
import type { FileStat, ViewBounds } from '@shared/types'

const execFileAsync = promisify(execFile)
const __dirnameESM = dirname(fileURLToPath(import.meta.url))

const T0 = Date.now()
const mark = (label: string): void => {
  console.log(`[perf] ${label} +${Date.now() - T0}ms (uptime ${Math.round(process.uptime() * 1000)}ms)`)
}
mark('main module evaluated')

/** Files above this are opened read-only with a warning rather than streamed into Monaco. */
const MAX_EDITABLE_BYTES = 8 * 1024 * 1024

let window: BrowserWindow | null = null
let browserTabs: BrowserTabs | null = null
let tmux: TmuxManager | null = null
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
  tmux = new TmuxManager(shellWc)

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
          tmux: platform,
          text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
        })
      })()`,
      true
    )) as string
    console.log('[smoke]', report, `shellFocused=${wc.isFocused()}`)
    const parsed = JSON.parse(report) as {
      bridge: boolean
      rootChildren: number
      tmux: { tmuxAvailable?: boolean } | null
    }
    const ok = parsed.bridge && parsed.rootChildren > 0 && parsed.tmux?.tmuxAvailable === true
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
        const { store, getTerminal, nextTabId } = window.__onestop
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

        const tabId = nextTabId()
        store.getState().openTab(scratch.id, {
          id: tabId, kind: 'terminal', title: 'e2e', pinned: false, windowId: null, paneId: null
        })
        trail.push('tab opened')

        // Wait for the pane to be created and bound to the xterm instance.
        let handle = null
        for (let i = 0; i < 120; i++) {
          await sleep(250)
          handle = getTerminal(tabId)
          if (handle && handle.paneId) break
        }
        if (!handle) return JSON.stringify({ ok: false, stage: 'no-xterm-instance', trail })
        if (!handle.paneId) return JSON.stringify({ ok: false, stage: 'pane-never-bound', trail })
        trail.push('pane ' + handle.paneId)

        const read = () => {
          const b = handle.term.buffer.active
          let out = ''
          for (let i = 0; i < b.length; i++) out += (b.getLine(i)?.translateToString(true) ?? '') + String.fromCharCode(10)
          return out
        }

        // Did anything arrive from tmux at all? A shell prompt should have rendered by now.
        await sleep(800)
        const beforeLen = read().trim().length
        trail.push('output before typing: ' + beforeLen + ' chars')

        // Where the keyboard actually lands. xterm renders into its own textarea, and if that
        // is not focused — or if the onData subscription was lost — keystrokes go nowhere even
        // though the transport underneath is perfectly healthy.
        const active = document.activeElement
        const focused = !!(active && handle.element.contains(active))
        trail.push('focus inside terminal: ' + focused + ' (' + (active ? active.tagName.toLowerCase() : 'none') + ')')

        let onDataFired = 0
        const probe = handle.term.onData(() => { onDataFired++ })

        // term.input() drives the same path a real keypress does: it fires onData, which is what
        // the component subscribes to. Writing straight to the port would skip exactly the wiring
        // that was reported broken.
        handle.term.input('echo ONESTOP-E2E-$((6*7))' + String.fromCharCode(13), true)
        probe.dispose()
        trail.push('onData fired ' + onDataFired + 'x')
        if (onDataFired !== 1) {
          return JSON.stringify({ ok: false, stage: 'onData-not-1', trail })
        }

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
  tmux?.disposeAll()
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
app.on('login', (event, webContents, _details, authInfo, callback) => {
  const viewId = webContents ? browserTabs?.idFor(webContents) ?? null : null
  if (!viewId) return // not one of our browser tabs; let Electron's default (cancel) apply
  event.preventDefault()
  // TODO: prompt in the renderer via 'browser:authRequested' and resolve through an
  // 'browser:authResponse' request. Until that UI exists, cancel rather than hang the page.
  emit(shellWc(), 'browser:authRequested', {
    viewId,
    requestId: `${Date.now()}`,
    host: authInfo.host,
    realm: authInfo.realm
  })
  callback()
})

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerHandlers(): void {
  // --- app ---------------------------------------------------------------
  handle('app:getVersions', () => ({ ...process.versions }))

  handle('app:getPlatformInfo', async () => {
    await ensureShellPath()
    let tmuxVersion: string | null = null
    try {
      const { stdout } =
        process.platform === 'win32'
          ? await execFileAsync('wsl.exe', ['--', 'tmux', '-V'])
          : await execFileAsync('tmux', ['-V'])
      tmuxVersion = stdout.trim()
    } catch {
      tmuxVersion = null
    }
    return {
      platform: process.platform,
      tmuxAvailable: tmuxVersion !== null,
      tmuxVersion,
      homeDir: homedir()
    }
  })

  // --- persistence -------------------------------------------------------
  handle('state:load', () => loadState())
  handle('state:saveWorkspaces', ({ workspaces, activeWorkspaceId }) => {
    saveWorkspaces(workspaces, activeWorkspaceId)
  })
  handle('state:saveUi', ({ workspaceId, ui }) => { saveUi(workspaceId, ui) })

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

  registerTmuxHandlers()
  registerScmHandlers()
}

function registerTmuxHandlers(): void {
  const mgr = (): TmuxManager => {
    if (!tmux) throw new Error('window not ready')
    return tmux
  }
  const requireClient = (workspaceId: string): TmuxClient => {
    const c = mgr().client(workspaceId)
    if (!c) throw new Error(`no tmux session for workspace ${workspaceId}`)
    return c
  }

  handle('tmux:connect', async ({ workspaceId, sessionName, cwd }) => {
    // A packaged app starts with a minimal PATH, so tmux must be findable before we spawn it.
    await ensureShellPath()
    // Initial geometry is a placeholder; the renderer sends the real size via tmux:resizeClient
    // as soon as the xterm instance has measured itself.
    return mgr().connect(workspaceId, sessionName, cwd, 120, 30)
  })
  handle('tmux:disconnect', ({ workspaceId }) => { mgr().disconnect(workspaceId) })
  handle('tmux:listState', ({ workspaceId }) => mgr().listState(workspaceId))

  handle('tmux:newWindow', async ({ workspaceId, cwd }) => ({
    windowId: await requireClient(workspaceId).newWindow(cwd)
  }))
  handle('tmux:splitPane', async ({ workspaceId, paneId, direction }) => ({
    paneId: await requireClient(workspaceId).splitPane(paneId, direction)
  }))
  handle('tmux:killPane', async ({ workspaceId, paneId }) => {
    await requireClient(workspaceId).killPane(paneId)
  })
  handle('tmux:selectPane', async ({ workspaceId, paneId }) => {
    await requireClient(workspaceId).selectPane(paneId)
  })
  handle('tmux:resizeClient', ({ workspaceId, cols, rows }) => {
    // The renderer addresses the active window; per-window overrides keep tabs independently
    // sized instead of all following one client geometry.
    const client = mgr().client(workspaceId)
    const windowId = mgr().listState(workspaceId).windows.find((w) => w.active)?.id
    if (client && windowId) client.resizeWindow(windowId, cols, rows)
  })
  handle('terminal:requestPort', ({ workspaceId }) => { mgr().establishPort(workspaceId) })
}

function registerScmHandlers(): void {
  handle('scm:status', ({ repoRoot }) => gitService.status(repoRoot))
  handle('scm:statusAll', ({ repoRoots }) => gitService.statusAll(repoRoots))
  handle('scm:diff', ({ repoRoot, path, against }) => gitService.diff(repoRoot, path, against))
  handle('scm:stage', ({ repoRoot, paths }) => gitService.stage(repoRoot, paths))
  handle('scm:unstage', ({ repoRoot, paths }) => gitService.unstage(repoRoot, paths))
  handle('scm:discard', ({ repoRoot, paths }) => gitService.discard(repoRoot, paths))
  handle('scm:commit', ({ repoRoot, message, amend }) => gitService.commit(repoRoot, message, amend))
  handle('scm:watch', ({ repoRoots }) =>
    gitService.watch(repoRoots, (status) => emit(shellWc(), 'scm:status', { status }))
  )
}
