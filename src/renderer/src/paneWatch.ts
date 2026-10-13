import { onEvent, platform, rpc } from './ipc'
import {
  freshWatch,
  hasFinished,
  isLive,
  notWork,
  sawInput,
  sawOutput,
  wantsCheck,
  type PaneWatch
} from './paneWork'
import { useApp } from './store'

/**
 * Watching terminal panes for work (paneWork.ts): their output and the user's keystrokes noted as
 * they happen, and a clock that runs only while some pane is printing or at work.
 *
 * Output is noted for every frame of every terminal, so noting it is a clock read and a field or
 * two. The store is written only when a pane starts work, finishes, or is looked at; and main is
 * asked about a pane's program only when the pane begins to print like work — never on a timer,
 * so a window full of idle shells costs nothing at all.
 */

const TICK_MS = 1_000

const watches = new Map<string, PaneWatch>()
let clock: ReturnType<typeof setInterval> | null = null
/**
 * The pane the keyboard is in, as its xterm last said, or null when it is in none of them. Held as
 * the terminal itself and its pane id read when needed: a new pane takes the keyboard before its
 * shell has started and has an id to give.
 */
let focused: { readonly paneId: string | null } | null = null
/** One question to main at a time: the clock does not wait for the answer. */
let asking = false

function watch(paneId: string): PaneWatch {
  let w = watches.get(paneId)
  if (!w) {
    w = freshWatch()
    watches.set(paneId, w)
  }
  return w
}

/** A pane printed something. */
export function notePaneOutput(paneId: string): void {
  sawOutput(watch(paneId), Date.now())
  clock ??= setInterval(() => void tick(), TICK_MS)
}

/** The user typed into a pane: what it prints next is the echo, for a moment. */
export function notePaneInput(paneId: string): void {
  sawInput(watch(paneId), Date.now())
}

/**
 * The keyboard went into this terminal, or out of every one (null). Going in is looking at it, so
 * whatever finished there is no longer unseen — a click, a tab shown, a badge followed, or the
 * window coming back to the front with the keyboard still in it.
 */
export function notePaneFocus(terminal: { readonly paneId: string | null } | null): void {
  focused = terminal
  const paneId = terminal?.paneId
  const s = useApp.getState()
  if (paneId && paneId in s.unseenPanes) s.setPaneUnseen(paneId, null)
}

/** Whether the user can be taken to have seen this pane now: the keyboard in it, the window in front. */
const inView = (paneId: string): boolean => focused?.paneId === paneId && document.hasFocus()

async function tick(): Promise<void> {
  const now = Date.now()
  const s = useApp.getState()
  for (const [paneId, w] of watches) {
    if (!hasFinished(w, now)) continue
    w.working = false
    const program = s.workingPanes[paneId] ?? ''
    s.setPaneWorking(paneId, null)
    if (!inView(paneId)) s.setPaneUnseen(paneId, program)
  }
  const ask = [...watches].filter(([, w]) => wantsCheck(w, now)).map(([paneId]) => paneId)
  if (ask.length > 0 && !asking) await check(ask)
  if (clock && ![...watches.values()].some((w) => isLive(w, Date.now()))) {
    clearInterval(clock)
    clock = null
  }
}

/**
 * Ask main which of these panes have a program in front of their shell. Those that do are at work;
 * those that do not are their shell printing for itself, and are asked about again later. Windows
 * cannot say, and a question that fails is no answer either: printing like work has to do.
 */
async function check(paneIds: string[]): Promise<void> {
  asking = true
  let programs: Map<string, string> | null = null
  try {
    if (platform() !== 'win32') {
      programs = new Map((await rpc['terminal:running']({ paneIds })).map((r) => [r.paneId, r.process]))
    }
  } catch {
    programs = null
  } finally {
    asking = false
  }
  const s = useApp.getState()
  const now = Date.now()
  for (const paneId of paneIds) {
    const w = watches.get(paneId)
    // Gone while main was answering, or called working by an answer that came first.
    if (!w || w.working) continue
    if (programs && !programs.has(paneId)) {
      notWork(w, now)
      continue
    }
    w.working = true
    s.setPaneWorking(paneId, programs?.get(paneId) ?? '')
    // At work again, so not finished any more, whether or not anybody saw that it had.
    if (paneId in s.unseenPanes) s.setPaneUnseen(paneId, null)
  }
}

/** Forget panes whose shell has gone — the tab closed, the shell exited. Returns the uninstaller. */
export function installPaneWatch(): () => void {
  return onEvent('terminal:exit', ({ paneId }) => {
    watches.delete(paneId)
    useApp.getState().forgetPane(paneId)
  })
}
