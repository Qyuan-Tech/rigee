/**
 * The shell's data types that appear on the plugin boundary.
 *
 * Moved here from the shell's own `types.ts` rather than copied, and the direction is the point: a
 * plugin compiled against this package must be looking at the SAME `TabId` and `ViewBounds` the
 * shell hands it, or the two agree only by coincidence and drift the first time either side edits
 * a field. `src/shared/types.ts` re-exports these, so the shell still reads as if they were local.
 *
 * Only what actually crosses the boundary lives here. The tab union, the group row and the
 * persisted document stay in the shell: a plugin receives its own state and its own tab id, never
 * the shape the shell keeps them in, and publishing those would freeze the shell's internals into
 * a contract nobody asked for.
 */

export type WorkspaceId = string
export type RepoId = string
export type TabId = string

/** One root folder inside a workspace. A workspace may hold several, VSCode-style. */
export interface WorkspaceFolder {
  /** Absolute path. */
  path: string
  /** Display name; defaults to basename(path) but the user may rename it. */
  name: string
  /** Whether `path` is (or is inside) a git work tree. Resolved at add time and on refresh. */
  isGitRepo: boolean
  /**
   * Absolute path to the repository root, when `isGitRepo`. May differ from `path` if the user
   * added a subdirectory of a repo. This, not `path`, is the identity of a repo.
   */
  repoRoot: string | null
}

export interface Workspace {
  id: WorkspaceId
  name: string
  folders: WorkspaceFolder[]
  createdAt: number
  lastOpenedAt: number
  /** Where terminals start when the workspace has no folders. Only set for Scratch. */
  defaultCwd?: string
  /**
   * The `.code-workspace` file this workspace was opened from, when it came from one.
   *
   * Absent for a workspace that is just a folder — which is the majority, and is exactly VS Code's
   * distinction between a folder and a saved multi-root workspace. Its presence is what makes
   * "Save Workspace As" an overwrite rather than a new file.
   */
  filePath?: string | null
}

/** One entry in a directory listing. */
export interface FileStat {
  path: string
  name: string
  isDir: boolean
  /** True when a .gitignore in scope excludes this entry; the tree dims it. */
  ignored: boolean
}

/** Bounds of a DOM placeholder, in CSS pixels relative to the window's content area. */
export interface ViewBounds {
  x: number
  y: number
  width: number
  height: number
}
