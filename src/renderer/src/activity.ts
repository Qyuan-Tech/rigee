import { OUTPUT_MINUTE_CHARS, recordMinute } from './heat'
import { useApp } from './store'
import type { WorkspaceId } from '@shared/types'

/**
 * Noticing what workspace heat is worked out from (heat.ts): minutes of the user's attention, and
 * minutes in which a workspace's terminals printed in earnest.
 *
 * Each is counted at most once a minute per workspace, which is all the arithmetic wants and what
 * keeps this cheap on the paths it sits on — every keystroke, every frame of terminal output. Those
 * cost a clock read and a map lookup here; the store is written once a minute at most.
 */

const MINUTE = 60_000

/** The minute last counted as use, per workspace. */
const usedMinute = new Map<WorkspaceId, number>()
/** What its terminals have printed this minute, per workspace; past the threshold the minute counts. */
const printed = new Map<WorkspaceId, { minute: number; chars: number }>()

function record(workspaceId: WorkspaceId, kind: 'used' | 'output', now: number): void {
  const s = useApp.getState()
  // A workspace removed while its terminals were still printing.
  if (!s.workspaces.some((w) => w.id === workspaceId)) return
  s.setActivity(workspaceId, recordMinute(s.activityByWorkspace[workspaceId], kind, now))
}

/** The user did something in this workspace, or switched to it. */
export function noteUse(workspaceId: WorkspaceId): void {
  // Not before the restore has finished: the workspace a launch lands on is where the user left
  // off, not something they chose just now — and the first key they press there counts anyway.
  if (!useApp.getState().ready) return
  const now = Date.now()
  const minute = Math.floor(now / MINUTE)
  if (usedMinute.get(workspaceId) === minute) return
  usedMinute.set(workspaceId, minute)
  record(workspaceId, 'used', now)
}

/** This workspace's terminals printed `chars` characters. Called for every frame, so it is cheap. */
export function noteOutput(workspaceId: WorkspaceId, chars: number): void {
  const now = Date.now()
  const minute = Math.floor(now / MINUTE)
  let tally = printed.get(workspaceId)
  if (!tally || tally.minute !== minute) {
    tally = { minute, chars: 0 }
    printed.set(workspaceId, tally)
  }
  if (tally.chars >= OUTPUT_MINUTE_CHARS) return
  tally.chars += chars
  if (tally.chars >= OUTPUT_MINUTE_CHARS && useApp.getState().ready) record(workspaceId, 'output', now)
}

/**
 * Count the user's own input as use of the workspace on screen, and arriving at a workspace as use
 * of it. Returns the uninstaller.
 *
 * Listening on the window, in the capture phase and passively, sees every key, press and scroll the
 * shell's document gets — the terminal's, the editor's, the panels' — without any of them having to
 * report in. What it cannot see is input to a browser tab, which is a page of its own.
 */
export function installActivityTracking(): () => void {
  const onInput = (e: Event): void => {
    // A press in the workspace list is a switch, and counts for the workspace switched to rather
    // than as a minute of the one being left.
    if (e.target instanceof Element && e.target.closest('.workspace-list')) return
    const id = useApp.getState().activeWorkspaceId
    if (id) noteUse(id)
  }
  const options = { capture: true, passive: true }
  window.addEventListener('keydown', onInput, options)
  window.addEventListener('pointerdown', onInput, options)
  window.addEventListener('wheel', onInput, options)
  const unsubscribe = useApp.subscribe(
    (s) => s.activeWorkspaceId,
    (id) => { if (id) noteUse(id) }
  )
  return () => {
    window.removeEventListener('keydown', onInput, options)
    window.removeEventListener('pointerdown', onInput, options)
    window.removeEventListener('wheel', onInput, options)
    unsubscribe()
  }
}
