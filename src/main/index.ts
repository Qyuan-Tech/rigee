import {
  app,
  BaseWindow,
  WebContentsView,
  dialog,
  shell,
  type WebContents
} from 'electron'
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { BrowserTabs } from './browser'
import { emit, handle } from './ipc'
import { loadState, saveUi, saveWorkspaces } from './store'
import type { FileStat, RepoStatus, ViewBounds } from '@shared/types'

const execFileAsync = promisify(execFile)
const __dirnameESM = dirname(fileURLToPath(import.meta.url))

const T0 = Date.now()
const mark = (label: string): void => {
  console.log(`[perf] ${label} +${Date.now() - T0}ms (uptime ${Math.round(process.uptime() * 1000)}ms)`)
}
mark('main module evaluated')

/** Files above this are opened read-only with a warning rather than streamed into Monaco. */
const MAX_EDITABLE_BYTES = 8 * 1024 * 1024

let window: BaseWindow | null = null
let shellView: WebContentsView | null = null
let browserTabs: BrowserTabs | null = null

const shellWc = (): WebContents | null =>
  shellView && !shellView.webContents.isDestroyed() ? shellView.webContents : null

// ---------------------------------------------------------------------------
// Window
//
// BaseWindow + a WebContentsView for the React shell, rather than a BrowserWindow.
// Child views always composite above a BrowserWindow's own web contents, which would let a
// browser tab occlude the shell's overlays (command palette, menus, dialogs). With BaseWindow the
// shell is just another child view and can be raised above the browser views on demand.
// ---------------------------------------------------------------------------

function createWindow(): void {
  window = new BaseWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#1e1e1e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default'
  })

  shellView = new WebContentsView({
    webPreferences: {
      preload: join(__dirnameESM, '../preload/index.cjs'), // .cjs, never .mjs — see vite config
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  })
  window.contentView.addChildView(shellView)
  layoutShell()
  window.on('resize', layoutShell)

  browserTabs = new BrowserTabs(window, shellWc)

  // The trusted shell never opens windows itself; anything it tries goes to the real browser.
  shellView.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  shellView.webContents.once('did-finish-load', () => {
    mark('shell did-finish-load')
    window?.show()
    if (process.env.ONESTOP_SMOKE) void runSmokeTest()
  })

  // Without these, a renderer that fails to boot just shows nothing and the window never appears.
  shellView.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[shell] did-fail-load ${code} ${desc} ${url}`)
    window?.show()
  })
  shellView.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error(`[shell] preload-error ${preloadPath}:`, error)
  })
  shellView.webContents.on('render-process-gone', (_e, details) => {
    console.error('[shell] render-process-gone', details)
  })
  shellView.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      console.error(`[shell:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`)
    }
  })

  shellView.webContents.on('did-start-loading', () => mark('shell did-start-loading'))
  shellView.webContents.on('dom-ready', () => mark('shell dom-ready'))

  // Load first so renderer boot overlaps any main-side initialisation.
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const indexHtml = join(__dirnameESM, '../renderer/index.html')
  const loading = devUrl
    ? shellView.webContents.loadURL(devUrl)
    : shellView.webContents.loadFile(indexHtml)
  loading.catch((err: unknown) => {
    console.error(`[shell] failed to load ${devUrl ?? indexHtml}:`, err)
    window?.show()
  })
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
      `(() => {
        const root = document.getElementById('root')
        const bridge = typeof window.onestop === 'object' && window.onestop !== null
        return JSON.stringify({
          bridge,
          bridgeKeys: bridge ? Object.keys(window.onestop) : [],
          rootChildren: root ? root.children.length : -1,
          elements: document.querySelectorAll('*').length,
          text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240)
        })
      })()`,
      true
    )) as string
    console.log('[smoke]', report)
    const parsed = JSON.parse(report) as { bridge: boolean; rootChildren: number }
    app.exit(parsed.bridge && parsed.rootChildren > 0 ? 0 : 1)
  } catch (err) {
    console.error('[smoke] failed:', err)
    app.exit(1)
  }
}

function layoutShell(): void {
  if (!window || !shellView) return
  const { width, height } = window.getContentBounds()
  shellView.setBounds({ x: 0, y: 0, width, height })
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  mark('app ready')
  registerHandlers()
  createWindow()
  app.on('activate', () => { if (!window) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { browserTabs?.destroyAll() })

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
    if (visible) browserTabs?.showOnly(viewId)
    else browserTabs?.setVisible(viewId, false)
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

  registerPlaceholderHandlers()
}

/**
 * tmux and source control are not implemented yet — the control-mode protocol and the git
 * plumbing are still being pinned down. These keep the IPC surface total so the renderer can be
 * built against the real contract, and they fail loudly rather than silently returning junk.
 */
function registerPlaceholderHandlers(): void {
  handle('tmux:connect', () => ({ status: 'unavailable' as const, reason: 'tmux integration not implemented yet' }))
  handle('tmux:disconnect', () => { /* no-op */ })
  handle('tmux:listState', () => ({ windows: [], panes: [] }))
  handle('tmux:newWindow', () => { throw new Error('not implemented') })
  handle('tmux:splitPane', () => { throw new Error('not implemented') })
  handle('tmux:killPane', () => { /* no-op */ })
  handle('tmux:selectPane', () => { /* no-op */ })
  handle('tmux:resizeClient', () => { /* no-op */ })
  handle('terminal:requestPort', () => { /* no-op until the tmux client exists */ })

  const emptyStatus = (repoRoot: string): RepoStatus => ({
    repoId: repoRoot,
    root: repoRoot,
    name: basename(repoRoot),
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detachedAt: null,
    operation: 'none',
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: [],
    stashCount: 0,
    at: Date.now()
  })
  handle('scm:status', ({ repoRoot }) => emptyStatus(repoRoot))
  handle('scm:statusAll', ({ repoRoots }) => repoRoots.map(emptyStatus))
  handle('scm:diff', () => ({ original: '', modified: '', binary: false, tooLarge: false }))
  handle('scm:stage', () => { throw new Error('not implemented') })
  handle('scm:unstage', () => { throw new Error('not implemented') })
  handle('scm:discard', () => { throw new Error('not implemented') })
  handle('scm:commit', () => { throw new Error('not implemented') })
  handle('scm:watch', () => { /* no-op */ })
}
