/**
 * The plugin contract, shared by main / preload / renderer.
 *
 * onestop's core is a shell: a window, workspaces, a tab framework, terminals, persistence and the
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
  | 'diff'
  | 'globe'
  | 'terminal'
  | 'branch'
  | 'folder'

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
   * Whether this tab is a document for the bulk-close commands ("Close Other Files").
   *
   * A diff is; a browser tab is not, for the same reason a terminal is not — closing it throws
   * away navigation state the user did not ask to lose.
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
   * Offer a button in the tab strip that opens a new one of these.
   *
   * The label is declarative, so the button exists before the plugin does; pressing it activates
   * the plugin and asks the factory it bound for the new tab's title and initial state. That
   * ordering is why the factory cannot live here: only the plugin knows what an empty browser tab
   * is, and the whole point is not to have loaded it yet.
   */
  creatable?: { label: string }
}

/** A panel in one of the two side bars. */
export interface ViewContribution {
  /** `<pluginId>.<name>`, like a view type: the same namespace rule, the same reason. */
  id: ViewType
  title: string
  slot: 'left' | 'right'
  /** Lower sorts first within a slot. */
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
 * What the host reads at boot.
 *
 * Shaped so it can move into a plugin's `package.json` unchanged once plugins load from disk
 * rather than from the bundled barrel — `id`/`version`/`displayName`/`contributes` are the same
 * four fields VS Code reads, for the same reason.
 */
export interface PluginManifest {
  id: PluginId
  version: string
  displayName: string
  description?: string
  contributes?: PluginContributions
}

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
