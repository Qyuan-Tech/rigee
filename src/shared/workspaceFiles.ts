/**
 * Where a named workspace file goes, and what may be called one.
 *
 * Shared by the two sides of "Save Workspace As…", for different reasons. The sidebar says what is
 * wrong with a name while it is still being typed. Main refuses anything else before it touches
 * the disk — and main's check is the one that matters: the name becomes two path segments under a
 * folder the user chose, and a name that could climb out of that folder must never reach `join`.
 *
 * Pure string work with no node:path, so the sandboxed renderer can load it as well.
 */

import { t } from './l10n'

export const WORKSPACE_FILE_EXTENSION = '.code-workspace'

/** What is wrong with this as a workspace's name, or null when it will do. */
export function workspaceNameProblem(name: string): string | null {
  if (name.trim() === '') return t('Give the workspace a name.')
  if (name !== name.trim()) return t('A name cannot start or end with a space.')
  if (name === '.' || name === '..') return t('“{name}” cannot be the name of a folder.', { name })
  // Everything Windows refuses in a file name, which covers what macOS and Linux refuse: a
  // workspace saved on one machine is often opened on another.
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return t('A name cannot contain \\ / : * ? " < > |')
  // Windows drops a trailing dot without a word, and the file would not be called what it says.
  if (name.endsWith('.')) return t('A name cannot end with a dot.')
  if (name.length > 120) return t('That name is too long.')
  return null
}

/**
 * What is wrong with this as the workspace files folder, or null. Empty is fine — it means "not
 * set" — and so is any path that does not depend on where the app happened to start: absolute, or
 * from the home directory.
 */
export function workspaceFilesDirProblem(dir: string): string | null {
  const d = dir.trim()
  if (d === '' || /^(~(?=$|[\\/])|\/|[A-Za-z]:[\\/]|\\\\)/.test(d)) return null
  return t('Use a full path — /…, ~/… or C:\\… — not one relative to somewhere.')
}

/** `<dir>/<name>/<name>.code-workspace`, joined with the caller's separator. */
export function namedWorkspaceFile(dir: string, name: string, sep: string): string {
  const base = dir.trim().replace(/[\\/]+$/, '')
  return [base, name, `${name}${WORKSPACE_FILE_EXTENSION}`].join(sep)
}

/**
 * The folder a workspace file is in, which is where that workspace's terminals start.
 *
 * Here rather than beside the file parsing in main because it is the renderer that decides where a
 * terminal starts. Either separator, since the path is whatever the machine it lives on uses. A file
 * at the root keeps the root's separator: `C:` on its own means wherever C: was last, not its root.
 */
export function workspaceFileDir(file: string): string {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  if (cut < 0) return '.'
  const dir = file.slice(0, cut)
  return dir === '' || /^[A-Za-z]:$/.test(dir) ? file.slice(0, cut + 1) : dir
}
