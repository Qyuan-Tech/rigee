import { app, BrowserWindow, clipboard, dialog, shell, type WebContents } from 'electron'
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
import { parseWorkspaceFile, serializeWorkspaceFile } from './workspaceFile'
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
    else if (process.env.ONESTOP_SMOKE === 'tabs') void runTabsSmoke()
    else if (process.env.ONESTOP_SMOKE === 'quit') void runQuitSmoke()
    else if (process.env.ONESTOP_SMOKE === 'copy') void runCopySmoke()
    else if (process.env.ONESTOP_SMOKE === 'mouse') void runMouseSmoke()
    else if (process.env.ONESTOP_SMOKE === 'scratch') void runScratchSmoke()
    else if (process.env.ONESTOP_SMOKE === 'scroll') void runScrollSmoke()
    else if (process.env.ONESTOP_SMOKE === 'multirepo') void runMultiRepoSmoke()
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
 * Ten repos in one workspace must read as ten repos, not ten crushed commit boxes.
 *
 * Every repo section used to be `flex: 1` in the panel's column, so N repos each received 1/N of
 * the height — around 80px for content needing 200 — and they overlapped instead of stacking.
 * Nothing overflows and nothing throws; the sections just silently squash, which is why the
 * assertion here is on the RENDERED HEIGHT of each section rather than on the panel's geometry.
 *
 * Point ONESTOP_SMOKE_MULTIREPO at a directory of git repos.
 */
async function runMultiRepoSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  const dir = process.env.ONESTOP_SMOKE_MULTIREPO
  if (!dir) { console.error('[smoke:multirepo] set ONESTOP_SMOKE_MULTIREPO'); app.exit(1); return }
  const repos = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(dir, e.name))
    .sort()
  try {
    const result = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store } = window.__onestop
        const trail = []
        const fail = (stage, extra) =>
          JSON.stringify(Object.assign({ ok: false, stage, trail }, extra || {}))

        for (let i = 0; i < 60; i++) { if (store.getState().ready) break; await sleep(250) }
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
 * Both side panels stay inside the window once they are full, and the explorer collapses.
 *
 * Written while chasing "source control has no scrollbar". It turned out both panels always did
 * scroll — the thumb was 8% white and simply invisible — so what this guards is the surrounding
 * claim rather than the one reported: that the panes remain clipped to the window and that their
 * scroll containers really are scroll containers. Worth keeping, because a short list looks
 * correct under any layout and only a full one can tell the difference. Hence ONESTOP_SMOKE_REPO.
 *
 * Note it asserts on the CONTAINERS, not the rows. Rows below the fold legitimately have bottoms
 * past the window — that is what scrolling is — and an assertion on row geometry would only hold
 * while the panel was broken.
 */
async function runScrollSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  const repo = process.env.ONESTOP_SMOKE_REPO
  if (!repo) { console.error('[smoke:scroll] set ONESTOP_SMOKE_REPO'); app.exit(1); return }
  try {
    const result = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store } = window.__onestop
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
        const { store, newTerminalTab } = window.__onestop
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
        trail.push('centre shows: ' + JSON.stringify(
          (document.querySelector('.tabstrip')?.textContent || '').slice(0, 40)))

        // And a terminal must actually open there.
        store.getState().openTab('__scratch__', newTerminalTab())
        await sleep(1500)
        const tabs = st().tabsByWorkspace['__scratch__'] ?? []
        trail.push('scratch tabs: ' + tabs.length)
        const panes = document.querySelectorAll('.term__pane').length
        trail.push('rendered terminal panes: ' + panes)
        if (panes < 1) return fail('no-terminal-in-scratch')

        // Switching workspaces must actually change what the centre shows. Asserted on the
        // rendered tab strip rather than on store state, because "the middle does not change"
        // is a claim about pixels, not about a variable.
        store.getState().setActiveWorkspace('ws-probe')
        store.getState().openTab('ws-probe', editorTab('probe-only-file'))
        await sleep(600)
        const onProbe = (document.querySelector('.tabstrip')?.textContent || '')
        scratchRow.click()
        await sleep(600)
        const onScratch = (document.querySelector('.tabstrip')?.textContent || '')
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
          id: 'scratch-probe-browser', kind: 'browser', title: 'probe', pinned: false,
          url: 'about:blank', viewId: '', canGoBack: false, canGoForward: false,
          loading: false, faviconDataUrl: null
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
    // Asked in main, because only main knows what is actually composited over the window.
    const stillVisible = browserTabs?.visibleIds() ?? []

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
        const { store, newTerminalTab, getTerminal, paneKey } = window.__onestop
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
          const t = (store.getState().tabsByWorkspace[scratch.id] ?? []).find(x => x.id === tab.id)
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
        const { store, newTerminalTab, getTerminal, paneKey } = window.__onestop

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
          const t = (store.getState().tabsByWorkspace[scratch.id] ?? []).find(x => x.id === tab.id)
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
 * already gone while BrowserTabs still holds entries for them. Quitting then walked that map and
 * threw *"Object has been destroyed"* out of `before-quit` — a crash dialog on an app that was
 * leaving anyway, and one that only appears if you close the window before quitting rather than
 * quitting straight from it.
 *
 * Reproduced here by doing precisely that, with the teardown called directly so the check does
 * not depend on the app actually reaching its quit handlers.
 */
async function runQuitSmoke(): Promise<void> {
  const win = window
  const tabs = browserTabs
  if (!win || !tabs) { console.error('[smoke:quit] no window'); app.exit(1); return }

  const bounds = { x: 0, y: 0, width: 400, height: 300 }
  tabs.create('about:blank', bounds)
  tabs.create('about:blank', bounds)

  win.destroy()
  await new Promise((r) => setTimeout(r, 300))

  try {
    tabs.destroyAll()
    ptys?.disposeAll()
  } catch (err) {
    console.error('[smoke:quit] teardown threw after the window was destroyed:', err)
    app.exit(1)
    return
  }
  console.log('[smoke:quit] {"ok":true}')
  app.exit(0)
}

/**
 * End-to-end check on the tab strip's context menu.
 *
 * The close arithmetic itself is covered by `pnpm panes:selftest`. What only a real window can
 * show is the wiring: that a right-click on a terminal or a browser tab produces no menu at all,
 * that one on a file tab does, and that the buttons reach the store. Driven through DOM events
 * rather than the store so the component is genuinely in the loop.
 */
async function runTabsSmoke(): Promise<void> {
  const wc = shellWc()
  if (!wc) { app.exit(1); return }
  try {
    const result = (await wc.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const { store, newTerminalTab } = window.__onestop
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
        const browser = (id) => ({ id, kind: 'browser', title: id, pinned: false,
          url: 'about:blank', viewId: '', canGoBack: false, canGoForward: false,
          loading: false, faviconDataUrl: null })

        // Start from empty. Arriving at Scratch opens a terminal on its own now, so the fixture
        // below would otherwise be counting someone else's tab.
        const already = (store.getState().tabsByWorkspace[ws] ?? []).map(t => t.id)
        if (already.length) store.getState().closeTabs(ws, already)
        await sleep(400)

        const term = newTerminalTab()
        for (const t of [term, editor('e1'), browser('b1'), editor('e2'), editor('e3')]) {
          store.getState().openTab(ws, t)
        }
        await sleep(600)

        const order = () => (store.getState().tabsByWorkspace[ws] ?? []).map(t => t.id).join(',')
        const tabEls = () => [...document.querySelectorAll('.tabstrip .tab')]
        const items = () => [...document.querySelectorAll('.menu .menu__item')]
        const rightClick = (el) => el.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 90, clientY: 20 }))
        const fail = (stage, extra) =>
          JSON.stringify(Object.assign({ ok: false, stage, trail }, extra || {}))

        trail.push('opened: ' + order())
        if (tabEls().length !== 5) return fail('wrong-tab-count', { n: tabEls().length })

        // Neither a terminal nor a browser tab may offer the menu.
        rightClick(tabEls()[0])
        await sleep(150)
        if (document.querySelector('.menu')) return fail('menu-on-terminal')
        rightClick(tabEls()[2])
        await sleep(150)
        if (document.querySelector('.menu')) return fail('menu-on-browser')
        trail.push('no menu on terminal or browser')

        // A file tab must, with all four commands.
        rightClick(tabEls()[1])
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
        const els = tabEls()
        rightClick(els[els.length - 2])
        await sleep(150)
        items().find(b => b.textContent.includes('Other Files')).click()
        await sleep(250)
        trail.push('after close-others: ' + order())
        if (order() !== [term.id, 'b1', 'e4'].join(',')) return fail('close-others-wrong')

        // Selection must never be left pointing at a tab that is gone.
        const active = store.getState().activeTabByWorkspace[ws]
        if (!order().split(',').includes(active)) return fail('active-tab-dangling', { active })

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
