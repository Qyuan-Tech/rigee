import { clipboard, shell } from 'electron'
import { cp, lstat, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, sep } from 'node:path'
import type { Context } from 'cordis'
import type { Translator } from '@rigee/plugin-api/l10n'
import { nameProblem, type Transfer, type TransferResult } from '../protocol'
import { translatorFor } from './l10n'

/**
 * The tree's file operations, done where they can be: in main, with the disk and the Trash to hand
 * and the questions they raise asked in native dialogs.
 *
 * Every question goes through the shell's `ask` rather than Electron's `dialog`, so the smoke mode
 * can answer it. And every one is asked BEFORE anything is touched: a copy that stopped at the
 * fourth of nine names to ask about it would leave the user deciding with three already done, and
 * Cancel would no longer mean "as it was".
 *
 * Everything an operation says, from its first question to its last refusal, is in the language
 * the shell is in when the operation begins: `locale` is asked then rather than once at activation,
 * since the user can switch language while the app runs.
 */

/** The shell's `ask`, bound by the caller. */
export type Ask = Context['shell']['ask']
/** The shell's `locale`, bound by the caller. */
export type CurrentLocale = Context['shell']['locale']

const WINDOWS = process.platform === 'win32'
/**
 * Whether the place deleted files go is, in `locale`, called the Recycle Bin rather than the Trash.
 * A sentence that names it is written out whole both ways rather than built round the word. Linux
 * has a Trash in English, as a Mac does, but in Chinese a 回收站, as Windows does, where the Mac has
 * a 废纸篓; and a table, finding a sentence by its English alone, cannot tell Linux from the Mac. So
 * Linux in Chinese says Windows's sentences.
 */
const recycleBin = (locale: string): boolean => WINDOWS || (process.platform === 'linux' && locale === 'zh-CN')

/** How everything here copies: whole folders, nothing overwritten, links kept as the links they are. */
const COPY = { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true, preserveTimestamps: true }

const nameOf = (path: string): string => basename(path) || path

/** `path` is `root`, or inside it. */
const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

/** Each path once, and none inside another: what happens to a folder happens to what is in it. */
function topmost(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)]
  return unique.filter((p) => !unique.some((q) => q !== p && within(p, q)))
}

/** The names a question is about, one a line, and how many more there are past the tenth. */
function listed(paths: readonly string[], t: Translator['t']): string {
  const shown = paths.slice(0, 10).map(nameOf).join('\n')
  return paths.length > 10 ? `${shown}\n${t('…and {n} more', { n: paths.length - 10 })}` : shown
}

/** What went wrong in words — the system's reason, without the syscall and the path the dialog already names. */
function reason(err: unknown, t: Translator['t']): string {
  switch ((err as NodeJS.ErrnoException | null)?.code) {
    case 'EACCES':
    case 'EPERM':
      return t('Permission denied.')
    case 'ENOENT':
      return t('It is no longer there.')
    case 'EBUSY':
      return t('It is in use by another program.')
    case 'ENOSPC':
      return t('The disk is full.')
    case 'EROFS':
      return t('The disk is read-only.')
    case 'ENAMETOOLONG':
      return t('The name is too long.')
    default:
      return err instanceof Error ? err.message : String(err)
  }
}

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false)
const isFolder = (path: string): Promise<boolean> => stat(path).then((s) => s.isDirectory(), () => false)

/** Say what went wrong, and wait for the OK. */
async function tell(ask: Ask, t: Translator['t'], message: string, detail?: string): Promise<void> {
  await ask({ type: 'error', message, ...(detail ? { detail } : {}), buttons: [t('OK')], defaultId: 0, cancelId: 0 })
}

/** VS Code's simple naming for a copy where the name is taken: `name copy.txt`, then `name copy 2.txt`. */
function nextName(name: string, folder: boolean): string {
  const ext = folder ? '' : extname(name)
  const stem = name.slice(0, name.length - ext.length)
  const counted = /^(.+ copy)(?: (\d+))?$/.exec(stem)
  if (!counted) return `${stem} copy${ext}`
  return `${counted[1]} ${counted[2] ? Number(counted[2]) + 1 : 2}${ext}`
}

/**
 * A new empty file or folder. Created exclusively — `wx`, a plain mkdir — rather than checked for
 * first, so that an agent writing the same name a moment earlier is refused instead of emptied.
 */
export async function create(dir: string, name: string, folder: boolean, locale: CurrentLocale): Promise<string> {
  const { t } = translatorFor(locale())
  const problem = nameProblem(name, { nested: true, windows: WINDOWS }, t)
  if (problem) throw new Error(problem)
  const target = join(dir, name)
  try {
    await mkdir(dirname(target), { recursive: true })
    if (folder) await mkdir(target)
    else await writeFile(target, '', { flag: 'wx' })
  } catch (err) {
    throw new Error((err as NodeJS.ErrnoException).code === 'EEXIST' ? t('“{name}” already exists here.', { name }) : reason(err, t))
  }
  return target
}

/**
 * Rename in place. `rename` replaces a file that is already there without a word, so a taken name
 * is refused first — unless it is this same file, which is how a change of case looks on the disks
 * that ignore case, the default on macOS and Windows.
 */
export async function renameEntry(path: string, name: string, locale: CurrentLocale): Promise<string> {
  const { t } = translatorFor(locale())
  const problem = nameProblem(name, { nested: false, windows: WINDOWS }, t)
  if (problem) throw new Error(problem)
  const target = join(dirname(path), name)
  if (target === path) return path
  const [from, there] = await Promise.all([lstat(path), lstat(target).catch(() => null)]).catch((err: unknown) => {
    throw new Error(reason(err, t))
  })
  const recased = there !== null && there.ino === from.ino && there.dev === from.dev && target.toLowerCase() === path.toLowerCase()
  if (there && !recased) throw new Error(t('“{name}” already exists here.', { name }))
  await rename(path, target).catch((err: unknown) => {
    throw new Error(reason(err, t))
  })
  return target
}

/** `rename`, or — across volumes, where rename cannot go — a copy and then away with the original. */
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await cp(from, to, COPY)
    await rm(from, { recursive: true, force: true })
  }
}

/**
 * Copy or move entries into a folder: Paste, a drag inside the tree, and files dropped in from
 * another application.
 *
 * A copy whose name is taken gets the next free one, so pasting a file into its own folder is how
 * you duplicate it — except a copy from outside, where the same name usually means a newer version
 * of the same file, so the user is asked whether to replace it. So is a move: a file moved over
 * another is never a duplicate. What is replaced goes to the Trash, not into the void.
 */
export async function transfer(job: Transfer, ask: Ask, locale: CurrentLocale): Promise<TransferResult> {
  const { t, locale: language } = translatorFor(locale())
  const sources = topmost(job.sources)
  const into = nameOf(job.target)

  // Their changes live in the editor's document for the old path; see `filesMoved` in the shell.
  if (job.mode === 'move' && job.unsaved && job.unsaved.length > 0) {
    const one = job.unsaved.length === 1
    await tell(
      ask,
      t,
      one
        ? t('“{name}” has unsaved changes.', { name: nameOf(job.unsaved[0]!) })
        : t('{n} files have unsaved changes.', { n: job.unsaved.length }),
      one
        ? t('Save or undo the changes first, and then move it.')
        : `${listed(job.unsaved, t)}\n\n${t('Save or undo the changes first, and then move them.')}`
    )
    return { done: [] }
  }

  // Folders from outside, dropped on one of the workspace's own folders: dropping folders on the
  // tree is also how a workspace is put together, so which was meant is asked, as VS Code asks.
  if (job.external && job.intoRoot) {
    const folders = (await Promise.all(sources.map(async (p) => ((await isFolder(p)) ? p : null)))).filter(
      (p): p is string => p !== null
    )
    if (folders.length > 0) {
      const one = folders.length === 1
      const choice = await ask({
        type: 'question',
        message: one
          ? t('Add “{name}” to the workspace, or copy it into “{folder}”?', { name: nameOf(folders[0]!), folder: into })
          : t('Add these {n} folders to the workspace, or copy them into “{folder}”?', { n: folders.length, folder: into }),
        ...(one ? {} : { detail: listed(folders, t) }),
        buttons: [
          one ? t('Add Folder to Workspace') : t('Add Folders to Workspace'),
          one ? t('Copy Folder') : t('Copy Folders'),
          t('Cancel')
        ],
        defaultId: 0,
        cancelId: 2
      })
      if (choice === 2) return { done: [] }
      if (choice === 0) return { done: [], addToWorkspace: folders }
    }
  }

  // Every destination is settled before anything is touched — including against each other, since
  // two of the sources may share a name.
  const plan: Array<{ from: string; to: string; replace: boolean }> = []
  const claimed = new Set<string>()
  const key = (p: string): string => (process.platform === 'linux' ? p : p.toLowerCase())
  const taken = async (p: string): Promise<boolean> => claimed.has(key(p)) || (await exists(p))
  for (const from of sources) {
    if (within(job.target, from)) {
      const name = nameOf(from)
      await tell(
        ask,
        t,
        job.mode === 'copy' ? t('Cannot copy “{name}” into itself.', { name }) : t('Cannot move “{name}” into itself.', { name })
      )
      return { done: [] }
    }
    if (job.mode === 'move' && dirname(from) === job.target) continue
    let to = join(job.target, nameOf(from))
    let replace = false
    if (await taken(to)) {
      if (job.mode === 'copy' && (!job.external || to === from)) {
        const folder = await isFolder(from)
        let name = nameOf(from)
        do name = nextName(name, folder)
        while (await taken(join(job.target, name)))
        to = join(job.target, name)
      } else if (claimed.has(key(to))) {
        await tell(
          ask,
          t,
          t('Two of these are called “{name}”.', { name: nameOf(from) }),
          t('Only one of them can go into “{folder}”.', { folder: into })
        )
        return { done: [] }
      } else if (within(from, to)) {
        await tell(ask, t, t('“{name}” cannot be replaced by something inside it.', { name: nameOf(to) }))
        return { done: [] }
      } else {
        replace = true
      }
    }
    claimed.add(key(to))
    plan.push({ from, to, replace })
  }

  const replacing = plan.filter((step) => step.replace)
  if (replacing.length > 0) {
    const one = replacing.length === 1
    const recoverable = recycleBin(language)
      ? t('What is replaced goes to the Recycle Bin.')
      : t('What is replaced goes to the Trash.')
    const choice = await ask({
      type: 'warning',
      message: one
        ? t('“{name}” already exists in “{folder}”. Replace it?', { name: nameOf(replacing[0]!.to), folder: into })
        : t('{n} of these already exist in “{folder}”. Replace them?', { n: replacing.length, folder: into }),
      detail: `${one ? '' : listed(replacing.map((step) => step.to), t) + '\n\n'}${recoverable}`,
      buttons: [t('Replace'), t('Cancel')],
      defaultId: 0,
      cancelId: 1
    })
    if (choice !== 0) return { done: [] }
  }

  const done: TransferResult['done'] = []
  for (const step of plan) {
    try {
      if (step.replace) await shell.trashItem(step.to)
      if (job.mode === 'copy') await cp(step.from, step.to, COPY)
      else await move(step.from, step.to)
      done.push({ from: step.from, to: step.to })
    } catch (err) {
      const name = nameOf(step.from)
      const failed = job.mode === 'copy' ? t('Could not copy “{name}”.', { name }) : t('Could not move “{name}”.', { name })
      await tell(ask, t, failed, reason(err, t))
      break
    }
  }
  return { done }
}

/**
 * Delete, once the user has said yes: to the Trash, or for good when they asked for that. A disk
 * with no Trash — a network share, some removable volumes — is offered permanent deletion instead,
 * once, for the rest of the batch. Answers with what is gone.
 */
export async function remove(
  paths: string[],
  permanently: boolean,
  unsaved: string[],
  ask: Ask,
  locale: CurrentLocale
): Promise<string[]> {
  const targets = topmost(paths)
  if (targets.length === 0) return []
  const { t, locale: language } = translatorFor(locale())
  const recycle = recycleBin(language)
  const one = targets.length === 1
  const what = { name: nameOf(targets[0]!), n: targets.length }
  const losing =
    unsaved.length === 0
      ? null
      : one && unsaved.length === 1 && unsaved[0] === targets[0]
        ? t('Its unsaved changes will be lost.')
        : unsaved.length === 1
          ? t('Unsaved changes to “{name}” will be lost.', { name: nameOf(unsaved[0]!) })
          : t('Unsaved changes to {n} files will be lost.', { n: unsaved.length })
  const restore = recycle
    ? one ? t('You can restore it from the Recycle Bin.') : t('You can restore them from the Recycle Bin.')
    : one ? t('You can restore it from the Trash.') : t('You can restore them from the Trash.')
  const sure = await ask({
    type: 'warning',
    message: permanently
      ? one
        ? t('Are you sure you want to permanently delete “{name}”?', what)
        : t('Are you sure you want to permanently delete these {n} items?', what)
      : one
        ? t('Are you sure you want to delete “{name}”?', what)
        : t('Are you sure you want to delete these {n} items?', what),
    detail: [one ? null : listed(targets, t), permanently ? t('This cannot be undone.') : restore, losing]
      .filter((line): line is string => line !== null)
      .join('\n\n'),
    buttons: [permanently ? t('Delete') : recycle ? t('Move to Recycle Bin') : t('Move to Trash'), t('Cancel')],
    defaultId: 0,
    cancelId: 1
  })
  if (sure !== 0) return []

  const deleted: string[] = []
  let forever = permanently
  for (const path of targets) {
    if (!forever) {
      try {
        await shell.trashItem(path)
        deleted.push(path)
        continue
      } catch (err) {
        const instead = await ask({
          type: 'warning',
          message: recycle
            ? t('“{name}” could not be moved to the Recycle Bin. Delete it permanently instead?', { name: nameOf(path) })
            : t('“{name}” could not be moved to the Trash. Delete it permanently instead?', { name: nameOf(path) }),
          detail: `${reason(err, t)}\n\n${t('This cannot be undone.')}`,
          buttons: [t('Delete Permanently'), t('Cancel')],
          defaultId: 1,
          cancelId: 1
        })
        if (instead !== 0) break
        forever = true
      }
    }
    try {
      await rm(path, { recursive: true, force: true })
      deleted.push(path)
    } catch (err) {
      await tell(ask, t, t('Could not delete “{name}”.', { name: nameOf(path) }), reason(err, t))
      break
    }
  }
  return deleted
}

export function reveal(path: string): void {
  shell.showItemInFolder(path)
}

export async function copyText(text: string): Promise<void> {
  await clipboard.writeText(text)
}
