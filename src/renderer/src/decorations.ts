import { create } from 'zustand'
import type { FileDecoration } from '@rigee/plugin-api'

/**
 * Colours and badges on file names — VS Code's file decorations, reduced to what the tree needs.
 *
 * The shell owns neither side: source control knows WHICH files changed, the explorer knows how
 * to DRAW a file. Neither may import the other, so they meet here. Each source replaces its whole
 * set at once — one per repository, from one status snapshot — which keeps a change of status one
 * render, not one per file.
 *
 * A folder takes the colour of the most important change beneath it, as in VS Code, so a change
 * three levels down is still visible with the folder collapsed. That roll-up is computed when a
 * set arrives, not per lookup: a row asks on every render, a status lands once in a while.
 *
 * Keys are paths with forward slashes, whatever the platform, so a Windows root spelled with
 * backslashes by one side and slashes by the other still meets itself.
 */

interface Decorations {
  /** Every file and folder with a decoration, its own or rolled up from below. */
  byPath: Map<string, FileDecoration>
  /** Folders whose decoration covers everything inside them — an untracked directory. */
  recursive: Map<string, FileDecoration>
}

const sources = new Map<string, Map<string, FileDecoration>>()

const useDecorations = create<Decorations>()(() => ({ byPath: new Map(), recursive: new Map() }))

const norm = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')

const parentOf = (path: string): string | null => {
  const at = path.lastIndexOf('/')
  return at > 0 ? path.slice(0, at) : null
}

const weight = (d: FileDecoration): number => d.weight ?? 0

/**
 * Replace everything one source says. An empty map withdraws it.
 *
 * Paths ending in a separator decorate the folder AND everything in it: git reports an untracked
 * directory as one entry, and every file under it is just as untracked.
 */
export function setFileDecorations(source: string, decorations: Record<string, FileDecoration>): void {
  const own = new Map<string, FileDecoration>()
  for (const [path, d] of Object.entries(decorations)) {
    own.set(/[\\/]$/.test(path) ? norm(path) + '/' : norm(path), d)
  }
  if (own.size === 0) sources.delete(source)
  else sources.set(source, own)

  const byPath = new Map<string, FileDecoration>()
  const recursive = new Map<string, FileDecoration>()
  const put = (path: string, d: FileDecoration): void => {
    const known = byPath.get(path)
    if (!known || weight(d) > weight(known)) byPath.set(path, d)
  }
  for (const set of sources.values()) {
    for (const [key, d] of set) {
      const path = key.endsWith('/') ? key.slice(0, -1) : key
      if (key.endsWith('/')) recursive.set(path, d)
      put(path, d)
      // Folders show the colour only; a badge on a folder would claim the folder itself changed.
      const rolled: FileDecoration = { color: d.color, weight: d.weight, tooltip: 'Contains changes' }
      for (let dir = parentOf(path); dir; dir = parentOf(dir)) put(dir, rolled)
    }
  }
  useDecorations.setState({ byPath, recursive })
}

function lookup(s: Decorations, raw: string): FileDecoration | undefined {
  const path = norm(raw)
  const own = s.byPath.get(path)
  if (own) return own
  if (s.recursive.size === 0) return undefined
  for (let dir = parentOf(path); dir; dir = parentOf(dir)) {
    const d = s.recursive.get(dir)
    if (d) return d
  }
  return undefined
}

/** The decoration to draw on this path, or undefined. Re-renders only when the answer changes. */
export function useFileDecoration(path: string): FileDecoration | undefined {
  return useDecorations((s) => lookup(s, path))
}
