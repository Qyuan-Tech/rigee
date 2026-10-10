/**
 * The plugin contract, shared by main / preload / renderer.
 *
 * Rigee's core is a shell: a window, workspaces, a tab framework, terminals, persistence and the
 * IPC spine. Everything that shows a document or a panel — the text editor, source control, the
 * browser, the PDF viewer — is a plugin. This file is the contract they are written against.
 *
 * A plugin is not one object but up to two halves. Electron leaves no choice: a PDF renders in the
 * sandboxed renderer, and the bytes it renders can only be read in main. So a plugin declares a
 * `main` half and a `renderer` half, sharing an id and talking over one IPC channel.
 *
 * THREE RULES THAT SHAPE EVERYTHING HERE
 *
 * 1. This file holds the declarative part only — the shape read at boot to decide *what exists*.
 *    Knowing that some plugin claims `*.pdf` must not cost the 437 kB of pdf.js that renders one.
 *    The imperative halves load on demand, through the per-realm registries.
 *
 * 2. A manifest carries NO import thunks. They used to live here, and they cannot: TypeScript
 *    resolves the literal specifier of a dynamic `import()` into the program, so one manifest
 *    naming both halves drags the main half (node:fs) into the web project and the renderer half
 *    (.tsx) into the node project. Both fail `tsc -b`. The thunks live in `registry.main.ts` and
 *    `registry.renderer.ts`, each covered by exactly one tsconfig.
 *
 * 3. Contributions name components; they never hold them. cordis service access is between 700x
 *    and 2000x the cost of a plain property read (measured: 15.5 us for `ctx.svc.method()` against
 *    8 ns), so the framework stays on the activation path and every render-path lookup goes
 *    through the plain Maps in the renderer's `bindings.ts`.
 *
 * This file is the root of `@rigee/plugin-api`, which is the version the two sides agree on. It
 * must stay free of runtime imports: it is read at boot in main AND in the renderer, and anything
 * it reaches lands in both bundles.
 */

/** Stable identity of a plugin. Namespaces its commands, its view types and its events. */
export type PluginId = string

/**
 * A view type is a `<pluginId>.<name>` pair, e.g. `pdf.preview`.
 *
 * Dotted rather than colon-separated so it stays distinguishable at a glance from an IPC channel
 * (`fs:readFile`) and from a command (`pdf:read`) in a stack trace or a log line.
 */
export type ViewType = string

/**
 * Icons a contribution may ask for, by name.
 *
 * A name rather than a component, because a manifest is read at boot in both realms and must stay
 * plain data — a React element here would put the whole icon module, and with it a value import of
 * React, into the main process. The names map to `src/renderer/src/icons.tsx`.
 */
export type IconName =
  | 'file'
  | 'files'
  | 'diff'
  | 'globe'
  | 'terminal'
  | 'branch'
  | 'folder'
  | 'plugin'
  | 'search'
  | 'image'
  | 'video'

/**
 * A file matcher, in the only two forms worth supporting before someone asks for a third:
 * an extension list, or a predicate on the absolute path.
 *
 * Deliberately not a glob. A glob library is 20 kB to express `*.pdf`, and the moment one appears
 * in a manifest people start writing `**\/node_modules/**` in it and expecting gitignore
 * semantics.
 */
export type FileSelector =
  /** Lower-case, no leading dot: `['pdf']`. Matched against the path's final extension. */
  | { extensions: string[] }
  | { match: (absolutePath: string) => boolean }

/** One editor a plugin contributes. Declared in the manifest, bound when the plugin activates. */
export interface EditorContribution {
  viewType: ViewType
  /** Shown in the "Open with" affordance and in the tab's tooltip. */
  displayName: string
  selector: FileSelector
  icon?: IconName
  /**
   * Higher wins when several editors claim the same file; ties break on manifest order.
   *
   * The text editor contributes at -Infinity and claims everything, so it is the floor: any other
   * editor beats it, and a file nothing else claims still opens.
   */
  priority?: number
}

/**
 * A tab type a plugin owns end to end — a browser tab, a diff.
 *
 * Distinct from an editor, which is "a viewer for a file the shell opened". A custom tab carries
 * its own state and the shell knows nothing about it beyond what is declared here.
 */
export interface TabContribution {
  viewType: ViewType
  displayName: string
  icon?: IconName
  /**
   * Whether this tab shows a document — a diff does, a browser tab does not — which is how the
   * tab strip tells files from everything else.
   *
   * It used to decide what the bulk-close commands reached. They reach every tab now, as in VS
   * Code, and a program a sweep would stop is asked about instead.
   */
  isDocument?: boolean
  /**
   * A tab kind from a persisted state older than the plugin system, to be rewritten into this
   * view type on load.
   *
   * Migration lives in the manifest rather than in the shell so the shell keeps no list of the
   * features it used to own. `sanitizeTabs` reads this; it is pure data and costs one scan.
   */
  legacyKind?: string
  /**
   * What the split button does to a tab of this type: put a copy in the new group, or move it.
   *
   * Defaults to 'move', which is the safe answer — a plugin that has not thought about being in two
   * places at once probably cannot be. A browser tab cannot: its native view is keyed by tab id, so
   * a copy would either share the view or quietly start a second page with no session. A diff can,
   * and should, because reading two revisions of the same file side by side is the point.
   *
   * The shell reads this from the manifest alone, so pressing split does not activate the plugin
   * just to ask it.
   */
  split?: 'copy' | 'move'
  /**
   * Offer a button in the tab strip that opens a new one of these.
   *
   * The label is declarative, so the button exists before the plugin does; pressing it activates
   * the plugin and asks the factory it bound for the new tab's title and initial state. That
   * ordering is why the factory cannot live here: only the plugin knows what an empty browser tab
   * is, and the whole point is not to have loaded it yet.
   */
  creatable?: { label: string }
}

/**
 * A panel in one of the two side bars.
 *
 * The left slot is an activity bar: one icon per view, one view visible at a time, the way VS Code
 * arranges it. The right slot stacks whatever is contributed to it — source control lives there so
 * the file tree and the changes stay visible together, which is the one thing this layout does
 * better than VS Code's.
 */
export interface ViewContribution {
  /** `<pluginId>.<name>`, like a view type: the same namespace rule, the same reason. */
  id: ViewType
  title: string
  slot: 'left' | 'right'
  /**
   * The activity bar button. Required, not optional: a left-slot view with no icon would be a
   * button nobody can identify, and an icon invented by the shell on its behalf would be worse.
   */
  icon: IconName
  /** Lower sorts first within a slot, and top to bottom in the activity bar. */
  order?: number
}

/** An item in the status bar. */
export interface StatusBarContribution {
  id: ViewType
  align: 'left' | 'right'
  order?: number
}

/**
 * A component mounted at the shell root while the plugin is active — a modal, a prompt.
 *
 * Mounted on activation rather than at boot, which is what keeps this honest: the browser plugin's
 * HTTP auth dialog cannot be needed before a browser view exists, and by then the plugin that owns
 * the view is already loaded.
 */
export interface OverlayContribution {
  id: ViewType
}

export interface PluginContributions {
  editors?: EditorContribution[]
  tabs?: TabContribution[]
  views?: ViewContribution[]
  statusBar?: StatusBarContribution[]
  overlays?: OverlayContribution[]
}

/**
 * A capability a plugin must ASK FOR before the shell will give it.
 *
 * Deliberately coarse, and deliberately short. A long list of fine-grained permissions reads well
 * in a design document and is worthless in a dialog: nobody can weigh nine checkboxes, so everyone
 * presses yes, and the nine were only ever a way of not deciding which three mattered. These four
 * are the ones a reviewer can actually reason about.
 *
 * BE CLEAR ABOUT WHAT THESE DO, BECAUSE IT IS NOT WHAT THE WORD "PERMISSION" SUGGESTS. Nothing
 * enforces them at the call site, and nothing can in this architecture: a main half is an ES module
 * in the main process and imports `node:fs` itself, and a renderer half runs in the shell's own
 * JavaScript context and can reach `window.rigee` directly. A declaration is a statement of intent,
 * not a capability the shell hands over and can withhold.
 *
 * What they are actually for is CHANGE DETECTION, and that part is enforced. The set is recorded
 * with the trust grant, so a plugin that asked only to read files and comes back next version
 * wanting to run programs cannot be silently loaded — approval is withdrawn and the user is asked
 * again. Nobody re-reads a plugin they already trusted; this is the moment they would.
 *
 * Real enforcement needs a separate context per plugin — a worker for the logic, a locked-down
 * frame for the UI, every contribution point becoming a message — which is a much larger change
 * and is not pretended at here. Installing a plugin runs its code with the application's
 * privileges, and Rigee's install dialog says exactly that.
 */
export type PluginPermission =
  /** Read files anywhere the user can. Any viewer needs this. */
  | 'files:read'
  /** Write files. The text editor needs it; a reader does not. */
  | 'files:write'
  /** Run programs. Source control needs it to run `git`; almost nothing else should. */
  | 'process:spawn'
  /** Reach the network, directly or by showing a remote page. */
  | 'net'

export const ALL_PERMISSIONS: readonly PluginPermission[] = [
  'files:read',
  'files:write',
  'process:spawn',
  'net'
]

/** One line each, for the install dialog. The user reads these, not the identifiers. */
export const PERMISSION_LABELS: Record<PluginPermission, string> = {
  'files:read': 'Read files on this computer',
  'files:write': 'Create and change files on this computer',
  'process:spawn': 'Run other programs',
  net: 'Send and receive data over the network'
}

/**
 * What the host reads at boot.
 *
 * Shaped so it can move into a plugin's `package.json` unchanged once plugins load from disk
 * rather than from the bundled barrel — `id`/`version`/`displayName`/`contributes` are the same
 * four fields VS Code reads, for the same reason. A plugin on disk supplies exactly this object
 * under a `rigee` key, plus the two entry points (see `DiskPluginManifest`).
 */
export interface PluginManifest {
  id: PluginId
  version: string
  displayName: string
  description?: string
  /**
   * What it needs to be allowed to do. Absent means none, and a plugin that asks for nothing is
   * installable without a prompt beyond "this code will run inside rigee".
   */
  permissions?: PluginPermission[]
  contributes?: PluginContributions
}

/**
 * The extra fields a plugin loaded FROM DISK carries, on top of the manifest itself.
 *
 * Bundled plugins do not need them: their halves are reached through `registry.main.ts` and
 * `registry.renderer.ts`, which the build resolves statically. A plugin from somebody else's
 * repository has no such entry, so it names its own files — relative to its own directory, and
 * checked for containment before anything is read.
 */
export interface DiskPluginManifest extends PluginManifest {
  /** ESM entry for the main half, relative to the plugin directory. Omit if it has none. */
  main?: string
  /** ESM entry for the renderer half, relative to the plugin directory. Omit if it has none. */
  renderer?: string
  /**
   * Major version of `@rigee/plugin-api` this was built against.
   *
   * Checked before anything is loaded. A plugin built against a contract the shell no longer
   * speaks must be refused with that as the reason, not allowed to fail later as a missing export
   * in a stack trace nobody can act on.
   */
  apiVersion: number
}

/**
 * The API generation the shell implements.
 *
 * Bumped when something is REMOVED or changed shape — adding a function does not break a plugin
 * that never calls it. A disk plugin whose `apiVersion` differs is refused at discovery.
 */
export const PLUGIN_API_VERSION = 1

// ---------------------------------------------------------------------------
// The two IPC channels
// ---------------------------------------------------------------------------

/**
 * Every renderer→main plugin call rides one channel, `plugin:invoke`.
 *
 * The alternative was to let plugins add entries to `REQUEST_CHANNELS`, which would mean the
 * preload allowlist is no longer a literal — it would have to be assembled at runtime from
 * whatever main happens to have loaded, and a static allowlist that is actually static is worth
 * more than the ergonomics of a per-plugin channel name. So the allowlist grows by exactly two
 * entries, once, and never again.
 *
 * Authorisation lives in main: `plugin:invoke` reaches the command registry, and a command that
 * was never registered is rejected there. Registration is where the namespace rule is enforced —
 * a plugin may only register commands prefixed with its own id, so one plugin cannot shadow
 * another's.
 */
export interface PluginInvocation {
  /** `<pluginId>:<verb>`, e.g. `pdf:read`. */
  command: string
  payload: unknown
}

/**
 * The other direction: main→renderer push, also on one channel.
 *
 * Plugins need this for anything they do not own the timing of — a git status arriving because a
 * watcher fired, a page finishing its navigation. The envelope carries the plugin id so the
 * renderer can hand the payload to that plugin's listeners without every plugin seeing every
 * other plugin's events.
 */
export interface PluginEventEnvelope {
  pluginId: PluginId
  /** Plugin-local name, NOT prefixed: `status`, not `scm:status`. */
  event: string
  payload: unknown
}

/** Prefix a command must carry to be registerable by `id`. */
export function commandNamespace(id: PluginId): string {
  return `${id}:`
}

/** Prefix a view type, tab type, view or status bar item must carry to belong to `id`. */
export function viewNamespace(id: PluginId): string {
  return `${id}.`
}

export function matchesSelector(selector: FileSelector, absolutePath: string): boolean {
  if ('match' in selector) return selector.match(absolutePath)
  const dot = absolutePath.lastIndexOf('.')
  const slash = Math.max(absolutePath.lastIndexOf('/'), absolutePath.lastIndexOf('\\'))
  if (dot < 0 || dot < slash) return false
  const ext = absolutePath.slice(dot + 1).toLowerCase()
  return selector.extensions.some((e) => e.toLowerCase() === ext)
}
