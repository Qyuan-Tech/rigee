import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { PLUGIN_MANIFESTS } from '@plugins/index'
import { CollapseLeftIcon } from '../icons'
import { activatedPlugins, deactivatePlugin } from '../plugins/activate'
import { disabledPlugins, setDisabledPlugins, setDiskPlugins } from '../plugins/registry'
import { onPluginSearch } from '../plugins/market'
import { pluginUiVersion, subscribePluginUi } from '../plugins/signal'
import { rpc } from '../ipc'
import { PERMISSION_LABELS, type PluginContributions } from '@rigee/plugin-api/manifest'
import type { InstalledPluginInfo, MarketPlugin } from '@shared/ipc'
import type { PluginViewProps } from '../plugins/bindings'

/**
 * Newer releases of plugins installed from GitHub, by id — kept beyond the view's own life, so
 * collapsing the panel and opening it again does not forget what the last check found.
 *
 * Checked by itself once per session, the first time the view opens with such a plugin installed,
 * and otherwise only when asked: each check spends one of GitHub's sixty anonymous calls an hour
 * per plugin, and a check on every visit would spend them on a panel being glanced at.
 */
let knownUpdates: ReadonlyMap<string, { version: string; tag: string }> = new Map()
let updatesChecked = false

const BUNDLED_IDS: ReadonlySet<string> = new Set(PLUGIN_MANIFESTS.map((m) => m.id))

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The plugins view: what is installed, what it contributes, what is running, and a switch.
 *
 * The one view the shell owns rather than a plugin, and the reason is bootstrapping: it has to
 * stay reachable when every plugin is off, including itself. Everything else about it is ordinary
 * — the activity bar finds it through the same view contributions, and the host mounts it through
 * the same binding table.
 *
 * Switching a plugin off is not cosmetic. The renderer disposes its fiber, which un-binds every
 * component it contributed; main disposes its own, which stops its watchers and destroys its
 * native views; and the registry stops reporting its contributions, so its icon leaves this very
 * rail and its file types stop resolving. It is the first thing in the app that exercises the
 * unload path the plugin runtime was built around.
 */
export function PluginsView({ onCollapse }: PluginViewProps): React.ReactElement {
  useSyncExternalStore(subscribePluginUi, pluginUiVersion)
  const disabled = disabledPlugins()
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [fromDisk, setFromDisk] = useState<InstalledPluginInfo[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MarketPlugin[] | null>(null)
  const [searching, setSearching] = useState(false)
  /** `owner/repo` of the install in flight. One at a time — main refuses a second anyway. */
  const [installing, setInstalling] = useState<string | null>(null)
  const [updates, setUpdates] = useState(knownUpdates)

  /**
   * The list comes from main, not from the bundled barrel.
   *
   * It has to: main owns the trust file and the hashes, and the plugins on disk are not in any
   * bundle. Re-read whenever this panel mounts, so a plugin dropped into the directory while the
   * app was running appears on the next visit rather than only after a restart.
   */
  const refresh = useCallback(async () => {
    const list = await rpc['plugins:list']()
    setFromDisk(list)
    // Keep the registry in step: approving a plugin has to make its contributions resolve, and
    // withdrawing approval has to make them stop, without a reload.
    setDiskPlugins(
      list.map((p) => ({
        manifest: p.manifest,
        trusted: p.trust.status === 'trusted',
        rendererUrl: p.rendererUrl
      }))
    )
  }, [])

  useEffect(() => {
    void refresh().catch((e: unknown) => setError(errorText(e)))
  }, [refresh])

  const rememberUpdates = useCallback((next: ReadonlyMap<string, { version: string; tag: string }>) => {
    knownUpdates = next
    setUpdates(next)
  }, [])

  const checkUpdates = useCallback(async () => {
    try {
      const { updates: found, problems } = await rpc['plugins:checkUpdates']()
      rememberUpdates(new Map(found.map((u) => [u.id, { version: u.version, tag: u.tag }])))
      setError(problems[0] ?? null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [rememberUpdates])

  useEffect(() => {
    if (updatesChecked || !fromDisk.some((p) => p.source)) return
    updatesChecked = true
    void checkUpdates()
  }, [fromDisk, checkUpdates])

  /**
   * Ask GitHub. On Enter, never per keystroke: anonymous search is ten calls a minute, and a search
   * box that spent one per letter would be out of them before the first word was typed.
   */
  const search = useCallback(async (words: string) => {
    setSearching(true)
    try {
      setResults(await rpc['plugins:search']({ query: words }))
      setError(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSearching(false)
    }
  }, [])

  // A tab whose viewer is missing asks for its plugin by name: "Find a plugin on GitHub".
  useEffect(
    () =>
      onPluginSearch((words) => {
        setQuery(words)
        void search(words)
      }),
    [search]
  )

  /**
   * Install or update. Everything that matters happens in main — download, checks, and the
   * question, in a native dialog this view can neither draw nor answer — so all this does is ask
   * for it and catch up with the outcome.
   */
  const install = useCallback(
    async (owner: string, repo: string) => {
      setInstalling(`${owner}/${repo}`)
      try {
        const result = await rpc['plugins:install']({ owner, repo })
        if (!result.ok) {
          if (!result.cancelled) setError(result.reason)
          return
        }
        setError(null)
        // An update replaces code that may be running. Stopping the old renderer half means the
        // next use imports the new build — whose URL names its own hash — rather than carrying on
        // with the old one for the rest of the session.
        if (result.updated) await deactivatePlugin(result.id)
        const rest = new Map(knownUpdates)
        rest.delete(result.id)
        rememberUpdates(rest)
        await refresh()
      } catch (e) {
        setError(errorText(e))
      } finally {
        setInstalling(null)
      }
    },
    [refresh, rememberUpdates]
  )

  const uninstall = useCallback(
    async (id: string) => {
      try {
        const result = await rpc['plugins:uninstall']({ id })
        if (!result.ok) {
          if (!result.cancelled) setError(result.reason ?? 'could not uninstall')
          return
        }
        setError(null)
        await deactivatePlugin(id)
        await refresh()
      } catch (e) {
        setError(errorText(e))
      }
    },
    [refresh]
  )

  const installedById = useMemo(() => new Map(fromDisk.map((p) => [p.manifest.id, p])), [fromDisk])

  const setTrust = useCallback(
    async (id: string, trusted: boolean) => {
      try {
        const result = await rpc['plugins:setTrust']({ id, trusted })
        if (!result.ok) { setError(result.reason ?? 'could not change trust'); return }
        setError(null)
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [refresh]
  )

  /**
   * Which plugins are actually loaded, polled rather than pushed.
   *
   * Activation happens deep inside a lazy import with no event to hang a subscription on, and the
   * answer only matters while this panel is on screen. A second is imperceptible for a status dot
   * and costs one Set comparison.
   */
  useEffect(() => {
    let live = true
    const read = (): void => {
      void activatedPlugins().then((ids) => { if (live) setRunning(new Set(ids)) })
    }
    read()
    const timer = setInterval(read, 1000)
    return () => { live = false; clearInterval(timer) }
  }, [])

  const toggle = useCallback(
    async (id: string, enable: boolean) => {
      const next = new Set(disabledPlugins())
      if (enable) next.delete(id)
      else next.add(id)

      // The registry first, so the UI reflects the decision on this frame: the icon leaves the
      // rail, the editor stops claiming its files. Then the two halves are actually stopped.
      setDisabledPlugins(next)
      try {
        if (!enable) await deactivatePlugin(id)
        await rpc['state:setDisabledPlugins']({ disabled: [...next] })
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    []
  )

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="section-header">
        <span className="section-header__title">Plugins</span>
        <button className="icon-button" title="Collapse panel" onClick={onCollapse}>
          <CollapseLeftIcon size={14} />
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/*
        Two sources, composed here rather than in main. The bundled manifests are statically
        available on this side and cannot cross the bridge anyway — one of them carries a function
        as its file selector — so main sends only what it alone knows about.
      */}
      <div className="plugins__body">
        <form
          className="plugins__search"
          onSubmit={(e) => {
            e.preventDefault()
            void search(query)
          }}
        >
          <input
            className="plugins__search-input"
            type="search"
            placeholder="Search GitHub for plugins"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>

        {(searching || results) && (
          <div className="plugins__market">
            {/*
              Above the results, always, rather than only in the install dialog. The list is the
              moment someone decides what is worth a look, and it should not read like a store
              somebody curated.
            */}
            <div className="plugins__notice">
              From public GitHub repositories tagged <code>rigee-plugin</code>. Rigee does not review
              them and cannot vouch for their safety.
            </div>
            {searching && <div className="plugins__empty">Searching…</div>}
            {!searching && results?.length === 0 && (
              <div className="plugins__empty">No plugins found.</div>
            )}
            {!searching &&
              results?.map((plugin) => (
                <MarketRow
                  key={`${plugin.owner}/${plugin.repo}`}
                  plugin={plugin}
                  installed={installedById.get(plugin.id) ?? null}
                  busy={installing !== null}
                  installing={installing === `${plugin.owner}/${plugin.repo}`}
                  onInstall={() => void install(plugin.owner, plugin.repo)}
                />
              ))}
          </div>
        )}

        <div className="plugins__section">
          <span>Installed</span>
          {fromDisk.some((p) => p.source) && (
            <button className="plugins__link" onClick={() => void checkUpdates()}>
              check for updates
            </button>
          )}
        </div>
        {PLUGIN_MANIFESTS.map((manifest) => (
          <PluginRow
            key={manifest.id}
            plugin={{ manifest, trust: { status: 'trusted' }, permissions: [], version: manifest.version, rendererUrl: null, source: null }}
            bundled
            enabled={!disabled.has(manifest.id)}
            running={running.has(manifest.id)}
            onToggle={(enable) => void toggle(manifest.id, enable)}
            onSetTrust={() => { /* bundled plugins ship with the app; there is nothing to approve */ }}
          />
        ))}
        {fromDisk.map((plugin) => (
          <PluginRow
            key={plugin.manifest.id}
            plugin={plugin}
            bundled={false}
            enabled={!disabled.has(plugin.manifest.id)}
            running={running.has(plugin.manifest.id)}
            update={updates.get(plugin.manifest.id) ?? null}
            busy={installing !== null}
            onToggle={(enable) => void toggle(plugin.manifest.id, enable)}
            onSetTrust={(trusted) => void setTrust(plugin.manifest.id, trusted)}
            onUpdate={(source) => void install(source.owner, source.repo)}
            onUninstall={() => void uninstall(plugin.manifest.id)}
          />
        ))}
      </div>
    </div>
  )
}

function PluginRow({
  plugin,
  bundled,
  enabled,
  running,
  update = null,
  busy = false,
  onToggle,
  onSetTrust,
  onUpdate,
  onUninstall
}: {
  plugin: InstalledPluginInfo
  bundled: boolean
  enabled: boolean
  running: boolean
  update?: { version: string; tag: string } | null
  busy?: boolean
  onToggle: (enable: boolean) => void
  onSetTrust: (trusted: boolean) => void
  onUpdate?: (source: NonNullable<InstalledPluginInfo['source']>) => void
  onUninstall?: () => void
}): React.ReactElement {
  const { manifest, trust, source } = plugin
  const trusted = trust.status === 'trusted'

  return (
    <div className={`plugins__row${enabled && trusted ? '' : ' plugins__row--off'}`}>
      <div className="plugins__head">
        <span className="plugins__name">{manifest.displayName}</span>
        <span className="plugins__version">{manifest.version}</span>
        {/*
          The on/off switch is only meaningful for a plugin that is allowed to run at all. An
          untrusted one is already stopped, and offering a second control that also says "off"
          would make the two look like alternatives.
        */}
        {trusted && (
          <button
            className={`plugins__toggle${enabled ? ' plugins__toggle--on' : ''}`}
            role="switch"
            aria-checked={enabled}
            title={enabled ? `Disable ${manifest.displayName}` : `Enable ${manifest.displayName}`}
            onClick={() => onToggle(!enabled)}
          >
            <span className="plugins__knob" />
          </button>
        )}
      </div>

      {manifest.description && <div className="plugins__desc">{manifest.description}</div>}

      {source && (
        <a className="plugins__repo" href={`https://github.com/${source.owner}/${source.repo}`} target="_blank" rel="noreferrer">
          from github.com/{source.owner}/{source.repo}
        </a>
      )}

      {source && update && onUpdate && (
        <button className="plugins__install" disabled={busy} onClick={() => onUpdate(source)}>
          Update to {update.version}
        </button>
      )}

      {!bundled && !trusted && <TrustPrompt plugin={plugin} onSetTrust={onSetTrust} />}

      <div className="plugins__meta">
        <span className={`plugins__state${running ? ' plugins__state--on' : ''}`}>
          {!trusted ? 'not trusted' : !enabled ? 'disabled' : running ? 'running' : 'idle'}
        </span>
        {!bundled && <span className="plugins__contribution">installed</span>}
        {summarise(manifest.contributes).map((line) => (
          <span key={line} className="plugins__contribution">{line}</span>
        ))}
        {!bundled && trusted && (
          <button className="plugins__link" onClick={() => onSetTrust(false)}>
            withdraw trust
          </button>
        )}
        {!bundled && onUninstall && (
          <button className="plugins__link" disabled={busy} onClick={onUninstall}>
            uninstall
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * One search result: a repository, which is all a search can know. Its name, version and what it
 * asks for are read from the release itself, after the download, and shown in the dialog that
 * asks — not here, where they would only be what the repository's front page claims.
 */
function MarketRow({
  plugin,
  installed,
  busy,
  installing,
  onInstall
}: {
  plugin: MarketPlugin
  installed: InstalledPluginInfo | null
  busy: boolean
  installing: boolean
  onInstall: () => void
}): React.ReactElement {
  const bundled = BUNDLED_IDS.has(plugin.id)
  const fromHere =
    installed?.source?.owner.toLowerCase() === plugin.owner.toLowerCase() &&
    installed.source.repo === plugin.repo

  let action: React.ReactNode
  if (bundled) {
    action = <span className="plugins__note">Its id belongs to a plugin that ships with Rigee</span>
  } else if (installing) {
    action = <span className="plugins__note">Installing…</span>
  } else if (installed && fromHere) {
    action = <span className="plugins__note">Installed</span>
  } else {
    action = (
      <button className="plugins__install" disabled={busy} onClick={onInstall}>
        {/* Another repository already has this id here. Main says so in the dialog. */}
        {installed ? `Replace ${installed.manifest.displayName}` : 'Install'}
      </button>
    )
  }

  const updated = plugin.updatedAt ? new Date(plugin.updatedAt) : null
  return (
    <div className="plugins__row">
      <div className="plugins__head">
        <span className="plugins__name">{plugin.id}</span>
        {plugin.official && (
          <span className="plugins__badge" title={`Published by ${plugin.owner}, the organisation Rigee is published from`}>
            Rigee
          </span>
        )}
        <span className="plugins__stars" title="GitHub stars">★ {plugin.stars}</span>
      </div>
      <a className="plugins__repo" href={plugin.url} target="_blank" rel="noreferrer">
        {plugin.owner}/{plugin.repo}
      </a>
      {plugin.description && <div className="plugins__desc">{plugin.description}</div>}
      <div className="plugins__meta">
        <span className="plugins__contribution">
          {[
            updated && !Number.isNaN(updated.getTime()) ? `updated ${updated.toLocaleDateString()}` : null,
            plugin.license
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      {action}
    </div>
  )
}

/**
 * The question asked before a plugin from outside this app is allowed to run.
 *
 * WORDED THE WAY IT IS ON PURPOSE. It does not say the plugin is limited to what it lists, because
 * it is not: a plugin runs in the same process as the shell, and nothing here confines it. Saying
 * "this plugin may read files" would imply a boundary that does not exist, and a user who believes
 * in a boundary approves things they would otherwise look at. So the headline is the true statement
 * — this code runs with Rigee's own access — and the declared list is offered underneath as what
 * the author says it is for.
 *
 * The three non-trusted states ask different questions, which is why they are not one "untrusted".
 * "Something rewrote this since you approved it" deserves more alarm than "you have not seen this
 * before", and a version that has grown an appetite deserves to name what it added.
 */
function TrustPrompt({
  plugin,
  onSetTrust
}: {
  plugin: InstalledPluginInfo
  onSetTrust: (trusted: boolean) => void
}): React.ReactElement {
  const { trust, permissions, manifest } = plugin

  const headline =
    trust.status === 'changed'
      ? `This plugin has changed since you approved version ${trust.approvedVersion}.`
      : trust.status === 'needs-permissions'
        ? `This version declares something the last one did not: ${trust.added
            .map((p) => PERMISSION_LABELS[p].toLowerCase())
            .join(', ')}.`
        : 'This plugin did not come with Rigee.'

  return (
    <div className="plugins__trust">
      <div className="plugins__trust-headline">{headline}</div>
      <div className="plugins__trust-body">
        Running it gives its code the same access Rigee has — your files, your terminals, the
        network. Rigee does not restrict it. Only approve plugins from somewhere you trust.
      </div>
      {permissions.length > 0 && (
        <ul className="plugins__trust-perms">
          {permissions.map((p) => (
            <li key={p}>{PERMISSION_LABELS[p]}</li>
          ))}
          <li className="plugins__trust-caveat">…according to its author. Not enforced.</li>
        </ul>
      )}
      <button className="plugins__trust-approve" onClick={() => onSetTrust(true)}>
        Run {manifest.displayName}
      </button>
    </div>
  )
}

/**
 * What a plugin adds, in one line per contribution point.
 *
 * Shown because it is the honest answer to "what happens if I turn this off" — a list of view
 * types is more use than a description somebody wrote once.
 */
function summarise(contributes: PluginContributions | undefined): string[] {
  if (!contributes) return []
  const out: string[] = []
  const editors = contributes.editors?.map((c) => c.viewType) ?? []
  const tabs = contributes.tabs?.map((c) => c.viewType) ?? []
  const views = contributes.views?.map((c) => c.id) ?? []
  const status = contributes.statusBar?.map((c) => c.id) ?? []
  const overlays = contributes.overlays?.map((c) => c.id) ?? []

  if (editors.length) out.push(`editors: ${editors.join(', ')}`)
  if (tabs.length) out.push(`tabs: ${tabs.join(', ')}`)
  if (views.length) out.push(`views: ${views.join(', ')}`)
  if (status.length) out.push(`status bar: ${status.join(', ')}`)
  if (overlays.length) out.push(`overlays: ${overlays.join(', ')}`)
  return out
}
