/**
 * Reading and writing `.code-workspace` files.
 *
 * The format is VS Code's, because that is what the user already has on disk and there is nothing
 * to gain from inventing a second one:
 *
 *   {
 *     "folders": [ { "path": "repo-a" }, { "path": "/abs/repo-b", "name": "Custom" } ],
 *     "settings": { }
 *   }
 *
 * Paths are resolved against the directory holding the file, which is what makes a workspace file
 * committable next to the repos it groups.
 *
 * Pure and filesystem-free so it can be unit tested: the parsing is the part with edges, and a
 * malformed workspace file should produce a diagnosable error rather than a half-loaded window.
 */

import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

export interface WorkspaceFileFolder {
  path: string
  name?: string
}

export interface ParsedWorkspaceFile {
  /** Display name for the workspace: the file's basename without the extension. */
  name: string
  /** Absolute, de-duplicated, in file order. */
  folders: WorkspaceFileFolder[]
}

/**
 * Strip comments and trailing commas so `JSON.parse` accepts the file.
 *
 * VS Code writes plain JSON but reads JSONC, and people hand-edit these files — a `//` note above
 * a folder entry is common and must not make the workspace unopenable. String contents are left
 * alone, which is the whole difficulty: a `//` inside a Windows path or a URL is not a comment.
 */
export function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  let comment: 'line' | 'block' | null = null

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const next = text[i + 1]

    if (comment === 'line') {
      if (c === '\n') { comment = null; out += c }
      continue
    }
    if (comment === 'block') {
      if (c === '*' && next === '/') { comment = null; i++ }
      continue
    }
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (c === '/' && next === '/') { comment = 'line'; i++; continue }
    if (c === '/' && next === '*') { comment = 'block'; i++; continue }
    out += c
  }

  // Trailing commas, now that no comma inside a string or comment can be confused for one.
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/** Throws with a message naming the file, which is the only useful thing to show a user here. */
export function parseWorkspaceFile(text: string, filePath: string): ParsedWorkspaceFile {
  const label = basename(filePath)
  let doc: unknown
  try {
    doc = JSON.parse(stripJsonComments(text))
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err instanceof Error ? err.message : err}`)
  }
  if (!doc || typeof doc !== 'object') throw new Error(`${label} is not a workspace file`)

  const rawFolders = (doc as { folders?: unknown }).folders
  if (!Array.isArray(rawFolders)) {
    throw new Error(`${label} has no "folders" array`)
  }

  const base = dirname(resolve(filePath))
  const seen = new Set<string>()
  const folders: WorkspaceFileFolder[] = []
  for (const raw of rawFolders) {
    const p = (raw as { path?: unknown })?.path
    if (typeof p !== 'string' || p === '') continue
    const abs = isAbsolute(p) ? resolve(p) : resolve(join(base, p))
    if (seen.has(abs)) continue
    seen.add(abs)
    const name = (raw as { name?: unknown })?.name
    folders.push(typeof name === 'string' && name ? { path: abs, name } : { path: abs })
  }

  return { name: label.replace(/\.code-workspace$/i, ''), folders }
}

/**
 * Render a workspace file. Folders below the file's own directory are written relative, the way
 * VS Code does it, so a workspace checked in beside its repos still resolves on another machine.
 */
export function serializeWorkspaceFile(
  folders: readonly WorkspaceFileFolder[],
  filePath: string
): string {
  const base = dirname(resolve(filePath))
  const entries = folders.map((f) => {
    const abs = resolve(f.path)
    const rel = relative(base, abs)
    const usable = rel !== '' && !isAbsolute(rel) && !rel.startsWith('..')
    const out: WorkspaceFileFolder = { path: usable ? rel : abs }
    if (f.name && f.name !== basename(abs)) out.name = f.name
    return out
  })
  // Two-space indent and a trailing newline: this file is meant to be committed and diffed.
  return `${JSON.stringify({ folders: entries, settings: {} }, null, 2)}\n`
}
