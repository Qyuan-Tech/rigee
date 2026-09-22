import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { PLUGIN_MANIFESTS } from '@plugins/index'
import { CollapseLeftIcon } from '../icons'
import { activatedPlugins, deactivatePlugin } from '../plugins/activate'
import { disabledPlugins, setDisabledPlugins } from '../plugins/registry'
import { pluginUiVersion, subscribePluginUi } from '../plugins/signal'
import { rpc } from '../ipc'
import type { PluginContributions, PluginManifest } from '@shared/plugin'
import type { PluginViewProps } from '../plugins/bindings'

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

      <div className="plugins__body">
        {PLUGIN_MANIFESTS.map((manifest) => (
          <PluginRow
            key={manifest.id}
            manifest={manifest}
            enabled={!disabled.has(manifest.id)}
            running={running.has(manifest.id)}
            onToggle={(enable) => void toggle(manifest.id, enable)}
          />
        ))}
      </div>
    </div>
  )
}

function PluginRow({
  manifest,
  enabled,
  running,
  onToggle
}: {
  manifest: PluginManifest
  enabled: boolean
  running: boolean
  onToggle: (enable: boolean) => void
}): React.ReactElement {
  return (
    <div className={`plugins__row${enabled ? '' : ' plugins__row--off'}`}>
      <div className="plugins__head">
        <span className="plugins__name">{manifest.displayName}</span>
        <span className="plugins__version">{manifest.version}</span>
        <button
          className={`plugins__toggle${enabled ? ' plugins__toggle--on' : ''}`}
          role="switch"
          aria-checked={enabled}
          title={enabled ? `Disable ${manifest.displayName}` : `Enable ${manifest.displayName}`}
          onClick={() => onToggle(!enabled)}
        >
          <span className="plugins__knob" />
        </button>
      </div>

      {manifest.description && <div className="plugins__desc">{manifest.description}</div>}

      <div className="plugins__meta">
        <span className={`plugins__state${running ? ' plugins__state--on' : ''}`}>
          {!enabled ? 'disabled' : running ? 'running' : 'idle'}
        </span>
        {summarise(manifest.contributes).map((line) => (
          <span key={line} className="plugins__contribution">{line}</span>
        ))}
      </div>
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
