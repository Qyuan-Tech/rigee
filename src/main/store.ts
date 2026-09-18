import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PERSISTED_STATE_VERSION,
  type PersistedState,
  type Workspace,
  type WorkspaceId,
  type WorkspaceUiState
} from '@shared/types'

/**
 * Persistence for workspaces and per-workspace UI state.
 *
 * JSON, not sqlite: the whole document is a few KB, it is read once at boot and written on
 * coarse user actions, and being able to hand-edit or diff it is worth more here than query
 * ability. Revisit only if we start persisting per-file state for large repos.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot leave a truncated document
 * that loses every workspace the user has.
 */

const EMPTY: PersistedState = {
  version: PERSISTED_STATE_VERSION,
  workspaces: [],
  activeWorkspaceId: null,
  ui: {}
}

function statePath(): string {
  // macOS  ~/Library/Application Support/onestop/workspaces.json
  // Linux  ~/.config/onestop/workspaces.json
  // Win    %APPDATA%\onestop\workspaces.json
  return join(app.getPath('userData'), 'workspaces.json')
}

function writeAtomic(file: string, contents: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, contents, { encoding: 'utf8' })
    renameSync(tmp, file)
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* best effort */ }
    throw err
  }
}

/**
 * Bring an older document up to the current version. Each step is deliberately one-way and
 * total: given any vN document it must produce a valid vN+1 document.
 */
function migrate(raw: unknown): PersistedState {
  if (raw === null || typeof raw !== 'object') return { ...EMPTY }
  const doc = raw as Partial<PersistedState> & { version?: number }

  if (typeof doc.version !== 'number') return { ...EMPTY }
  // if (doc.version === 1) { ...produce v2...; doc.version = 2 }

  if (doc.version !== PERSISTED_STATE_VERSION) return { ...EMPTY }

  return {
    version: PERSISTED_STATE_VERSION,
    workspaces: Array.isArray(doc.workspaces) ? doc.workspaces : [],
    activeWorkspaceId: doc.activeWorkspaceId ?? null,
    ui: doc.ui && typeof doc.ui === 'object' ? doc.ui : {}
  }
}

let cache: PersistedState | null = null

export function loadState(): PersistedState {
  if (cache) return cache
  const file = statePath()
  if (!existsSync(file)) {
    cache = { ...EMPTY }
    return cache
  }
  try {
    cache = migrate(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    // A corrupt document must not brick startup. Keep the bad file for forensics and start clean.
    try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch { /* best effort */ }
    cache = { ...EMPTY }
  }
  return cache
}

function flush(): void {
  if (cache) writeAtomic(statePath(), JSON.stringify(cache, null, 2))
}

export function saveWorkspaces(workspaces: Workspace[], activeWorkspaceId: WorkspaceId | null): void {
  const state = loadState()
  state.workspaces = workspaces
  state.activeWorkspaceId = activeWorkspaceId
  // Drop UI state for workspaces that no longer exist so the document cannot grow forever.
  const live = new Set(workspaces.map((w) => w.id))
  for (const id of Object.keys(state.ui)) if (!live.has(id)) delete state.ui[id]
  flush()
}

export function saveUi(workspaceId: WorkspaceId, ui: WorkspaceUiState): void {
  const state = loadState()
  state.ui[workspaceId] = ui
  flush()
}
