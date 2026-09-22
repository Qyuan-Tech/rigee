import { useSyncExternalStore } from 'react'
import { ICONS } from '../icons'
import { pluginUiVersion, subscribePluginUi } from '../plugins/signal'
import { viewsIn } from '../plugins/registry'
import { useApp } from '../store'

/**
 * The rail of icons down the left edge: one per view contributed to the left slot, one visible at
 * a time.
 *
 * Every button comes from a manifest, so the bar is built before a single plugin has loaded — the
 * explorer's icon is there on the first frame, and pressing it is what fetches the explorer. That
 * is the same declarative/imperative split the rest of the plugin system runs on, and it is why
 * this component has no idea what any of these views are.
 *
 * Clicking the selected icon collapses the panel, and clicking any icon while collapsed reopens
 * it. VS Code behaves the same way, and it is the only gesture that makes a rail of toggles feel
 * like toggles.
 */
export function ActivityBar(): React.ReactElement | null {
  useSyncExternalStore(subscribePluginUi, pluginUiVersion)
  const views = viewsIn('left')

  const layout = useApp((s) => s.layout)
  const setLayout = useApp((s) => s.setLayout)
  const selected = selectedLeftView(views.map((v) => v.id), layout.leftView)

  if (views.length === 0) return null

  return (
    <div className="activitybar">
      {views.map((view) => {
        const Icon = ICONS[view.icon]
        const active = view.id === selected && !layout.leftCollapsed
        return (
          <button
            key={view.id}
            className={`activitybar__item${active ? ' activitybar__item--active' : ''}`}
            title={view.title}
            aria-label={view.title}
            aria-pressed={active}
            onClick={() => {
              if (active) { setLayout({ leftCollapsed: true }); return }
              setLayout({ leftView: view.id, leftCollapsed: false })
            }}
          >
            <Icon size={18} />
          </button>
        )
      })}
    </div>
  )
}

/**
 * Which left view is showing, given what the layout remembers and what actually exists.
 *
 * The remembered id can name a view that is gone — its plugin disabled, or uninstalled between
 * launches — and a rail with nothing selected showing an empty panel is a worse answer than
 * falling back to the first icon. Exported because the panel has to agree with the bar about this,
 * and two copies of the rule would eventually disagree.
 */
export function selectedLeftView(available: string[], remembered: string | null | undefined): string | null {
  if (remembered && available.includes(remembered)) return remembered
  return available[0] ?? null
}
