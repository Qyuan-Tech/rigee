import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_KEYBINDINGS,
  DEFAULT_PANEL_LAYOUT,
  PERSISTED_STATE_VERSION,
  type PanelLayout,
  type PersistedState,
  type Tab,
  type TabId,
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
  keybindings: { ...DEFAULT_KEYBINDINGS },
  disabledPlugins: []
}

function statePath(): string {
  // macOS  ~/Library/Application Support/rigee/workspaces.json
  // Linux  ~/.config/rigee/workspaces.json
  // Win    %APPDATA%\rigee\workspaces.json
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

  const workspaces = Array.isArray(doc.workspaces) ? (doc.workspaces as Workspace[]) : []
  const keybindings = { ...DEFAULT_KEYBINDINGS, ...((doc.keybindings as Partial<KeyBindings>) ?? {}) }
  let ui =
    doc.ui && typeof doc.ui === 'object' ? (doc.ui as Record<WorkspaceId, WorkspaceUiState>) : {}

  // v1 -> v2: key bindings joined the document. Everything else carries over, so a user's
  // workspaces and layouts survive the upgrade instead of being reset.
  if (version === 1) version = 2

  // v2 -> v3: the centre pane became a ROW of editor groups. A v2 record held one tab list and one
  // active tab, which is precisely one group filling the whole width.
  //
  // This is the first step that transforms data rather than relabelling a number, and it has to be
  // a version rather than a tolerated absence. `groups ?? []` on a v2 record would produce an empty
  // centre pane, and the renderer's 400 ms save debounce would write that emptiness back over the
  // user's real tabs within half a second of boot.
  if (version === 2) {
    ui = Object.fromEntries(Object.entries(ui).map(([id, record]) => [id, toGroups(record)]))
    version = 3
  }

  if (version !== PERSISTED_STATE_VERSION) {
    // A document from the FUTURE — an older build reading what a newer one wrote. Keep the
    // workspaces and the key bindings, which are version-stable and expensive to recreate, and
    // drop only the UI, whose shape is the thing we cannot read. Wiping everything here is how a
    // developer swapping branches against their real userData loses every project they had open.
    return { ...EMPTY, workspaces, activeWorkspaceId: (doc.activeWorkspaceId as WorkspaceId | null) ?? null, keybindings }
  }

  return {
    version: PERSISTED_STATE_VERSION,
    workspaces,
    activeWorkspaceId: (doc.activeWorkspaceId as WorkspaceId | null) ?? null,
    ui,
    keybindings,
    // No version bump for this one: an absent field means "nothing disabled", which is exactly
    // what every document written before the plugins view existed means.
    disabledPlugins: Array.isArray(doc.disabledPlugins) ? (doc.disabledPlugins as string[]) : []
  }
}

/**
 * A v2 UI record as one full-width group.
 *
 * Total by construction: a record with no tabs, or no `tabs` key at all, still yields one empty
 * group, because the shell's invariant is that a workspace always has somewhere to put a tab.
 *
 * `expandedDirs` is copied only when it was there. Manufacturing `[]` would tell the explorer the
 * workspace has been visited and everything in it was deliberately collapsed, so every migrated
 * project would open with its roots shut — see the comment on the field.
 */
const MIGRATED_GROUP_ID = 'g0'

function toGroups(raw: unknown): WorkspaceUiState {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const tabs = Array.isArray(record.tabs) ? (record.tabs as Tab[]) : []
  const activeTabId = typeof record.activeTabId === 'string' ? (record.activeTabId as TabId) : null

  return {
    groups: [{ id: MIGRATED_GROUP_ID, tabs, activeTabId }],
    activeGroupId: MIGRATED_GROUP_ID,
    groupSizes: [1],
    layout: (record.layout as PanelLayout | undefined) ?? { ...DEFAULT_PANEL_LAYOUT },
    ...(Array.isArray(record.expandedDirs) ? { expandedDirs: record.expandedDirs as string[] } : {})
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
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const onDisk = (raw as { version?: number } | null)?.version
    // Keep the old document before the first flush overwrites it in the new shape. Migrations are
    // meant to be total, but "meant to be" is not a recovery plan for somebody's workspaces.
    if (typeof onDisk === 'number' && onDisk !== PERSISTED_STATE_VERSION) {
      try { writeFileSync(`${file}.v${onDisk}`, readFileSync(file)) } catch { /* best effort */ }
    }
    cache = migrate(raw)
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

export function saveDisabledPlugins(disabled: string[]): void {
  const state = loadState()
  state.disabledPlugins = [...new Set(disabled)].sort()
  flush()
}

/** Read without touching disk twice; main needs it before the renderer has said anything. */
export function disabledPlugins(): string[] {
  return loadState().disabledPlugins ?? []
}
