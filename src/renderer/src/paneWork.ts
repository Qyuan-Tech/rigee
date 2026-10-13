/**
 * Whether a terminal pane is at work, and when it has just stopped — worked out from when it
 * printed and when the user typed into it — so the side bar, the tab strip and the pane itself can
 * show what is still running and what has finished since the user last looked.
 *
 * Pure, as `heat.ts` is, so `pnpm panes:selftest` can hold it to its timings.
 *
 * WORK IS PRINTING, NOT A PROCESS BEING THERE. An agent at work prints all the time — its spinner,
 * its elapsed seconds — and falls silent when it is done or wants an answer, while its process
 * lives on; so does vim's, an idle ssh session's, a dev server's between requests. Counting
 * processes would call every workspace with Claude Code open busy for good, and "finished" would
 * never come for the one thing it most needs to come for. So a pane is working once it has printed
 * for WORK_MIN_MS without a pause of QUIET_MS, and has finished once a pause that long follows: an
 * agent waiting, a build done, a shell back at its prompt. Whatever its own keystrokes echo back
 * is the user's doing, not the pane's, and does not count.
 */

import { allTabs, type GroupRow } from './groups'
import { leaves } from './paneTree'

/** Printing for this long, without a pause of QUIET_MS, is work; anything shorter is a command. */
export const WORK_MIN_MS = 2_000
/**
 * A pause this long after work is the end of it. Long enough to ride out a build's quiet stretch,
 * short enough that an agent asking a question is noticed while it still matters.
 */
export const QUIET_MS = 6_000
/** Output this soon after a keystroke is its echo: a prompt redrawn, an input box re-rendered. */
export const ECHO_MS = 400
/** A pane found to be its own shell printing is not asked about again for this long. */
export const RECHECK_MS = 3_000

export interface PaneWatch {
  /** When it last printed anything that was not the echo of a keystroke. */
  lastOutput: number
  /** When the current run of printing began: the first output after a pause of QUIET_MS. */
  since: number
  /** When the user last typed into it. */
  lastInput: number
  /** Not asked about before this: the last answer was its shell printing for itself. */
  checkAfter: number
  /** Whether it has been called working. */
  working: boolean
}

export function freshWatch(): PaneWatch {
  return { lastOutput: -Infinity, since: -Infinity, lastInput: -Infinity, checkAfter: -Infinity, working: false }
}

/**
 * It printed at `now`. Changes the watch in place rather than returning a new one: this runs for
 * every frame of every terminal.
 */
export function sawOutput(w: PaneWatch, now: number): void {
  if (now - w.lastInput < ECHO_MS) return
  if (now - w.lastOutput >= QUIET_MS) w.since = now
  w.lastOutput = now
}

/** The user typed into it at `now`. */
export function sawInput(w: PaneWatch, now: number): void {
  w.lastInput = now
}

/** Printing the way work does: for WORK_MIN_MS at least, and not yet followed by a pause of QUIET_MS. */
export function printingLikeWork(w: PaneWatch, now: number): boolean {
  return now - w.lastOutput < QUIET_MS && w.lastOutput - w.since >= WORK_MIN_MS
}

/**
 * Whether to ask if a program has its terminal: it prints like work and has not been called
 * working. A shell printing for itself — a slow rc file, a loop typed at the prompt — is asked about
 * again RECHECK_MS later, in case a program has started in front of it since.
 */
export function wantsCheck(w: PaneWatch, now: number): boolean {
  return !w.working && printingLikeWork(w, now) && now >= w.checkAfter
}

/** Asked, and the answer was its shell: not work, for now. */
export function notWork(w: PaneWatch, now: number): void {
  w.checkAfter = now + RECHECK_MS
}

/** It was working, and a pause of QUIET_MS has followed. */
export function hasFinished(w: PaneWatch, now: number): boolean {
  return w.working && now - w.lastOutput >= QUIET_MS
}

/** Whether it can still change without printing again: what keeps the clock running. */
export function isLive(w: PaneWatch, now: number): boolean {
  return w.working || now - w.lastOutput < QUIET_MS
}

/** A terminal pane with a shell: where it is, to go to it, and its pty, to ask about it. */
export interface PaneAt {
  tabId: string
  leafId: string
  paneId: string
}

/** Every terminal pane with a shell in a row of groups, tab by tab from the left. */
export function terminalPanes(row: GroupRow): PaneAt[] {
  const out: PaneAt[] = []
  for (const tab of allTabs(row)) {
    if (tab.kind !== 'terminal') continue
    for (const leaf of leaves(tab.root)) {
      if (leaf.paneId) out.push({ tabId: tab.id, leafId: leaf.id, paneId: leaf.paneId })
    }
  }
  return out
}

/**
 * "2 at work — claude, npm": a count and what is counted, for a badge's tooltip. Programs are named
 * once each, and only when main could name them.
 */
export function describePanes(count: number, what: string, programs: readonly string[]): string {
  const named = [...new Set(programs.filter(Boolean))]
  return `${count} ${count === 1 ? 'terminal' : 'terminals'} ${what}${named.length > 0 ? ` — ${named.join(', ')}` : ''}`
}
