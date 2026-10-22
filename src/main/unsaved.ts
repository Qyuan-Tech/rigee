import { dialog, type BrowserWindow, type WebContents } from 'electron'
import { basename } from 'node:path'
import { t, tn } from '@shared/l10n'
import { emit, handle } from './ipc'

/**
 * Unsaved changes, as far as main needs to know about them: which files, and asking about them.
 *
 * Main has to hold this itself rather than ask the page when the time comes, because by the time a
 * page's `beforeunload` could object, a quit has already killed every shell and torn the plugins
 * down (see `before-quit` in index.ts). So the renderer reports the set as it changes, and quitting
 * or closing the window consults it FIRST, while there is still something to go back to.
 */

let dirty: string[] = []
/** The user said "Don't Save", or everything was saved: stop asking until something changes. */
let released = false
let pendingSave: { id: number; resolve: (ok: boolean) => void } | null = null
let saveSeq = 0

export function registerUnsavedHandlers(): void {
  handle('app:setDirtyFiles', ({ files }) => {
    dirty = files
    // New changes after a "Don't Save" are changes nobody has been asked about yet.
    if (files.length > 0) released = false
  })
  handle('app:saveAllDone', ({ id, ok }) => {
    // Only the answer to the question being waited on: an earlier quit's late reply must not
    // decide a later one.
    if (pendingSave?.id !== id) return
    pendingSave.resolve(ok)
    pendingSave = null
  })
  handle('dialog:unsaved', async ({ files, quitting }) => ask(files, quitting))
}

export const hasUnsavedChanges = (): boolean => dirty.length > 0 && !released

/** A fresh window is a fresh renderer: nothing in it is unsaved, whatever the last one had. */
export function resetUnsaved(): void {
  dirty = []
  released = false
}

async function ask(files: readonly string[], quitting: boolean, win?: BrowserWindow | null): Promise<'save' | 'discard' | 'cancel'> {
  // `smoke:editing` answers for the user: the dialog must never appear on a screen during a test.
  const scripted = process.env.RIGEE_SMOKE ? process.env.RIGEE_SMOKE_UNSAVED_ANSWER : undefined
  if (scripted === 'save' || scripted === 'discard' || scripted === 'cancel') return scripted
  const one = files.length === 1
  const options = {
    type: 'warning' as const,
    buttons: [one ? t('Save') : t('Save All'), t("Don't Save"), t('Cancel')],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    message: one
      ? t('Do you want to save the changes you made to {name}?', { name: basename(files[0]!) })
      : tn(files.length, 'Do you want to save the changes you made to 1 file?', 'Do you want to save the changes you made to {n} files?'),
    detail:
      (one ? '' : `${files.map((f) => basename(f)).join('\n')}\n\n`) +
      (quitting
        ? t("Your changes will be lost if you don't save them before quitting.")
        : t("Your changes will be lost if you don't save them."))
  }
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return response === 0 ? 'save' : response === 1 ? 'discard' : 'cancel'
}

/**
 * Before the window closes or the app quits: ask, and save if asked to. True means go ahead.
 *
 * Saving is the renderer's — the editor holds the text — so main asks for it and waits for the
 * answer, for as long as the page is alive to give one: saving may itself stop to ask — the file
 * changed on disk, overwrite it? — and a person thinking about that must not find the quit quietly
 * abandoned under them. A page that dies meanwhile answers "not saved".
 */
export async function confirmUnsaved(
  win: BrowserWindow | null,
  shell: WebContents | null,
  quitting: boolean
): Promise<boolean> {
  if (!hasUnsavedChanges()) return true
  const choice = await ask(dirty, quitting, win)
  if (choice === 'cancel') return false
  if (choice === 'discard') {
    released = true
    return true
  }
  if (!shell || shell.isDestroyed() || shell.isCrashed()) return false
  const id = ++saveSeq
  const ok = await new Promise<boolean>((resolve) => {
    pendingSave = { id, resolve }
    const gone = (): void => {
      if (pendingSave?.id !== id) return
      pendingSave = null
      resolve(false)
    }
    shell.once('render-process-gone', gone)
    shell.once('destroyed', gone)
    emit(shell, 'app:saveAll', { id })
  })
  if (ok) released = true
  return ok
}
