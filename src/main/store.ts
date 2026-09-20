import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_KEYBINDINGS,
  PERSISTED_STATE_VERSION,
  type PersistedState,
  type Workspace,
  type WorkspaceId,
  type WorkspaceUiState,
  type KeyBindings
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
  ui: {},
  keybindings: { ...DEFAULT_KEYBINDINGS }
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
  // Deliberately NOT typed as Partial<PersistedState>: that narrows `version` to the current
  // literal and makes comparing against older versions a type error, which is precisely the
  // comparison a migration has to make.
  const doc = raw as Record<string, unknown> & { version?: number }

  let version = typeof doc.version === 'number' ? doc.version : 0
  if (version === 0) return { ...EMPTY }

  // v1 -> v2: key bindings joined the document. Everything else carries over, so a user's
  // workspaces and layouts survive the upgrade instead of being reset.
  if (version === 1) version = 2

  if (version !== PERSISTED_STATE_VERSION) return { ...EMPTY }

  return {
    version: PERSISTED_STATE_VERSION,
    workspaces: Array.isArray(doc.workspaces) ? (doc.workspaces as Workspace[]) : [],
    activeWorkspaceId: (doc.activeWorkspaceId as WorkspaceId | null) ?? null,
    ui:
      doc.ui && typeof doc.ui === 'object'
        ? (doc.ui as Record<WorkspaceId, WorkspaceUiState>)
        : {},
    keybindings: { ...DEFAULT_KEYBINDINGS, ...((doc.keybindings as Partial<KeyBindings>) ?? {}) }
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
  // Deliberately does NOT prune `ui`. It used to, and it silently destroyed the Scratch
  // workspace's tabs on every save: Scratch is synthesised rather than persisted, so it is
  // absent from this list by design, and pruning "workspaces not in the list" deleted the UI
  // that saveAllUi had just written. Pruning belongs to saveAllUi, which sees every live
  // workspace including the synthetic ones.
  flush()
}

export function saveUi(workspaceId: WorkspaceId, ui: WorkspaceUiState): void {
  const state = loadState()
  state.ui[workspaceId] = ui
  flush()
}

/**
 * Persist every workspace's UI at once. AUTHORITATIVE: the map replaces what is on disk, which is
 * also what keeps the document from growing forever as workspaces come and go.
 *
 * Saving only the active workspace loses the others: switching away changes activeWorkspaceId,
 * so the subscription that fires next writes the NEW workspace and the one just left behind
 * never reaches disk.
 */
export function saveAllUi(ui: Record<WorkspaceId, WorkspaceUiState>): void {
  const state = loadState()
  state.ui = { ...ui }
  flush()
}

export function saveKeybindings(keybindings: KeyBindings): void {
  const state = loadState()
  state.keybindings = keybindings
  flush()
}
