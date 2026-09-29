/**
 * The shape of a workspace search, shared by the two halves. Realm-free: no DOM, no node:.
 *
 * Positions are in the renderer's units, not the engine's. ripgrep reports byte offsets into
 * UTF-8, and a line of Chinese is three bytes a character — hand those to Monaco and every
 * highlight lands a long way to the right of the word it is supposed to be under. So columns here
 * are 1-based UTF-16 code units, which is what Monaco and the DOM both count in.
 */

export interface SearchQuery {
  /** Absolute paths of the folders to search: the workspace's folders. */
  roots: string[]
  /** What the user typed. Never empty — an empty query is not sent. */
  pattern: string
  caseSensitive: boolean
  wholeWord: boolean
  /** A regular expression rather than literal text. */
  regex: boolean
  /** Stop after this many matches. Defaults to MAX_RESULTS. */
  maxResults?: number
}

export const MAX_RESULTS = 5000

export interface SearchMatch {
  /** 1-based. */
  line: number
  /** 1-based, UTF-16 code units, like Monaco. */
  column: number
  /** UTF-16 code units. */
  length: number
  /** The matching line, cut down to a readable window around the match when it is long. */
  preview: string
  /** Where the match starts inside `preview`, 0-based. */
  previewColumn: number
}

export interface SearchFileResult {
  /** Absolute. */
  path: string
  /** The root it was found under, so the panel can show a path relative to it. */
  root: string
  matches: SearchMatch[]
}

export interface SearchResult {
  files: SearchFileResult[]
  matchCount: number
  /** Stopped at `maxResults`; there are more. */
  truncated: boolean
  /** Which engine answered, for the panel's footer and for bug reports. */
  engine: 'ripgrep' | 'git' | 'node'
  elapsedMs: number
  /** A regex that does not compile, a folder that cannot be read. The rest still comes back. */
  error?: string
}
