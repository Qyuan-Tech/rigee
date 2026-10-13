import { clipboard, shell } from 'electron'
import { cp, lstat, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, sep } from 'node:path'
import type { Context } from 'cordis'
import { nameProblem, type Transfer, type TransferResult } from '../protocol'

/**
 * The tree's file operations, done where they can be: in main, with the disk and the Trash to hand
 * and the questions they raise asked in native dialogs.
 *
 * Every question goes through the shell's `ask` rather than Electron's `dialog`, so the smoke mode
 * can answer it. And every one is asked BEFORE anything is touched: a copy that stopped at the
 * fourth of nine names to ask about it would leave the user deciding with three already done, and
 * Cancel would no longer mean "as it was".
 */

/** The shell's `ask`, bound by the caller. */
export type Ask = Context['shell']['ask']

const WINDOWS = process.platform === 'win32'
/** What the user calls the place deleted files go. */
const BIN = WINDOWS ? 'Recycle Bin' : 'Trash'

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
function listed(paths: readonly string[]): string {
  const shown = paths.slice(0, 10).map(nameOf).join('\n')
  return paths.length > 10 ? `${shown}\n…and ${paths.length - 10} more` : shown
}

/** What went wrong in words — the system's reason, without the syscall and the path the dialog already names. */
function reason(err: unknown): string {
  switch ((err as NodeJS.ErrnoException | null)?.code) {
    case 'EACCES':
    case 'EPERM':
      return 'Permission denied.'
    case 'ENOENT':
      return 'It is no longer there.'
    case 'EBUSY':
      return 'It is in use by another program.'
    case 'ENOSPC':
      return 'The disk is full.'
    case 'EROFS':
      return 'The disk is read-only.'
    case 'ENAMETOOLONG':
      return 'The name is too long.'
    default:
      return err instanceof Error ? err.message : String(err)
  }
}

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false)
const isFolder = (path: string): Promise<boolean> => stat(path).then((s) => s.isDirectory(), () => false)

/** Say what went wrong, and wait for the OK. */
async function tell(ask: Ask, message: string, detail?: string): Promise<void> {
  await ask({ type: 'error', message, ...(detail ? { detail } : {}), buttons: ['OK'], defaultId: 0, cancelId: 0 })
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
export async function create(dir: string, name: string, folder: boolean): Promise<string> {
  const problem = nameProblem(name, { nested: true, windows: WINDOWS })
  if (problem) throw new Error(problem)
  const target = join(dir, name)
  try {
    await mkdir(dirname(target), { recursive: true })
    if (folder) await mkdir(target)
    else await writeFile(target, '', { flag: 'wx' })
  } catch (err) {
    throw new Error((err as NodeJS.ErrnoException).code === 'EEXIST' ? `“${name}” already exists here.` : reason(err))
  }
  return target
}

/**
 * Rename in place. `rename` replaces a file that is already there without a word, so a taken name
 * is refused first — unless it is this same file, which is how a change of case looks on the disks
 * that ignore case, the default on macOS and Windows.
 */
export async function renameEntry(path: string, name: string): Promise<string> {
  const problem = nameProblem(name, { nested: false, windows: WINDOWS })
  if (problem) throw new Error(problem)
  const target = join(dirname(path), name)
  if (target === path) return path
  const [from, there] = await Promise.all([lstat(path), lstat(target).catch(() => null)]).catch((err: unknown) => {
    throw new Error(reason(err))
  })
  const recased = there !== null && there.ino === from.ino && there.dev === from.dev && target.toLowerCase() === path.toLowerCase()
  if (there && !recased) throw new Error(`“${name}” already exists here.`)
  await rename(path, target).catch((err: unknown) => {
    throw new Error(reason(err))
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
export async function transfer(t: Transfer, ask: Ask): Promise<TransferResult> {
  const sources = topmost(t.sources)
  const into = nameOf(t.target)

  // Their changes live in the editor's document for the old path; see `filesMoved` in the shell.
  if (t.mode === 'move' && t.unsaved && t.unsaved.length > 0) {
    const one = t.unsaved.length === 1
    await tell(
      ask,
      one ? `“${nameOf(t.unsaved[0]!)}” has unsaved changes.` : `${t.unsaved.length} files have unsaved changes.`,
      `${one ? '' : listed(t.unsaved) + '\n\n'}Save or undo the changes first, and then move ${one ? 'it' : 'them'}.`
    )
    return { done: [] }
  }

  // Folders from outside, dropped on one of the workspace's own folders: dropping folders on the
  // tree is also how a workspace is put together, so which was meant is asked, as VS Code asks.
  if (t.external && t.intoRoot) {
    const folders = (await Promise.all(sources.map(async (p) => ((await isFolder(p)) ? p : null)))).filter(
      (p): p is string => p !== null
    )
    if (folders.length > 0) {
      const one = folders.length === 1
      const choice = await ask({
        type: 'question',
        message: one
          ? `Add “${nameOf(folders[0]!)}” to the workspace, or copy it into “${into}”?`
          : `Add these ${folders.length} folders to the workspace, or copy them into “${into}”?`,
        ...(one ? {} : { detail: listed(folders) }),
        buttons: [one ? 'Add Folder to Workspace' : 'Add Folders to Workspace', one ? 'Copy Folder' : 'Copy Folders', 'Cancel'],
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
    if (within(t.target, from)) {
      await tell(ask, `Cannot ${t.mode} “${nameOf(from)}” into itself.`)
      return { done: [] }
    }
    if (t.mode === 'move' && dirname(from) === t.target) continue
    let to = join(t.target, nameOf(from))
    let replace = false
    if (await taken(to)) {
      if (t.mode === 'copy' && (!t.external || to === from)) {
        const folder = await isFolder(from)
        let name = nameOf(from)
        do name = nextName(name, folder)
        while (await taken(join(t.target, name)))
        to = join(t.target, name)
      } else if (claimed.has(key(to))) {
        await tell(ask, `Two of these are called “${nameOf(from)}”.`, `Only one of them can go into “${into}”.`)
        return { done: [] }
      } else if (within(from, to)) {
        await tell(ask, `“${nameOf(to)}” cannot be replaced by something inside it.`)
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
    const choice = await ask({
      type: 'warning',
      message: one
        ? `“${nameOf(replacing[0]!.to)}” already exists in “${into}”. Replace it?`
        : `${replacing.length} of these already exist in “${into}”. Replace them?`,
      detail: `${one ? '' : listed(replacing.map((step) => step.to)) + '\n\n'}What is replaced goes to the ${BIN}.`,
      buttons: ['Replace', 'Cancel'],
      defaultId: 0,
      cancelId: 1
    })
    if (choice !== 0) return { done: [] }
  }

  const done: TransferResult['done'] = []
  for (const step of plan) {
    try {
      if (step.replace) await shell.trashItem(step.to)
      if (t.mode === 'copy') await cp(step.from, step.to, COPY)
      else await move(step.from, step.to)
      done.push({ from: step.from, to: step.to })
    } catch (err) {
      await tell(ask, `Could not ${t.mode} “${nameOf(step.from)}”.`, reason(err))
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
export async function remove(paths: string[], permanently: boolean, unsaved: string[], ask: Ask): Promise<string[]> {
  const targets = topmost(paths)
  if (targets.length === 0) return []
  const one = targets.length === 1
  const what = one ? `“${nameOf(targets[0]!)}”` : `these ${targets.length} items`
  const losing =
    unsaved.length === 0
      ? null
      : one && unsaved.length === 1 && unsaved[0] === targets[0]
        ? 'Its unsaved changes will be lost.'
        : unsaved.length === 1
          ? `Unsaved changes to “${nameOf(unsaved[0]!)}” will be lost.`
          : `Unsaved changes to ${unsaved.length} files will be lost.`
  const sure = await ask({
    type: 'warning',
    message: permanently ? `Are you sure you want to permanently delete ${what}?` : `Are you sure you want to delete ${what}?`,
    detail: [
      one ? null : listed(targets),
      permanently ? 'This cannot be undone.' : `You can restore ${one ? 'it' : 'them'} from the ${BIN}.`,
      losing
    ]
      .filter((line): line is string => line !== null)
      .join('\n\n'),
    buttons: [permanently ? 'Delete' : `Move to ${BIN}`, 'Cancel'],
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
          message: `“${nameOf(path)}” could not be moved to the ${BIN}. Delete it permanently instead?`,
          detail: `${reason(err)}\n\nThis cannot be undone.`,
          buttons: ['Delete Permanently', 'Cancel'],
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
      await tell(ask, `Could not delete “${nameOf(path)}”.`, reason(err))
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
