import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { CollapseRightIcon } from '../icons'
import { ensurePlugin } from '../plugins/activate'
import {
  boundOverlays,
  editorComponent,
  statusItemComponent,
  tabComponent,
  viewComponent
} from '../plugins/bindings'
import { pluginUiVersion, subscribePluginUi } from '../plugins/signal'
import {
  fallbackViewType,
  ownerOf,
  resolveViewType,
  SHELL_OWNER,
  statusItemsIn,
  viewsIn
} from '../plugins/registry'
import { selectedLeftView } from './ActivityBar'
import { allTabs } from '../groups'
import { rowOf, useApp } from '../store'
import { Notice } from './Notice'
import type { CustomTab, EditorTab } from '@shared/types'

/**
 * Where the shell meets its plugins.
 *
 * Every component here does the same three things: work out which plugin owns the thing it has to
 * show, make sure that plugin is running, and render whatever it bound — or say plainly that
 * there is nothing to render. None of them import cordis: activation goes through the dynamic
 * `ensurePlugin`, and the components come out of the plain Maps in `bindings.ts`.
 */

/** Re-render when a plugin binds, unbinds, or is enabled or disabled. Rare by construction. */
function useBindings(): number {
  return useSyncExternalStore(subscribePluginUi, pluginUiVersion)
}

/**
 * Start the plugin that owns `id`, reporting failure rather than hanging.
 *
 * `cancelled` matters even though nothing is cleaned up on unmount: StrictMode double-invokes
 * this effect, and setting state from the first run's rejection after the second has mounted is
 * exactly the warning React exists to produce.
 */
function useActivation(id: string | null): string | null {
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    if (!id) return
    const owner = ownerOf(id)
    // The shell's own views are already here; there is nothing to load and no plugin to name.
    if (!owner || owner === SHELL_OWNER) return
    let cancelled = false
    ensurePlugin(owner).catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e))
    })
    return () => { cancelled = true }
  }, [id])

  return error
}

/**
 * A file, shown by the editor that claimed it.
 *
 * The view type is taken from the tab when it has one — resolved once, when the tab was created —
 * and resolved from the path only for tabs persisted before that field existed.
 */
export function PluginEditorPane({ tab }: { tab: EditorTab }): React.ReactElement {
  const viewType = tab.viewType ?? resolveViewType(tab.filePath)
  const error = useActivation(viewType)
  useBindings()

  const workspaceId = useApp((s) => s.activeWorkspaceId)
  const updateTab = useApp((s) => s.updateTab)
  const openAsText = useCallback(() => {
    const fallback = fallbackViewType(tab.filePath)
    if (workspaceId && fallback) updateTab(workspaceId, tab.id, { viewType: fallback })
  }, [tab.filePath, tab.id, updateTab, workspaceId])

  if (!viewType || !ownerOf(viewType)) {
    // A tab naming a viewer that no longer exists. Falling through to the text editor would be
    // worse than saying so: a PDF read as UTF-8 is a screen of replacement characters.
    return (
      <Notice>
        <div>
          No viewer for {viewType ? <code>{viewType}</code> : 'this file'}.
          <div style={{ marginTop: 10 }}>
            <button className="btn" onClick={openAsText}>Open as text</button>
          </div>
        </div>
      </Notice>
    )
  }
  if (error) return <Notice tone="error">{error}</Notice>

  const Viewer = editorComponent(viewType)
  // Still loading. An empty pane rather than a spinner: the chunk arrives in a frame or two and a
  // flash of "Loading…" reads as a stall that is not happening.
  if (!Viewer) return <div style={{ height: '100%', width: '100%' }} />

  return <Viewer filePath={tab.filePath} tabId={tab.id} readOnly={tab.readOnly} />
}

/** A tab a plugin owns outright — a diff, a browser page. */
export function PluginTabPane({ tab }: { tab: CustomTab }): React.ReactElement {
  const error = useActivation(tab.viewType)
  useBindings()

  const workspaceId = useApp((s) => s.activeWorkspaceId)
  const updateTab = useApp((s) => s.updateTab)

  const patchState = useCallback(
    (patch: Record<string, unknown>) => {
      if (!workspaceId) return
      // Read the tab back out of the store rather than closing over `tab.state`: two patches in
      // one turn would otherwise both merge into the state as it was before either. Searched
      // across every group, because a tab id is unique in the workspace but its column is not
      // something this component tracks.
      const current = allTabs(rowOf(useApp.getState(), workspaceId)).find((t) => t.id === tab.id)
      if (!current || current.kind !== 'custom') return
      updateTab(workspaceId, tab.id, { state: { ...current.state, ...patch } })
    },
    [tab.id, updateTab, workspaceId]
  )

  const setTitle = useCallback(
    (title: string, tooltip?: string) => {
      if (!workspaceId) return
      updateTab(workspaceId, tab.id, tooltip === undefined ? { title } : { title, tooltip })
    },
    [tab.id, updateTab, workspaceId]
  )

  if (!ownerOf(tab.viewType)) {
    return <Notice>No plugin provides <code>{tab.viewType}</code> any more.</Notice>
  }
  if (error) return <Notice tone="error">{error}</Notice>

  const Body = tabComponent(tab.viewType)
  if (!Body) return <div style={{ height: '100%', width: '100%' }} />

  return <Body tabId={tab.id} state={tab.state} patchState={patchState} setTitle={setTitle} />
}

/**
 * The panels in one side bar.
 *
 * The two slots are arranged differently on purpose. The left is an activity bar: many views, one
 * showing, chosen by the rail and remembered in the layout. The right stacks everything
 * contributed to it, which today is source control alone and is why the changes stay visible
 * beside the file tree instead of taking its place.
 *
 * Mounting a view activates the plugin that claimed it, so the panel on screen at boot — and only
 * that one — loads shortly after first paint.
 */
export function PluginViewSlot({
  slot,
  onCollapse
}: {
  slot: 'left' | 'right'
  onCollapse: () => void
}): React.ReactElement | null {
  const contributions = viewsIn(slot)
  const remembered = useApp((s) => s.layout.leftView)
  useBindings()

  if (contributions.length === 0) return null

  if (slot === 'left') {
    const selected = selectedLeftView(contributions.map((c) => c.id), remembered)
    const view = contributions.find((c) => c.id === selected)
    if (!view) return null
    return <PluginView id={view.id} title={view.title} onCollapse={onCollapse} />
  }

  return (
    <>
      {contributions.map((c) => (
        <PluginView key={c.id} id={c.id} title={c.title} onCollapse={onCollapse} />
      ))}
    </>
  )
}

function PluginView({
  id,
  title,
  onCollapse
}: {
  id: string
  title: string
  onCollapse: () => void
}): React.ReactElement {
  const error = useActivation(id)
  const Body = viewComponent(id)

  // Before the panel arrives, and if it never does, the shell paints the header itself — WITH the
  // collapse button. Without it a plugin that fails to load leaves a 300px error pane that cannot
  // be dismissed by clicking anything: the panel that would have drawn the button is the one that
  // did not load, and only a keyboard shortcut nothing on screen mentions can hide it.
  if (error || !Body) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="section-header">
          <span className="section-header__title">{title}</span>
          <button className="icon-button" title="Collapse panel" onClick={onCollapse}>
            <CollapseRightIcon size={14} />
          </button>
        </div>
        {error && <div className="error-banner">{error}</div>}
      </div>
    )
  }
  return <Body onCollapse={onCollapse} />
}

/**
 * Status bar items, from plugins that are already running.
 *
 * Deliberately passive: unlike a panel or a tab, a status item never activates its plugin. A
 * branch name is not worth loading source control for, and the plugin that owns it is already
 * loaded in every case where there is something to say.
 */
export function PluginStatusItems({ align }: { align: 'left' | 'right' }): React.ReactElement {
  useBindings()
  return (
    <>
      {statusItemsIn(align).map((item) => {
        const Item = statusItemComponent(item.id)
        return Item ? <Item key={item.id} /> : null
      })}
    </>
  )
}

/** Window-level components — dialogs and prompts — belonging to plugins that are running. */
export function PluginOverlays(): React.ReactElement {
  useBindings()
  return (
    <>
      {boundOverlays().map(([id, Overlay]) => (
        <Overlay key={id} />
      ))}
    </>
  )
}

/** The title of a side bar's first panel, for the rail you click to bring it back. */
export function slotLabel(slot: 'left' | 'right', fallback: string): string {
  return viewsIn(slot)[0]?.title ?? fallback
}
